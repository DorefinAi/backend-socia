// Engagement numbers for posted items, per platform (worker role "metrics"). Each provider has two
// modes: "fake" makes deterministic, plausible numbers from the post id (marked { source: "fake" } in
// raw, so the desk shows "Sample data"), and "live" reads the platform's official API with keys from
// the environment. Live code is unit-tested against recorded answers only; tests never call out.
//
// CONFIRM AGAINST LIVE DOCS BEFORE GO-LIVE. Written against, as of Oct 2026:
//   X API v2           GET /2/tweets?ids=…&tweet.fields=public_metrics           (existing XApiClient.metrics)
//   Facebook Graph     GET /{page-post-id}?fields=shares,reactions.summary(total_count).limit(0),
//                      comments.summary(total_count).limit(0),insights.metric(post_media_view,post_video_views)
//                      (post_impressions was deprecated on 15 Nov 2025 in favour of post_media_view, "views")
//   Instagram Graph    GET /{ig-media-id}/insights?metric=views,reach,likes,comments,shares,saved
//                      (impressions replaced by views for media insights)
//   YouTube Data v3    GET /youtube/v3/videos?part=statistics&id=…&key=…        (viewCount, likeCount, commentCount)

import { createHash } from "node:crypto";
import type { XMetrics } from "./x";

export const METRIC_PLATFORMS = ["x", "facebook", "instagram", "youtube"] as const;
export type MetricPlatform = (typeof METRIC_PLATFORMS)[number];
export type MetricsMode = "fake" | "live";

/** Ages at which a post's numbers are captured, each once */
export const AGE_BUCKETS = [
  { bucket: "1h", ms: 3600_000 },
  { bucket: "6h", ms: 6 * 3600_000 },
  { bucket: "24h", ms: 24 * 3600_000 },
  { bucket: "3d", ms: 3 * 86400_000 },
  { bucket: "7d", ms: 7 * 86400_000 },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["bucket"];

export interface MetricPost {
  /** published_posts.id */
  id: string;
  platformPostId: string;
  publishedAt: Date;
  bucket: AgeBucket;
}

export interface MetricSnapshot {
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  videoViews: number | null;
  raw: Record<string, unknown>;
}

export interface MetricsProvider {
  readonly platform: MetricPlatform;
  readonly mode: MetricsMode;
  /** Numbers per post id; a post the platform did not return is left out (captured again next time) */
  fetch(posts: MetricPost[]): Promise<Map<string, MetricSnapshot>>;
}

export class MetricsError extends Error {}

type Http = typeof fetch;

async function getJson<T>(http: Http, url: string, timeoutMs = 20_000): Promise<T> {
  const res = await http(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the URL: it can carry an access token or key
    throw new MetricsError(`HTTP ${res.status}: ${text.replace(/access_token=[^&"\s]+/g, "access_token=…").slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

// ─── Fake ────────────────────────────────────────────────────────────────────

/** Share of the final (7-day) numbers reached by each age */
const GROWTH: Record<AgeBucket, number> = { "1h": 0.18, "6h": 0.5, "24h": 0.82, "3d": 0.95, "7d": 1 };

/** A number 0..1 from the post id and a label, always the same for the same input */
function unit(postId: string, label: string): number {
  return createHash("sha256").update(`${postId}:${label}`).digest().readUInt32BE(0) / 0xffffffff;
}

/** Plausible numbers for a regional news post: reach 800..40k at 7 days, 0.5-4.5% engagement */
export function fakeSnapshot(platform: MetricPlatform, post: Pick<MetricPost, "id" | "bucket">): MetricSnapshot {
  const g = GROWTH[post.bucket];
  const reach = 800 + Math.round(unit(post.id, "reach") ** 2 * 39_200);
  const impressions = Math.round(reach * g);
  const rate = 0.005 + unit(post.id, "rate") * 0.04;
  const engaged = impressions * rate;
  const share = (label: string, lo: number, hi: number) => Math.round(engaged * (lo + unit(post.id, label) * (hi - lo)));
  const video = platform === "youtube" || platform === "instagram" || unit(post.id, "video") < 0.3;
  return {
    impressions,
    likes: share("likes", 0.55, 0.75),
    reposts: platform === "youtube" ? null : share("reposts", 0.08, 0.2),
    replies: share("replies", 0.05, 0.15),
    quotes: platform === "x" ? share("quotes", 0.01, 0.04) : null,
    bookmarks: platform === "x" || platform === "instagram" ? share("bookmarks", 0.02, 0.08) : null,
    videoViews: video ? Math.round(impressions * (0.3 + unit(post.id, "views") * 0.4)) : null,
    raw: { source: "fake", platform, bucket: post.bucket },
  };
}

export class FakeMetricsProvider implements MetricsProvider {
  readonly mode = "fake" as const;
  constructor(readonly platform: MetricPlatform) {}

  async fetch(posts: MetricPost[]): Promise<Map<string, MetricSnapshot>> {
    return new Map(posts.map((p) => [p.id, fakeSnapshot(this.platform, p)]));
  }
}

// ─── X ───────────────────────────────────────────────────────────────────────

/** Through the existing X client (OAuth 1.0a user context gives impression_count): 100 ids per call */
export class XMetricsProvider implements MetricsProvider {
  readonly platform = "x" as const;
  readonly mode = "live" as const;
  constructor(private readonly client: { metrics(ids: string[]): Promise<Record<string, XMetrics>> }) {}

  async fetch(posts: MetricPost[]): Promise<Map<string, MetricSnapshot>> {
    const out = new Map<string, MetricSnapshot>();
    for (let i = 0; i < posts.length; i += 100) {
      const batch = posts.slice(i, i + 100);
      const m = await this.client.metrics([...new Set(batch.map((p) => p.platformPostId))]);
      for (const p of batch) {
        const x = m[p.platformPostId];
        if (!x) continue;
        out.set(p.id, {
          impressions: x.impressions, likes: x.likes, reposts: x.reposts, replies: x.replies, quotes: x.quotes, bookmarks: x.bookmarks, videoViews: null,
          raw: { source: "live", public_metrics: x },
        });
      }
    }
    return out;
  }
}

// ─── Facebook Page posts ─────────────────────────────────────────────────────

interface FbPost {
  shares?: { count?: number };
  reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
  insights?: { data?: { name: string; values?: { value?: number }[] }[] };
}

export const GRAPH_VERSION = "v23.0";

export class FacebookMetricsProvider implements MetricsProvider {
  readonly platform = "facebook" as const;
  readonly mode = "live" as const;
  constructor(private readonly cfg: { pageToken: string; pageId: string; http?: Http; base?: string }) {}

  async fetch(posts: MetricPost[]): Promise<Map<string, MetricSnapshot>> {
    const http = this.cfg.http ?? fetch;
    const base = this.cfg.base ?? `https://graph.facebook.com/${GRAPH_VERSION}`;
    const fields = "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),insights.metric(post_media_view,post_video_views)";
    const out = new Map<string, MetricSnapshot>();
    for (const p of posts) {
      // Page post ids are "<pageId>_<postId>"; a bare post id gets the page prefix
      const id = p.platformPostId.includes("_") ? p.platformPostId : `${this.cfg.pageId}_${p.platformPostId}`;
      const url = `${base}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(this.cfg.pageToken)}`;
      const r = await getJson<FbPost>(http, url);
      const insight = (name: string) => r.insights?.data?.find((d) => d.name === name)?.values?.[0]?.value ?? null;
      out.set(p.id, {
        impressions: insight("post_media_view"), likes: r.reactions?.summary?.total_count ?? 0, reposts: r.shares?.count ?? 0,
        replies: r.comments?.summary?.total_count ?? 0, quotes: null, bookmarks: null, videoViews: insight("post_video_views"),
        raw: { source: "live", ...r },
      });
    }
    return out;
  }
}

// ─── Instagram media ─────────────────────────────────────────────────────────

export class InstagramMetricsProvider implements MetricsProvider {
  readonly platform = "instagram" as const;
  readonly mode = "live" as const;
  constructor(private readonly cfg: { pageToken: string; igUserId: string; http?: Http; base?: string }) {}

  async fetch(posts: MetricPost[]): Promise<Map<string, MetricSnapshot>> {
    const http = this.cfg.http ?? fetch;
    const base = this.cfg.base ?? `https://graph.facebook.com/${GRAPH_VERSION}`;
    const out = new Map<string, MetricSnapshot>();
    for (const p of posts) {
      const url = `${base}/${encodeURIComponent(p.platformPostId)}/insights?metric=views,reach,likes,comments,shares,saved&access_token=${encodeURIComponent(this.cfg.pageToken)}`;
      const r = await getJson<{ data?: { name: string; values?: { value?: number }[]; total_value?: { value?: number } }[] }>(http, url);
      const v = (name: string) => {
        const d = r.data?.find((x) => x.name === name);
        return d?.total_value?.value ?? d?.values?.[0]?.value ?? null;
      };
      out.set(p.id, {
        impressions: v("views"), likes: v("likes"), reposts: v("shares"), replies: v("comments"), quotes: null, bookmarks: v("saved"), videoViews: v("views"),
        raw: { source: "live", igUserId: this.cfg.igUserId, ...r },
      });
    }
    return out;
  }
}

// ─── YouTube videos ──────────────────────────────────────────────────────────

export class YoutubeMetricsProvider implements MetricsProvider {
  readonly platform = "youtube" as const;
  readonly mode = "live" as const;
  constructor(private readonly cfg: { apiKey: string; http?: Http; base?: string }) {}

  async fetch(posts: MetricPost[]): Promise<Map<string, MetricSnapshot>> {
    const http = this.cfg.http ?? fetch;
    const base = this.cfg.base ?? "https://www.googleapis.com/youtube/v3";
    const out = new Map<string, MetricSnapshot>();
    for (let i = 0; i < posts.length; i += 50) {
      const batch = posts.slice(i, i + 50);
      const ids = [...new Set(batch.map((p) => p.platformPostId))].join(",");
      const r = await getJson<{ items?: { id: string; statistics?: Record<string, string> }[] }>(
        http, `${base}/videos?part=statistics&id=${encodeURIComponent(ids)}&key=${encodeURIComponent(this.cfg.apiKey)}`,
      );
      for (const p of batch) {
        const s = r.items?.find((it) => it.id === p.platformPostId)?.statistics;
        if (!s) continue;
        const n = (k: string) => (s[k] !== undefined ? Number(s[k]) : null);
        out.set(p.id, {
          impressions: n("viewCount"), likes: n("likeCount"), reposts: null, replies: n("commentCount"), quotes: null, bookmarks: null, videoViews: n("viewCount"),
          raw: { source: "live", statistics: s },
        });
      }
    }
    return out;
  }
}

// ─── Modes from the environment ──────────────────────────────────────────────

const MODE_ENV: Record<MetricPlatform, string> = {
  x: "METRICS_X_MODE", facebook: "METRICS_FACEBOOK_MODE", instagram: "METRICS_INSTAGRAM_MODE", youtube: "METRICS_YOUTUBE_MODE",
};

/** Each platform's configured mode; anything but "live" is fake (the local default) */
export function metricsModes(env: Record<string, string | undefined> = process.env): Record<MetricPlatform, MetricsMode> {
  return Object.fromEntries(METRIC_PLATFORMS.map((p) => [p, env[MODE_ENV[p]]?.trim().toLowerCase() === "live" ? "live" : "fake"])) as Record<MetricPlatform, MetricsMode>;
}

/**
 * The provider per platform. Live needs its keys: X the X_* OAuth set (the caller passes the client),
 * Facebook META_PAGE_TOKEN + META_PAGE_ID, Instagram META_PAGE_TOKEN + IG_USER_ID, YouTube YT_API_KEY.
 * A live mode without its keys throws, so the worker stops at start instead of showing fake numbers as real.
 */
export function makeMetricsProviders(
  env: Record<string, string | undefined> = process.env, x?: { metrics(ids: string[]): Promise<Record<string, XMetrics>> },
): Record<MetricPlatform, MetricsProvider> {
  const modes = metricsModes(env);
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set (needed for live metrics)`);
    return v;
  };
  return {
    x: modes.x === "live" ? new XMetricsProvider(x ?? (() => { throw new Error("METRICS_X_MODE=live needs the X_* keys (X_MODE=api)"); })()) : new FakeMetricsProvider("x"),
    facebook: modes.facebook === "live" ? new FacebookMetricsProvider({ pageToken: need("META_PAGE_TOKEN"), pageId: need("META_PAGE_ID") }) : new FakeMetricsProvider("facebook"),
    instagram: modes.instagram === "live" ? new InstagramMetricsProvider({ pageToken: need("META_PAGE_TOKEN"), igUserId: need("IG_USER_ID") }) : new FakeMetricsProvider("instagram"),
    youtube: modes.youtube === "live" ? new YoutubeMetricsProvider({ apiKey: need("YT_API_KEY") }) : new FakeMetricsProvider("youtube"),
  };
}

/** The bucket due for a post now, if any: the newest age reached; older missed ones are skipped for live numbers */
export function dueBuckets(publishedAt: Date, now: Date, have: Set<string>, mode: MetricsMode): AgeBucket[] {
  const age = now.getTime() - publishedAt.getTime();
  const reached = AGE_BUCKETS.filter((b) => age >= b.ms);
  const missing = reached.filter((b) => !have.has(b.bucket));
  if (mode === "fake") return missing.map((b) => b.bucket);
  // Live numbers at 3 days are not the 1-hour numbers: only the current bucket is captured
  const current = reached.at(-1);
  return current && !have.has(current.bucket) ? [current.bucket] : [];
}
