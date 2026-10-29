// Web Scraper storage: each run of the free sources and its ranked items, the desk's "refresh now"
// request, the og:image cache, keyword watches, and turning a trend into a Socia story + X draft.

import { createHash } from "node:crypto";
import { detectLang, rewriteChecked, type Composer, type PaceState, type PaceStore, type RewriteInput, type Rewriter, type SourceHealth, type TrendAlert, type TrendRow } from "@socia/core";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Db } from "./client";
import type { Actor } from "./desk";
import { getKv, setKv } from "./kv";
import { postDrafts, stories, trendItems, trendRuns, trendWatches, type DraftRewrite, type TREND_RUN_TRIGGERS, type TrendSourceHealth } from "./schema";

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
        clusterId: r.clusterId, clusterRank: r.clusterRank, sources: r.sources,
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
  /** English district name, as items carry it ("Sawai Madhopur"); matched without regard to case */
  district?: string;
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
        f.district ? sql`lower(${trendItems.district}) = lower(${f.district})` : undefined,
        q ? or(ilike(trendItems.title, `%${likeEscape(q)}%`), ilike(trendItems.reasonWhy, `%${likeEscape(q)}%`), ilike(trendItems.subTag, `%${likeEscape(q)}%`)) : undefined,
      ),
    )
    .orderBy(trendItems.rank);
}

/** Article stories per district in the run's 24 h list (each story once, however many publishers have it) */
export async function trendDistrictCounts(db: Db, runId: string): Promise<{ name: string; count: number }[]> {
  const story = sql`coalesce(${trendItems.clusterId}, ${trendItems.id}::text)`;
  const rows = await db
    .select({ name: trendItems.district, count: sql<number>`count(distinct ${story})::int` })
    .from(trendItems)
    .where(and(eq(trendItems.runId, runId), eq(trendItems.type, "articles"), eq(trendItems.window, "24h"), isNotNull(trendItems.district)))
    .groupBy(trendItems.district);
  return rows
    .map((r) => ({ name: r.name!, count: Number(r.count) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

/** Other publishers of the same story in the item's run: at most 2, one each, those with a summary first */
export async function clusterSiblings(db: Db, item: TrendItem, max = 2): Promise<TrendItem[]> {
  if (!item.clusterId) return [];
  const rows = await db
    .select()
    .from(trendItems)
    .where(and(eq(trendItems.runId, item.runId), eq(trendItems.clusterId, item.clusterId), ne(trendItems.id, item.id)))
    .orderBy(asc(trendItems.rank));
  const seen = new Set([item.sourceName.toLowerCase()]);
  const urls = new Set([item.url]);
  const out: TrendItem[] = [];
  for (const r of [...rows].sort((a, b) => Number(!!b.summary) - Number(!!a.summary))) {
    if (out.length >= max || seen.has(r.sourceName.toLowerCase()) || urls.has(r.url)) continue;
    seen.add(r.sourceName.toLowerCase());
    urls.add(r.url);
    out.push(r);
  }
  return out;
}

/** What the rewriter reads: the item's headline and summary, then each sibling's headline and summary */
export function rewriteInput(item: TrendItem, siblings: TrendItem[]): RewriteInput {
  const headline = item.headline || item.title;
  const summaries = [
    { source: item.sourceName, text: item.summary },
    ...siblings.map((s) => ({ source: s.sourceName, text: [s.headline || s.title, s.summary].filter(Boolean).join("\n") })),
  ];
  return { headline, summaries, district: item.district, lang: detectLang(`${headline} ${item.summary}`) };
}

/**
 * Story (source "trend", no media: the publisher's photo is preview only and never attached) plus an X
 * draft. The headline and body are reworded from the item and up to 2 other publishers of the same story
 * (rules, no AI), checked for copying, then laid out by the normal composer (#District line, "....", tags,
 * X's 280). The publishers' own text stays in the story's sourceText. The draft waits for its automatic
 * card like any other. Drafting the same news item again returns the existing draft.
 */
export async function createTrendDraft(
  db: Db, actor: Actor, item: TrendItem, composer: Composer, rewriter: Rewriter, now = new Date(),
): Promise<{ draftId: string; created: boolean; rewrite: DraftRewrite | null; rewriteError?: string }> {
  const externalId = trendExternalId(item);
  const existingDraft = async (q: Pick<Db, "select">) => {
    const [row] = await q
      .select({ draftId: postDrafts.id, rewrite: postDrafts.rewrite })
      .from(stories)
      .innerJoin(postDrafts, eq(postDrafts.storyId, stories.id))
      .where(and(eq(stories.orgId, actor.orgId), eq(stories.source, "trend"), eq(stories.externalId, externalId)));
    return row ? { draftId: row.draftId, created: false, rewrite: row.rewrite ?? null } : null;
  };
  const before = await existingDraft(db);
  if (before) return before;

  const siblings = await clusterSiblings(db, item);
  const input = rewriteInput(item, siblings);
  // Draft time + item: drafting the item another time words it differently; one seed always the same
  const urlOf = new Map([item, ...siblings].map((t) => [t.sourceName, t.url] as const));
  let headline: string;
  let body: string;
  let rewrite: DraftRewrite;
  let attempts = 0;
  let rewriteError: string | undefined;
  try {
    const reworded = await rewriteChecked(rewriter, input, `${now.toISOString()}|${item.id}`);
    // An empty result is a failed rewording (a body only counts when the publisher gave one)
    if (!reworded.headline.trim()) throw new Error("the reworded headline is empty");
    if (!reworded.body.trim() && item.summary.trim()) throw new Error("the reworded body is empty");
    headline = reworded.headline;
    body = reworded.body;
    attempts = reworded.attempts;
    rewrite = {
      mode: rewriter.name,
      similarity: reworded.similarity,
      tooClose: reworded.tooClose,
      sources: reworded.usedSources.filter((n) => urlOf.has(n)).map((name) => ({ name, url: urlOf.get(name)! })),
    };
  } catch (err) {
    // Drafting never fails on the rewording: the publisher's text, flagged so the desk rewords it by hand
    rewriteError = err instanceof Error ? err.message : String(err);
    headline = input.headline;
    body = item.summary;
    rewrite = { mode: rewriter.name, similarity: 1, tooClose: true, sources: [{ name: item.sourceName, url: item.url }] };
  }
  const content = await composer.compose({ headline, body, place: item.district }, "x");
  const sourceText = [item, ...siblings]
    .map((t) => [`${t.sourceName}: ${t.headline || t.title}`, t.summary, t.url].filter(Boolean).join("\n"))
    .join("\n\n");

  return db.transaction(async (tx) => {
    const existing = await existingDraft(tx);
    if (existing) return existing;

    const stamp = now.toISOString().slice(2, 10).replace(/-/g, "");
    const [story] = await tx
      .insert(stories)
      .values({
        orgId: actor.orgId,
        source: "trend",
        externalId,
        district: item.district,
        slug: `${stamp}_TREND_${externalId.slice(6, 14).toUpperCase()}`,
        status: "composed",
        sourceText,
        sourceCharset: "utf-8",
        sourceEncoding: "unicode",
        headline,
        body,
        parseMethod: "trend",
        parseNote: rewriteError
          ? `From the Web Scraper (${item.platform}, ${item.sourceName}): ${item.url}. Rewording failed, so this is the publisher's own text: reword it before posting. Check facts before posting.`
          : `From the Web Scraper (${item.platform}, ${item.sourceName}): ${item.url}. Reworded by rules from ${rewrite.sources.length || 1} ` +
            `publisher(s), similarity ${rewrite.similarity.toFixed(2)}${rewrite.tooClose ? " (too close to the source: reword it before posting)" : ""}. Check facts before posting.`,
        mediaState: "none",
      })
      .onConflictDoNothing()
      .returning();
    if (!story) {
      // Another desk drafted it a moment ago
      const again = await existingDraft(tx);
      if (again) return again;
      throw new Error("The trend story exists without a draft");
    }
    const [draft] = await tx
      .insert(postDrafts)
      .values({
        orgId: actor.orgId, storyId: story.id, platform: "x", status: "rendering", bodyText: content.bodyText, cardHeadline: headline,
        hashtags: content.hashtags, mentionSuggestions: content.mentionSuggestions, composeMethod: content.composeMethod, composeVersion: content.composeVersion,
        rewrite,
      })
      .returning({ id: postDrafts.id });
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "trend.drafted", entityType: "post_draft", entityId: draft!.id,
      after: {
        trendItemId: item.id, url: item.url, platform: item.platform, sourceName: item.sourceName, storyId: story.id,
        rewrite: { mode: rewrite.mode, similarity: rewrite.similarity, tooClose: rewrite.tooClose, sources: rewrite.sources.map((s) => s.name), attempts, failed: rewriteError ?? null },
      },
    });
    return { draftId: draft!.id, created: true, rewrite, rewriteError };
  });
}

// ─── Keyword watches ─────────────────────────────────────────────────────────

export type TrendWatch = typeof trendWatches.$inferSelect;

/** Per user */
export const TREND_WATCH_MAX = 50;

export async function listTrendWatches(db: Db, userId: string): Promise<TrendWatch[]> {
  return db.select().from(trendWatches).where(eq(trendWatches.userId, userId)).orderBy(asc(trendWatches.createdAt), asc(trendWatches.keyword));
}

/**
 * Adds a keyword (already trimmed and checked by the caller). The same keyword in any case returns the
 * existing watch with created false; at the limit returns null.
 */
export async function addTrendWatch(db: Db, user: { id: string; orgId: string }, keyword: string): Promise<{ watch: TrendWatch; created: boolean } | null> {
  return db.transaction(async (tx) => {
    // One user's adds in turn, so two quick adds cannot pass the limit together
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`trend_watches:${user.id}`}))`);
    const [same] = await tx.select().from(trendWatches).where(and(eq(trendWatches.userId, user.id), sql`lower(${trendWatches.keyword}) = lower(${keyword})`));
    if (same) return { watch: same, created: false };
    const [n] = await tx.select({ n: count() }).from(trendWatches).where(eq(trendWatches.userId, user.id));
    if (Number(n?.n ?? 0) >= TREND_WATCH_MAX) return null;
    const [watch] = await tx.insert(trendWatches).values({ orgId: user.orgId, userId: user.id, keyword }).returning();
    return { watch: watch!, created: true };
  });
}

/** True when the user had that watch */
export async function deleteTrendWatch(db: Db, userId: string, id: string): Promise<boolean> {
  const gone = await db.delete(trendWatches).where(and(eq(trendWatches.userId, userId), eq(trendWatches.id, id))).returning({ id: trendWatches.id });
  return gone.length > 0;
}

/** Every keyword watched by anyone in the org (the worker keeps matching stories past the pool size) */
export async function orgWatchKeywords(db: Db, orgId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ keyword: trendWatches.keyword }).from(trendWatches).where(eq(trendWatches.orgId, orgId));
  return rows.map((r) => r.keyword);
}
