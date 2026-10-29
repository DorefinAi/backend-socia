// The Web Scraper (contracts: handoff/web-scraper-contract.md, handoff/scraper-analytics-contract.md §A).
// Reads the trend runs the worker stores; stories told by several publishers come back as one row with
// their sources, items carry a district, and each user's watched keywords mark (and can filter) items.
// a live search and the trend pictures are the only calls that go out to the web from the API, and
// only to the free public sources (and the picture URLs those sources gave). No AI anywhere.

import { createHash } from "node:crypto";
import {
  SUPER_TAGS, GENERAL_TAG, TRENDS_USER_AGENT, TREND_PLATFORMS, TREND_TOP, TREND_TYPES, TREND_WINDOWS, createRewriter, searchTrendSources, trendTagger, watchHits, watchKey,
  type PaceStore, type TextGet,
} from "@socia/core";
import {
  TREND_WATCH_MAX, activeHashtagRules, addTrendWatch, createTrendDraft, deleteTrendWatch, getTrendItem, kvPaceStore, latestTrendRun, listTrendItems, listTrendWatches,
  loadRuleComposer, previousSourceHealth, requestTrendRefresh, saveTrendRun, trendDistrictCounts,
  type Actor, type TrendItem, type TrendWatch,
} from "@socia/db";
import { getText, politeGet, type WebGet } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { HttpError, guard, requirePermission, type SessionUser } from "../auth";
import type { AppDeps } from "../app";
import { SlidingLimiter } from "../limiter";

const actor = (u: SessionUser): Actor => ({ id: u.id, orgId: u.orgId, name: u.name, role: u.role });

export const SEARCHES_PER_MINUTE = 10;
export const REFRESHES_PER_MINUTE = 3;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;
/** A picture that failed is not asked for again for this long */
const IMAGE_RETRY_MS = 3600_000;
/** Platforms the draft endpoint knows; only X exists in Socia today */
const DRAFT_PLATFORMS = ["x"];

const literals = <T extends string>(list: readonly T[]) => Type.Union(list.map((v) => Type.Literal(v)));

const ListQuery = Type.Object({
  type: Type.Optional(literals(TREND_TYPES)),
  window: Type.Optional(literals(Object.keys(TREND_WINDOWS) as (keyof typeof TREND_WINDOWS)[])),
  q: Type.Optional(Type.String({ maxLength: 100 })),
  platform: Type.Optional(literals(TREND_PLATFORMS)),
  superTag: Type.Optional(literals([...SUPER_TAGS, GENERAL_TAG])),
  /** English district name ("Sawai Madhopur"), case-insensitive */
  district: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  /** 1: only items matching the user's watched keywords */
  watched: Type.Optional(literals(["0", "1"])),
  /** 0: every item (each publisher's article); default 1: one row per story */
  group: Type.Optional(literals(["0", "1"])),
});

const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

/** The frontend's ScraperItem, plus district, publisher, the picture (through this API), the story and watch hits */
export function trendView(t: TrendItem, extra: { watchHits?: string[]; sources?: TrendItem["sources"] } = {}) {
  const sources = extra.sources ?? t.sources ?? [];
  return {
    id: t.id,
    rank: t.rank,
    title: t.title,
    type: t.type,
    platform: t.platform,
    url: t.url,
    engagementStats: { viewsOrVolume: t.volume, growthRate: t.growth, sharesOrPosts: t.shares },
    reasonWhy: t.reasonWhy,
    superTag: t.superTag,
    subTag: t.subTag,
    timeFrame: t.window,
    scrapedAt: t.fetchedAt.toISOString(),
    publishedAt: t.publishedAt?.toISOString() ?? null,
    district: t.district,
    sourceName: t.sourceName,
    imageUrl: t.imageUrl ? `/trends/${t.id}/image` : null,
    imageSource: t.imageUrl ? t.imageSource : null,
    alert: t.alert ?? null,
    /** Items about the same story share it (rows stored before the story grouping: the item's own id) */
    clusterId: t.clusterId ?? t.id,
    /** Publishers / channels with the story (at least 1: this item's own) */
    sourceCount: Math.max(1, sources.length),
    sources: sources.length ? sources : [{ name: t.sourceName, url: t.url, publishedAt: t.publishedAt?.toISOString() ?? null }],
    /** The user's watched keywords found in the title or summary */
    watchHits: extra.watchHits ?? [],
  };
}

/** The text a watched keyword is looked for in */
const watchText = (t: TrendItem) => `${t.title} ${t.summary}`;

export interface StoryRow {
  item: TrendItem;
  watchHits: string[];
  rank: number;
}

/**
 * Rows in rank order, one per story when grouped (its best-ranked item; watch hits of every member),
 * numbered 1..n. Without a narrowing filter only the top 20 stories are shown (the rest of the pool is
 * there for the district filter, search and watches).
 */
export function storyRows(items: TrendItem[], keywords: string[], opts: { group: boolean; top: boolean; watchedOnly: boolean }): StoryRow[] {
  const sorted = [...items].sort((a, b) => a.rank - b.rank);
  const story = (t: TrendItem) => t.clusterId ?? t.id;
  const storyRank = (t: TrendItem) => t.clusterRank ?? t.rank;
  const hits = new Map<string, string[]>();
  for (const t of sorted) {
    const found = watchHits(keywords, watchText(t));
    if (found.length) hits.set(story(t), [...new Set([...(hits.get(story(t)) ?? []), ...found])]);
  }
  let rows = sorted.filter((t) => !opts.top || storyRank(t) <= TREND_TOP);
  if (opts.group) {
    const seen = new Set<string>();
    rows = rows.filter((t) => !seen.has(story(t)) && !!seen.add(story(t)));
  }
  const out = rows.map((item) => ({ item, watchHits: opts.group ? hits.get(story(item)) ?? [] : watchHits(keywords, watchText(item)), rank: item.rank }));
  return (opts.watchedOnly ? out.filter((r) => r.watchHits.length) : out).map((r, i) => ({ ...r, rank: opts.group ? i + 1 : r.rank }));
}

const viewRow = (r: StoryRow) => ({ ...trendView(r.item, { watchHits: r.watchHits }), rank: r.rank });

const watchView = (w: TrendWatch) => ({ id: w.id, keyword: w.keyword, createdAt: w.createdAt.toISOString() });

/** Hits newer than this are "new" when the desk does not say since when */
const HITS_DEFAULT_MS = 24 * 3600_000;
const HITS_MAX_ITEMS = 50;

/** PNG, JPEG or WebP from the first bytes; anything else is not served */
export function sniffImage(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const trendRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, storage, web, pace, config }) => {
  const get: WebGet = web ?? politeGet(process.env.TRENDS_USER_AGENT ?? TRENDS_USER_AGENT);
  const text: TextGet = (url) => getText(get, url, { timeoutMs: url.includes("gdeltproject.org") ? 30_000 : 15_000, maxBytes: 5 * 1024 * 1024 });
  // Shared with the worker through the kv table: one IP, one GDELT allowance
  const paceStore: PaceStore = pace ?? kvPaceStore(db);
  const gdelt = process.env.TRENDS_GDELT !== "false";
  const searches = new SlidingLimiter(SEARCHES_PER_MINUTE, 60_000);
  const refreshes = new SlidingLimiter(REFRESHES_PER_MINUTE, 60_000);
  app.addHook("onClose", async () => {
    searches.close();
    refreshes.close();
  });
  const failedImages = new Map<string, number>();
  // REWRITE_MODE (rules only for now): drafts from a trend are reworded, never the publisher's words
  const rewriter = createRewriter(config.rewriteMode);
  const inFlight = new Map<string, Promise<{ body: Buffer; type: string } | null>>();

  const keywordsOf = async (userId: string) => (await listTrendWatches(db, userId)).map((w) => w.keyword);

  app.get("/trends", { schema: { querystring: ListQuery } }, async (req) => {
    const { user } = guard(req);
    const run = await latestTrendRun(db, user.orgId);
    if (!run) return { items: [], fetchedAt: null, sources: [], alerts: [] };
    const district = req.query.district?.trim() || undefined;
    const q = req.query.q?.trim() || undefined;
    const watchedOnly = req.query.watched === "1";
    const items = await listTrendItems(db, run.id, {
      type: req.query.type ?? "topics", window: req.query.window ?? "24h", q, platform: req.query.platform, superTag: req.query.superTag, district,
    });
    const rows = storyRows(items, await keywordsOf(user.id), { group: req.query.group !== "0", top: !district && !q && !watchedOnly, watchedOnly });
    return { items: rows.map(viewRow), fetchedAt: run.finishedAt?.toISOString() ?? null, sources: run.sources, alerts: run.alerts };
  });

  /** Article stories per district in the newest run's 24 h list, most first */
  app.get("/trends/districts", async (req) => {
    const { user } = guard(req);
    const run = await latestTrendRun(db, user.orgId);
    return { districts: run ? await trendDistrictCounts(db, run.id) : [], fetchedAt: run?.finishedAt?.toISOString() ?? null };
  });

  // ─── Keyword watches (per user) ─────────────────────────────────────────────

  app.get("/me/trend-watches", async (req) => {
    const { user } = guard(req);
    return { watches: (await listTrendWatches(db, user.id)).map(watchView), max: TREND_WATCH_MAX };
  });

  app.post(
    "/me/trend-watches",
    { schema: { body: Type.Object({ keyword: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }) } },
    async (req, reply) => {
      const { user } = guard(req);
      requirePermission(user, "trends.watch");
      const keyword = req.body.keyword.replace(/\s+/g, " ").trim();
      if (!keyword || !watchKey(keyword)) throw new HttpError(400, "invalid", "Type a word or name to watch (letters or digits).");
      const added = await addTrendWatch(db, user, keyword);
      if (!added) throw new HttpError(409, "watch_limit", `Up to ${TREND_WATCH_MAX} keywords each. Remove one to add another.`);
      return reply.status(added.created ? 201 : 200).send({ watch: watchView(added.watch), created: added.created });
    },
  );

  app.delete("/me/trend-watches/:id", { schema: { params: Id } }, async (req, reply) => {
    const { user } = guard(req);
    requirePermission(user, "trends.watch");
    if (!(await deleteTrendWatch(db, user.id, req.params.id))) throw new HttpError(404, "not_found", "That keyword is not on your watch list.");
    return reply.status(204).send();
  });

  /** Stories of the newest run (articles, 7 d pool) matching the user's keywords, published after `since` */
  app.get(
    "/me/trend-watches/hits",
    { schema: { querystring: Type.Object({ since: Type.Optional(Type.String({ format: "date-time" })) }) } },
    async (req) => {
      const { user } = guard(req);
      const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - HITS_DEFAULT_MS);
      const keywords = await keywordsOf(user.id);
      const run = await latestTrendRun(db, user.orgId);
      if (!run || !keywords.length) return { count: 0, items: [], since: since.toISOString(), fetchedAt: run?.finishedAt?.toISOString() ?? null };
      const items = await listTrendItems(db, run.id, { type: "articles", window: "7d" });
      // Undated items (some government feeds) never count as new
      const rows = storyRows(items, keywords, { group: true, top: false, watchedOnly: true }).filter((r) => r.item.publishedAt && r.item.publishedAt > since);
      return {
        count: rows.length,
        items: rows.slice(0, HITS_MAX_ITEMS).map((r, i) => viewRow({ ...r, rank: i + 1 })),
        since: since.toISOString(),
        fetchedAt: run.finishedAt?.toISOString() ?? null,
      };
    },
  );

  app.post("/trends/search", { schema: { body: Type.Object({ q: Type.String({ minLength: 2, maxLength: 100 }) }, { additionalProperties: false }) } }, async (req) => {
    const { user } = guard(req);
    const q = req.body.q.replace(/\s+/g, " ").trim();
    if (q.length < 2) throw new HttpError(400, "invalid", "Type at least 2 characters to search.");
    if (!searches.take(user.id)) throw new HttpError(429, "rate_limited", `Up to ${SEARCHES_PER_MINUTE} searches a minute. Wait a moment and try again.`);
    const startedAt = new Date();
    const tagger = trendTagger(await activeHashtagRules(db, user.orgId));
    const { rows, health } = await searchTrendSources(text, q, tagger, startedAt, paceStore, await previousSourceHealth(db, user.orgId), gdelt);
    // Stored like a run (kept apart from the desk's list), so a result can be drafted and its picture shown
    const { items } = await saveTrendRun(db, user.orgId, { trigger: "search", query: q, startedAt, sources: health }, rows);
    const found = storyRows(items, await keywordsOf(user.id), { group: false, top: false, watchedOnly: false });
    return { items: found.map(viewRow), sources: health };
  });

  app.post("/trends/refresh", async (req, reply) => {
    const { user } = guard(req);
    requirePermission(user, "trends.refresh");
    if (!refreshes.take(user.id)) throw new HttpError(429, "rate_limited", `Up to ${REFRESHES_PER_MINUTE} refreshes a minute. The worker is already on it.`);
    await requestTrendRefresh(db, user.orgId, user.id);
    return reply.status(202).send({ queued: true });
  });

  app.post(
    "/trends/:id/draft",
    { schema: { params: Id, body: Type.Object({ platform: Type.String({ minLength: 1, maxLength: 30 }) }, { additionalProperties: false }) } },
    async (req) => {
      const { user } = guard(req);
      if (!DRAFT_PLATFORMS.includes(req.body.platform)) {
        throw new HttpError(400, "platform_not_supported", `Socia makes drafts for X only; "${req.body.platform}" is filled in on the desk.`);
      }
      requirePermission(user, "trends.draft", req.body.platform);
      const item = await getTrendItem(db, user.orgId, req.params.id);
      if (!item) throw new HttpError(404, "not_found", "This trend is gone (runs are kept for 7 days). Refresh the list.");
      const { composer } = await loadRuleComposer(db, user.orgId);
      const { draftId, created, rewrite, rewriteError } = await createTrendDraft(db, actor(user), item, composer, rewriter);
      // The draft still exists (publisher's text, tooClose); the reason is for the logs only
      if (rewriteError) req.log.warn({ trendItemId: item.id, draftId, rewriteError }, "trend draft: rewording failed, kept the source text");
      return { draftId, created, rewrite };
    },
  );

  async function fetchImage(url: string): Promise<{ body: Buffer; type: string } | null> {
    const key = `trend-images/${createHash("sha256").update(url).digest("hex")}`;
    const stored = await storage.get(key).catch(() => null);
    const storedType = stored ? sniffImage(stored) : null;
    if (stored && storedType) return { body: stored, type: storedType };
    const failedAt = failedImages.get(url);
    if (failedAt && Date.now() - failedAt < IMAGE_RETRY_MS) return null;
    try {
      const res = await get(url, { timeoutMs: 10_000, maxBytes: IMAGE_MAX_BYTES, accept: "image/webp,image/jpeg,image/png" });
      const type = res.status === 200 ? sniffImage(res.body) : null;
      if (!type) throw new Error(`not a picture (HTTP ${res.status})`);
      await storage.put(key, res.body, type);
      return { body: res.body, type };
    } catch {
      failedImages.set(url, Date.now());
      return null;
    }
  }

  // The publisher's picture, through this API: same origin for the desk, fetched once, never hotlinked.
  // Preview only: drafts never attach it.
  app.get("/trends/:id/image", { schema: { params: Id } }, async (req, reply) => {
    const { user } = guard(req);
    const item = await getTrendItem(db, user.orgId, req.params.id);
    if (!item?.imageUrl) throw new HttpError(404, "not_found", "No picture for this trend.");
    const url = item.imageUrl;
    let pending = inFlight.get(url);
    if (!pending) {
      pending = fetchImage(url).finally(() => inFlight.delete(url));
      inFlight.set(url, pending);
    }
    const image = await pending;
    if (!image) throw new HttpError(404, "not_found", "The publisher's picture could not be loaded.");
    reply.header("cache-control", "private, max-age=86400");
    reply.type(image.type);
    return reply.send(image.body);
  });
};
