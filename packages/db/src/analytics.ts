// Post analytics (handoff/scraper-analytics-contract.md §B): the desk's own numbers from existing tables,
// and the platform numbers the "metrics" worker captures per post at fixed ages.

import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client";
import { assets, auditLog, postDrafts, postMetrics, publishedPosts, stories, users, type MetricAgeBucket } from "./schema";

const IST = "Asia/Kolkata";

// ─── Desk (our own numbers) ──────────────────────────────────────────────────

export interface DeskAnalytics {
  totals: { received: number; approved: number; posted: number; rejected: number; medianApproveToPostMin: number | null };
  perDay: { day: string; received: number; posted: number; rejected: number }[];
  byDistrict: { district: string | null; posted: number }[];
  byCategory: { category: string | null; posted: number }[];
  byHour: { hour: number; posted: number }[];
  rejectReasons: { reason: string; count: number }[];
  byEditor: { userId: string; name: string; approved: number; posted: number; rejected: number }[];
}

/** IST calendar days from `from` to `to` (exclusive end), as YYYY-MM-DD */
export function istDays(from: Date, to: Date): string[] {
  const off = 5.5 * 3600_000;
  const day = (d: Date) => new Date(d.getTime() + off).toISOString().slice(0, 10);
  const out: string[] = [];
  const last = day(new Date(to.getTime() - 1));
  for (let d = new Date(`${day(from)}T00:00:00Z`); ; d = new Date(d.getTime() + 86400_000)) {
    const s = d.toISOString().slice(0, 10);
    out.push(s);
    if (s >= last || out.length > 400) break;
  }
  return out;
}

const n = (v: unknown) => Number(v ?? 0);
/** Approvals: through the queue, or posted by hand and recorded (approved and posted in one step) */
const APPROVE_ACTIONS = ["draft.approve", "draft.mark_posted"];

/**
 * received = stories that arrived; approved = drafts approved (or marked posted by hand); posted = posts
 * that went out (recalled ones included); rejected = drafts rejected. Each counted in the period of the
 * event; a draft rejected, restored and rejected again counts once. Days and hours are IST.
 */
export async function deskAnalytics(db: Db, orgId: string, from: Date, to: Date): Promise<DeskAnalytics> {
  const inRange = (col: Parameters<typeof gte>[0]) => and(gte(col, from), lt(col, to));
  const istDay = (col: unknown) => sql<string>`to_char(${col} AT TIME ZONE ${IST}, 'YYYY-MM-DD')`;
  const audits = (actions: string[]) => and(eq(auditLog.orgId, orgId), inArray(auditLog.action, actions), inRange(auditLog.at));

  const [[received], [approved], [posted], [rejected]] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(stories).where(and(eq(stories.orgId, orgId), inRange(stories.createdAt))),
    db.select({ n: sql<number>`count(distinct ${auditLog.entityId})` }).from(auditLog).where(audits(APPROVE_ACTIONS)),
    db.select({ n: sql<number>`count(*)` }).from(publishedPosts).where(and(eq(publishedPosts.orgId, orgId), inRange(publishedPosts.publishedAt))),
    db.select({ n: sql<number>`count(distinct ${auditLog.entityId})` }).from(auditLog).where(audits(["draft.reject"])),
  ]);

  // Approve → post: queue posts only (a hand-recorded post has no wait); the last approval before the post
  const median = await db.execute<{ m: number | null }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.published_at - a.at) / 60) AS m
    FROM ${publishedPosts} p
    JOIN LATERAL (
      SELECT max(l.at) AS at FROM ${auditLog} l
      WHERE l.org_id = p.org_id AND l.action = 'draft.approve' AND l.entity_type = 'post_draft' AND l.entity_id = p.draft_id::text AND l.at <= p.published_at
    ) a ON a.at IS NOT NULL
    WHERE p.org_id = ${orgId} AND p.manual = false AND p.published_at >= ${from} AND p.published_at < ${to}`);
  const m = median.rows[0]?.m;

  const [recDays, postDays, rejDays] = await Promise.all([
    db.select({ day: istDay(stories.createdAt), n: sql<number>`count(*)` }).from(stories).where(and(eq(stories.orgId, orgId), inRange(stories.createdAt))).groupBy(sql`1`),
    db.select({ day: istDay(publishedPosts.publishedAt), n: sql<number>`count(*)` }).from(publishedPosts).where(and(eq(publishedPosts.orgId, orgId), inRange(publishedPosts.publishedAt))).groupBy(sql`1`),
    db.select({ day: istDay(auditLog.at), n: sql<number>`count(distinct ${auditLog.entityId})` }).from(auditLog).where(audits(["draft.reject"])).groupBy(sql`1`),
  ]);
  const at = (rows: { day: string; n: number }[]) => new Map(rows.map((r) => [r.day, n(r.n)]));
  const [rd, pd, jd] = [at(recDays), at(postDays), at(rejDays)];
  const perDay = istDays(from, to).map((day) => ({ day, received: rd.get(day) ?? 0, posted: pd.get(day) ?? 0, rejected: jd.get(day) ?? 0 }));

  const postedStories = db
    .select({ district: stories.district, category: sql<string | null>`${stories.external}->>'category'`.as("category"), publishedAt: publishedPosts.publishedAt })
    .from(publishedPosts)
    .innerJoin(postDrafts, eq(postDrafts.id, publishedPosts.draftId))
    .innerJoin(stories, eq(stories.id, postDrafts.storyId))
    .where(and(eq(publishedPosts.orgId, orgId), inRange(publishedPosts.publishedAt)))
    .as("ps");
  const [districts, categories, hours, reasons] = await Promise.all([
    db.select({ district: postedStories.district, n: sql<number>`count(*)` }).from(postedStories).groupBy(postedStories.district),
    db.select({ category: postedStories.category, n: sql<number>`count(*)` }).from(postedStories).groupBy(postedStories.category),
    db.select({ hour: sql<number>`extract(hour FROM ${publishedPosts.publishedAt} AT TIME ZONE ${IST})::int`, n: sql<number>`count(*)` })
      .from(publishedPosts).where(and(eq(publishedPosts.orgId, orgId), inRange(publishedPosts.publishedAt))).groupBy(sql`1`),
    db.select({ reason: sql<string>`coalesce(${auditLog.after}->>'reason', 'other')`, n: sql<number>`count(*)` }).from(auditLog).where(audits(["draft.reject"])).groupBy(sql`1`),
  ]);
  const byHourMap = new Map(hours.map((h) => [n(h.hour), n(h.n)]));

  // Per editor: approvals and rejections they made, posts that went out under their name
  const [acts, posts] = await Promise.all([
    db.select({ userId: auditLog.actorId, action: auditLog.action, n: sql<number>`count(distinct ${auditLog.entityId})` })
      .from(auditLog).where(audits([...APPROVE_ACTIONS, "draft.reject"])).groupBy(auditLog.actorId, auditLog.action),
    db.select({ userId: publishedPosts.publishedBy, n: sql<number>`count(*)` })
      .from(publishedPosts).where(and(eq(publishedPosts.orgId, orgId), inRange(publishedPosts.publishedAt))).groupBy(publishedPosts.publishedBy),
  ]);
  const editors = new Map<string, { approved: number; posted: number; rejected: number }>();
  const ed = (id: string) => editors.get(id) ?? (editors.set(id, { approved: 0, posted: 0, rejected: 0 }), editors.get(id)!);
  for (const a of acts) {
    if (!a.userId) continue;
    if (a.action === "draft.reject") ed(a.userId).rejected += n(a.n);
    else ed(a.userId).approved += n(a.n);
  }
  for (const p of posts) if (p.userId) ed(p.userId).posted += n(p.n);
  const names = editors.size
    ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...editors.keys()]))).map((u) => [u.id, u.name]))
    : new Map<string, string>();

  const desc2 = <T extends { [k: string]: unknown }>(rows: T[], key: keyof T) => rows.sort((a, b) => n(b[key]) - n(a[key]));
  return {
    totals: {
      received: n(received?.n), approved: n(approved?.n), posted: n(posted?.n), rejected: n(rejected?.n),
      medianApproveToPostMin: m === null || m === undefined ? null : Math.round(Number(m) * 10) / 10,
    },
    perDay,
    byDistrict: desc2(districts.map((d) => ({ district: d.district, posted: n(d.n) })), "posted"),
    byCategory: desc2(categories.map((c) => ({ category: c.category, posted: n(c.n) })), "posted"),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, posted: byHourMap.get(hour) ?? 0 })),
    rejectReasons: desc2(reasons.map((r) => ({ reason: r.reason, count: n(r.n) })), "count"),
    byEditor: [...editors.entries()]
      .map(([userId, v]) => ({ userId, name: names.get(userId) ?? "(removed user)", ...v }))
      .sort((a, b) => b.posted + b.approved - (a.posted + a.approved) || a.name.localeCompare(b.name)),
  };
}

// ─── Platform metrics: capture ───────────────────────────────────────────────

export interface MetricsCandidate {
  id: string;
  orgId: string;
  platform: string;
  platformPostId: string;
  publishedAt: Date;
  /** Age buckets already captured */
  have: string[];
}

/** Posts that can still reach a bucket: published in the last 8 days and not recalled */
export async function metricsCandidates(db: Db, now: Date): Promise<MetricsCandidate[]> {
  const rows = await db
    .select({
      id: publishedPosts.id, orgId: publishedPosts.orgId, platform: publishedPosts.platform, platformPostId: publishedPosts.platformPostId,
      publishedAt: publishedPosts.publishedAt,
      have: sql<string[]>`coalesce(array_agg(${postMetrics.ageBucket}) FILTER (WHERE ${postMetrics.ageBucket} IS NOT NULL), '{}')`,
    })
    .from(publishedPosts)
    .leftJoin(postMetrics, eq(postMetrics.postId, publishedPosts.id))
    .where(and(gte(publishedPosts.publishedAt, new Date(now.getTime() - 8 * 86400_000)), isNull(publishedPosts.recalledAt)))
    .groupBy(publishedPosts.id);
  return rows;
}

export interface MetricsRow {
  orgId: string;
  postId: string;
  platform: string;
  ageBucket: MetricAgeBucket;
  capturedAt: Date;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
  quotes: number | null;
  bookmarks: number | null;
  videoViews: number | null;
  raw: Record<string, unknown>;
}

/** One row per post and bucket; a bucket already captured is left as it was. Returns rows written. */
export async function saveMetrics(db: Db, rows: MetricsRow[]): Promise<number> {
  if (!rows.length) return 0;
  const saved = await db
    .insert(postMetrics)
    .values(rows.map((r) => ({
      ...r, fetchedAt: r.capturedAt,
      // The old column names, still read by GET /posts
      comments: r.replies, shares: r.reposts === null && r.quotes === null ? null : (r.reposts ?? 0) + (r.quotes ?? 0), saves: r.bookmarks,
    })))
    .onConflictDoNothing({ target: [postMetrics.postId, postMetrics.ageBucket] })
    .returning({ id: postMetrics.id });
  return saved.length;
}

// ─── Platform metrics: read ──────────────────────────────────────────────────

export interface PostWithMetrics {
  id: string;
  platform: string;
  permalink: string;
  postedAt: string;
  headline: string | null;
  district: string | null;
  category: string | null;
  hashtags: string[];
  hasFootage: boolean;
  /** The newest capture; null before the first */
  metrics: {
    ageBucket: string | null; capturedAt: string; impressions: number | null; likes: number | null; reposts: number | null; replies: number | null;
    quotes: number | null; bookmarks: number | null; videoViews: number | null; engagementRate: number | null;
  } | null;
  /** "fake" when the numbers are made up (sample data), "live" from the platform, null without numbers */
  mode: "fake" | "live" | null;
}

/** (likes + reposts + replies + quotes) / impressions, or null without impressions */
export function engagementRate(m: { impressions: number | null; likes: number | null; reposts: number | null; replies: number | null; quotes: number | null }): number | null {
  if (!m.impressions) return null;
  return ((m.likes ?? 0) + (m.reposts ?? 0) + (m.replies ?? 0) + (m.quotes ?? 0)) / m.impressions;
}

/** Every post of the period (newest first) with its latest numbers and the story it came from */
export async function postsWithMetrics(db: Db, orgId: string, from: Date, to: Date, platform?: string): Promise<PostWithMetrics[]> {
  const latest = db
    .selectDistinctOn([postMetrics.postId], {
      postId: postMetrics.postId, ageBucket: postMetrics.ageBucket, capturedAt: postMetrics.capturedAt, impressions: postMetrics.impressions, likes: postMetrics.likes,
      reposts: postMetrics.reposts, shares: postMetrics.shares, replies: postMetrics.replies, comments: postMetrics.comments, quotes: postMetrics.quotes,
      bookmarks: postMetrics.bookmarks, saves: postMetrics.saves, videoViews: postMetrics.videoViews, raw: postMetrics.raw,
    })
    .from(postMetrics)
    .orderBy(postMetrics.postId, desc(postMetrics.capturedAt))
    .as("latest");
  const footage = sql<boolean>`EXISTS (SELECT 1 FROM ${assets} a WHERE a.story_id = ${stories.id} AND (a.attached_by = 'footage' OR a.kind = 'video'))`;
  const rows = await db
    .select({
      p: { id: publishedPosts.id, platform: publishedPosts.platform, permalink: publishedPosts.permalink, publishedAt: publishedPosts.publishedAt },
      headline: sql<string | null>`coalesce(${stories.headline}, ${postDrafts.cardHeadline})`, district: stories.district,
      category: sql<string | null>`${stories.external}->>'category'`, hashtags: postDrafts.hashtags, hasFootage: footage,
      m: {
        postId: latest.postId, ageBucket: latest.ageBucket, capturedAt: latest.capturedAt, impressions: latest.impressions, likes: latest.likes, reposts: latest.reposts,
        shares: latest.shares, replies: latest.replies, comments: latest.comments, quotes: latest.quotes, bookmarks: latest.bookmarks, saves: latest.saves,
        videoViews: latest.videoViews, raw: latest.raw,
      },
    })
    .from(publishedPosts)
    .leftJoin(postDrafts, eq(postDrafts.id, publishedPosts.draftId))
    .leftJoin(stories, eq(stories.id, postDrafts.storyId))
    .leftJoin(latest, eq(latest.postId, publishedPosts.id))
    .where(and(eq(publishedPosts.orgId, orgId), gte(publishedPosts.publishedAt, from), lt(publishedPosts.publishedAt, to), platform ? eq(publishedPosts.platform, platform) : undefined))
    .orderBy(desc(publishedPosts.publishedAt));
  return rows.map(({ p, m, ...r }) => {
    const metrics = m?.postId
      ? {
          // Rows from the old 6-hourly pull only have the old names (comments, shares = reposts + quotes, saves)
          ageBucket: m.ageBucket, capturedAt: new Date(m.capturedAt!).toISOString(), impressions: m.impressions, likes: m.likes, reposts: m.reposts ?? m.shares,
          replies: m.replies ?? m.comments, quotes: m.quotes, bookmarks: m.bookmarks ?? m.saves, videoViews: m.videoViews, engagementRate: null as number | null,
        }
      : null;
    if (metrics) metrics.engagementRate = engagementRate(metrics);
    return {
      id: p.id, platform: p.platform, permalink: p.permalink, postedAt: p.publishedAt.toISOString(), headline: r.headline, district: r.district, category: r.category,
      hashtags: r.hashtags ?? [], hasFootage: !!r.hasFootage, metrics, mode: metrics ? ((m!.raw as { source?: string } | null)?.source === "fake" ? "fake" : "live") : null,
    };
  });
}


export const POST_SORTS = ["impressions", "likes", "reposts", "engagement"] as const;
export type PostSort = (typeof POST_SORTS)[number];

/** Highest first; posts without the number go last, newest first among equals */
export function sortPosts(posts: PostWithMetrics[], sort: PostSort): PostWithMetrics[] {
  const key = (p: PostWithMetrics) => {
    const m = p.metrics;
    if (!m) return -1;
    const v = sort === "engagement" ? m.engagementRate : m[sort];
    return v ?? -1;
  };
  return [...posts].sort((a, b) => key(b) - key(a) || b.postedAt.localeCompare(a.postedAt));
}

export interface PostInsights {
  topHashtags: { tag: string; posts: number; avgEngagement: number | null }[];
  byDistrict: { district: string | null; posts: number; avgEngagement: number | null }[];
  byCategory: { category: string | null; posts: number; avgEngagement: number | null }[];
  byHour: { hour: number; posts: number; avgEngagement: number | null }[];
  footageVsNot: { withFootage: { posts: number; avgEngagement: number | null }; without: { posts: number; avgEngagement: number | null } };
}

/** Mean engagement rate over the posts that have impressions; null when none has */
function avg(posts: PostWithMetrics[]): number | null {
  const rates = posts.map((p) => p.metrics?.engagementRate).filter((r): r is number => typeof r === "number");
  return rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10000) / 10000 : null;
}

function groupBy<K>(posts: PostWithMetrics[], key: (p: PostWithMetrics) => K[]): Map<K, PostWithMetrics[]> {
  const out = new Map<K, PostWithMetrics[]>();
  for (const p of posts) for (const k of key(p)) out.set(k, [...(out.get(k) ?? []), p]);
  return out;
}

const istHour = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600_000).getUTCHours();

/** Where the engagement is: hashtags (top 20), districts, categories, IST hour, footage or not */
export function postInsights(posts: PostWithMetrics[]): PostInsights {
  const rows = <K>(m: Map<K, PostWithMetrics[]>) => [...m.entries()].map(([k, list]) => ({ k, posts: list.length, avgEngagement: avg(list) }));
  const order = (a: { posts: number; avgEngagement: number | null }, b: typeof a) => b.posts - a.posts || (b.avgEngagement ?? -1) - (a.avgEngagement ?? -1);
  const hours = groupBy(posts, (p) => [istHour(p.postedAt)]);
  const footage = posts.filter((p) => p.hasFootage);
  const plain = posts.filter((p) => !p.hasFootage);
  return {
    topHashtags: rows(groupBy(posts, (p) => [...new Set(p.hashtags.map((h) => h.trim()).filter(Boolean))]))
      .sort(order)
      .slice(0, 20)
      .map(({ k, ...r }) => ({ tag: k, ...r })),
    byDistrict: rows(groupBy(posts, (p) => [p.district])).sort(order).map(({ k, ...r }) => ({ district: k, ...r })),
    byCategory: rows(groupBy(posts, (p) => [p.category])).sort(order).map(({ k, ...r }) => ({ category: k, ...r })),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, posts: hours.get(hour)?.length ?? 0, avgEngagement: avg(hours.get(hour) ?? []) })),
    footageVsNot: { withFootage: { posts: footage.length, avgEngagement: avg(footage) }, without: { posts: plain.length, avgEngagement: avg(plain) } },
  };
}
