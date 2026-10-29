// The Web Scraper (contract: handoff/web-scraper-contract.md). Reads the trend runs the worker stores;
// a live search and the trend pictures are the only calls that go out to the web from the API, and
// only to the free public sources (and the picture URLs those sources gave). No AI anywhere.

import { createHash } from "node:crypto";
import {
  SUPER_TAGS, GENERAL_TAG, TRENDS_USER_AGENT, TREND_PLATFORMS, TREND_TYPES, TREND_WINDOWS, searchTrendSources, trendTagger, type PaceStore, type TextGet,
} from "@socia/core";
import {
  activeHashtagRules, createTrendDraft, getTrendItem, kvPaceStore, latestTrendRun, listTrendItems, loadRuleComposer, previousSourceHealth, requestTrendRefresh, saveTrendRun,
  type Actor, type TrendItem,
} from "@socia/db";
import { getText, politeGet, type WebGet } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { HttpError, guard, requireAct, requireRole, type SessionUser } from "../auth";
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
});

const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

/** The frontend's ScraperItem, plus district, publisher and the picture (through this API) */
export function trendView(t: TrendItem) {
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
  };
}

/** PNG, JPEG or WebP from the first bytes; anything else is not served */
export function sniffImage(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const trendRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, storage, web, pace }) => {
  const get: WebGet = web ?? politeGet(process.env.TRENDS_USER_AGENT ?? TRENDS_USER_AGENT);
  const text: TextGet = (url) => getText(get, url, { timeoutMs: url.includes("gdeltproject.org") ? 30_000 : 15_000, maxBytes: 5 * 1024 * 1024 });
  // Shared with the worker through the kv table: one IP, one GDELT allowance
  const paceStore: PaceStore = pace ?? kvPaceStore(db);
  const gdelt = process.env.TRENDS_GDELT !== "false";
  const searches = new SlidingLimiter(SEARCHES_PER_MINUTE, 60_000);
  const refreshes = new SlidingLimiter(REFRESHES_PER_MINUTE, 60_000);
  const failedImages = new Map<string, number>();
  const inFlight = new Map<string, Promise<{ body: Buffer; type: string } | null>>();

  app.get("/trends", { schema: { querystring: ListQuery } }, async (req) => {
    const { user } = guard(req);
    const run = await latestTrendRun(db, user.orgId);
    if (!run) return { items: [], fetchedAt: null, sources: [], alerts: [] };
    const items = await listTrendItems(db, run.id, {
      type: req.query.type ?? "topics", window: req.query.window ?? "24h", q: req.query.q, platform: req.query.platform, superTag: req.query.superTag,
    });
    return { items: items.map(trendView), fetchedAt: run.finishedAt?.toISOString() ?? null, sources: run.sources, alerts: run.alerts };
  });

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
    return { items: items.map(trendView), sources: health };
  });

  app.post("/trends/refresh", async (req, reply) => {
    const { user } = guard(req);
    requireRole(user, "editor", "admin");
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
      requireAct(user, req.body.platform);
      const item = await getTrendItem(db, user.orgId, req.params.id);
      if (!item) throw new HttpError(404, "not_found", "This trend is gone (runs are kept for 7 days). Refresh the list.");
      const { composer } = await loadRuleComposer(db, user.orgId);
      const { draftId, created } = await createTrendDraft(db, actor(user), item, composer);
      return { draftId, created };
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
