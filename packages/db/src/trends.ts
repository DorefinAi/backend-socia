// Web Scraper storage: each run of the free sources and its ranked items, the desk's "refresh now"
// request, the og:image cache, and turning a trend into a Socia story + X draft.

import { createHash } from "node:crypto";
import type { Composer, PaceState, PaceStore, SourceHealth, TrendAlert, TrendRow } from "@socia/core";
import { and, desc, eq, ilike, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Db } from "./client";
import type { Actor } from "./desk";
import { getKv, setKv } from "./kv";
import { postDrafts, stories, trendItems, trendRuns, type TREND_RUN_TRIGGERS, type TrendSourceHealth } from "./schema";

export type TrendItem = typeof trendItems.$inferSelect;
export type TrendRun = typeof trendRuns.$inferSelect;
export type TrendTrigger = (typeof TREND_RUN_TRIGGERS)[number];

/** Runs and their items are kept this long */
export const TREND_KEEP_DAYS = 7;

export async function saveTrendRun(
  db: Db, orgId: string, run: { trigger: TrendTrigger; query?: string | null; startedAt: Date; sources: TrendSourceHealth[]; alerts?: TrendAlert[] }, rows: TrendRow[],
): Promise<{ run: TrendRun; items: TrendItem[] }> {
  return db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(trendRuns)
      .values({ orgId, trigger: run.trigger, query: run.query ?? null, sources: run.sources, alerts: run.alerts ?? [], itemCount: rows.length, startedAt: run.startedAt, finishedAt: sql`now()` })
      .returning();
    const items: TrendItem[] = [];
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200).map((r) => ({
        orgId, runId: saved!.id, type: r.type, window: r.window, rank: r.rank, title: r.title.slice(0, 500), url: r.url, platform: r.platform,
        sourceName: r.sourceName.slice(0, 200), reasonWhy: r.reasonWhy.slice(0, 1000), superTag: r.superTag, subTag: r.subTag.slice(0, 300), district: r.district,
        volume: r.volume, growth: r.growth, shares: r.shares, headline: r.headline.slice(0, 500), summary: r.summary.slice(0, 1500), publishedAt: r.publishedAt,
        imageUrl: r.imageUrl, imageSource: r.imageSource, ogChecked: !!r.imageUrl, alert: r.alert,
      }));
      if (batch.length) items.push(...(await tx.insert(trendItems).values(batch).returning()));
    }
    return { run: saved!, items };
  });
}

/** The newest finished run the desk shows (searches are kept apart) */
export async function latestTrendRun(db: Db, orgId: string): Promise<TrendRun | null> {
  const [run] = await db
    .select()
    .from(trendRuns)
    .where(and(eq(trendRuns.orgId, orgId), ne(trendRuns.trigger, "search"), isNotNull(trendRuns.finishedAt)))
    .orderBy(desc(trendRuns.finishedAt))
    .limit(1);
  return run ?? null;
}

export interface TrendFilter {
  type: string;
  window: string;
  q?: string;
  platform?: string;
  superTag?: string;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listTrendItems(db: Db, runId: string, f: TrendFilter): Promise<TrendItem[]> {
  const q = f.q?.trim();
  return db
    .select()
    .from(trendItems)
    .where(
      and(
        eq(trendItems.runId, runId),
        eq(trendItems.type, f.type),
        eq(trendItems.window, f.window),
        f.platform ? eq(trendItems.platform, f.platform) : undefined,
        f.superTag ? eq(trendItems.superTag, f.superTag) : undefined,
        q ? or(ilike(trendItems.title, `%${likeEscape(q)}%`), ilike(trendItems.reasonWhy, `%${likeEscape(q)}%`), ilike(trendItems.subTag, `%${likeEscape(q)}%`)) : undefined,
      ),
    )
    .orderBy(trendItems.rank);
}

export async function getTrendItem(db: Db, orgId: string, id: string): Promise<TrendItem | null> {
  const [row] = await db.select().from(trendItems).where(and(eq(trendItems.orgId, orgId), eq(trendItems.id, id)));
  return row ?? null;
}

/** og:image lookups already made for these article URLs (any earlier run): never read a page twice */
export async function knownPageImages(db: Db, urls: string[]): Promise<Map<string, { imageUrl: string | null; imageSource: string | null }>> {
  const out = new Map<string, { imageUrl: string | null; imageSource: string | null }>();
  if (!urls.length) return out;
  const rows = await db
    .select({ url: trendItems.url, imageUrl: trendItems.imageUrl, imageSource: trendItems.imageSource })
    .from(trendItems)
    .where(and(inArray(trendItems.url, urls), eq(trendItems.ogChecked, true)))
    .orderBy(desc(trendItems.fetchedAt));
  for (const r of rows) if (!out.has(r.url) || (!out.get(r.url)!.imageUrl && r.imageUrl)) out.set(r.url, { imageUrl: r.imageUrl, imageSource: r.imageSource });
  return out;
}

/** Record an og:image result on every item of the run with that URL */
export async function setPageImage(db: Db, runId: string, url: string, imageUrl: string | null, imageSource: string | null): Promise<void> {
  await db.update(trendItems).set({ imageUrl, imageSource, ogChecked: true }).where(and(eq(trendItems.runId, runId), eq(trendItems.url, url)));
}

export async function pruneTrends(db: Db, orgId: string, days = TREND_KEEP_DAYS): Promise<number> {
  const gone = await db
    .delete(trendRuns)
    .where(and(eq(trendRuns.orgId, orgId), lt(trendRuns.startedAt, sql`now() - make_interval(days => ${days})`)))
    .returning({ id: trendRuns.id });
  return gone.length;
}

/** The newest run's source health, so a new run can carry lastSuccessAt over */
export async function previousSourceHealth(db: Db, orgId: string): Promise<SourceHealth[]> {
  const run = await latestTrendRun(db, orgId);
  return (run?.sources ?? []).map((s) => ({
    ...s, group: s.group ?? "News", itemsLastRun: s.itemsLastRun ?? s.items, lastSuccessAt: s.lastSuccessAt ?? (s.ok ? s.at : null),
  })) as SourceHealth[];
}

/**
 * Pacing state per source (GDELT, Reddit, Wikipedia) in the kv table, shared by the worker and the API:
 * one IP, one allowance. Not a lock: two processes could still race inside one slot, which the sources
 * forgive now and then.
 */
export function kvPaceStore(db: Db): PaceStore {
  const k = (key: string) => `trends.pace.${key}`;
  return {
    load: async (key) => (await getKv<PaceState>(db, k(key))) ?? { lastAt: 0, backoffUntil: 0, failures: 0 },
    save: (key, state) => setKv(db, k(key), state),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

// ─── "Fetch now" from the desk ───────────────────────────────────────────────

const refreshKey = (orgId: string) => `trends.refresh.${orgId}`;

export async function requestTrendRefresh(db: Db, orgId: string, userId: string): Promise<void> {
  await setKv(db, refreshKey(orgId), { at: new Date().toISOString(), by: userId });
}

/** When the desk last asked for a run, or null */
export async function trendRefreshRequestedAt(db: Db, orgId: string): Promise<Date | null> {
  const v = await getKv<{ at: string }>(db, refreshKey(orgId));
  return v?.at ? new Date(v.at) : null;
}

// ─── A trend becomes a story and an X draft ──────────────────────────────────

/** The same news item makes one story, however often it is drafted (any run, any type) */
export const trendExternalId = (item: Pick<TrendItem, "url" | "headline">) =>
  `trend:${createHash("sha256").update(`${item.url}\n${item.headline}`).digest("hex").slice(0, 32)}`;

/**
 * Story (source "trend", no media: the publisher's photo is preview only and never attached) plus an X
 * draft composed by the normal rules. The draft waits for its automatic card like any other. Drafting
 * the same news item again returns the existing draft.
 */
export async function createTrendDraft(db: Db, actor: Actor, item: TrendItem, composer: Composer): Promise<{ draftId: string; created: boolean }> {
  const externalId = trendExternalId(item);
  const headline = item.headline || item.title;
  const body = item.summary;
  const content = await composer.compose({ headline, body, place: item.district }, "x");

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ draftId: postDrafts.id })
      .from(stories)
      .innerJoin(postDrafts, eq(postDrafts.storyId, stories.id))
      .where(and(eq(stories.orgId, actor.orgId), eq(stories.source, "trend"), eq(stories.externalId, externalId)));
    if (existing) return { draftId: existing.draftId, created: false };

    const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, "");
    const [story] = await tx
      .insert(stories)
      .values({
        orgId: actor.orgId,
        source: "trend",
        externalId,
        district: item.district,
        slug: `${stamp}_TREND_${externalId.slice(6, 14).toUpperCase()}`,
        status: "composed",
        sourceText: `${item.title}\n${item.url}`,
        sourceCharset: "utf-8",
        sourceEncoding: "unicode",
        headline,
        body,
        parseMethod: "trend",
        parseNote: `From the Web Scraper (${item.platform}, ${item.sourceName}): ${item.url}. Rewrite in First India's words before posting.`,
        mediaState: "none",
      })
      .onConflictDoNothing()
      .returning();
    if (!story) {
      // Another desk drafted it a moment ago
      const [again] = await tx
        .select({ draftId: postDrafts.id })
        .from(stories)
        .innerJoin(postDrafts, eq(postDrafts.storyId, stories.id))
        .where(and(eq(stories.orgId, actor.orgId), eq(stories.source, "trend"), eq(stories.externalId, externalId)));
      if (again) return { draftId: again.draftId, created: false };
      throw new Error("The trend story exists without a draft");
    }
    const [draft] = await tx
      .insert(postDrafts)
      .values({
        orgId: actor.orgId, storyId: story.id, platform: "x", status: "rendering", bodyText: content.bodyText, cardHeadline: headline,
        hashtags: content.hashtags, mentionSuggestions: content.mentionSuggestions, composeMethod: content.composeMethod, composeVersion: content.composeVersion,
      })
      .returning({ id: postDrafts.id });
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "trend.drafted", entityType: "post_draft", entityId: draft!.id,
      after: { trendItemId: item.id, url: item.url, platform: item.platform, sourceName: item.sourceName, storyId: story.id },
    });
    return { draftId: draft!.id, created: true };
  });
}
