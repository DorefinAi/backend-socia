// The "metrics" role: each post's numbers once per age bucket when due, fake numbers marked as sample
// data, a failing provider writes nothing; and migration 0007 on a database that already has rows from
// the old 6-hourly pull. Needs TEST_DATABASE_URL (the database is wiped).

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIGRATIONS_DIR, createDb, orgs, postDrafts, postMetrics, publishedPosts, runMigrations, stories, type DbHandle,
} from "@socia/db";
import { FakeMetricsProvider, YoutubeMetricsProvider, type MetricPlatform, type MetricsProvider } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MetricsJob } from "../src/stages/metrics";

const URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });
const POSTED = new Date("2026-10-28T06:00:00Z");
const at = (h: number) => new Date(POSTED.getTime() + h * 3600_000);

const fakes = (): Record<MetricPlatform, MetricsProvider> => ({
  x: new FakeMetricsProvider("x"), facebook: new FakeMetricsProvider("facebook"), instagram: new FakeMetricsProvider("instagram"), youtube: new FakeMetricsProvider("youtube"),
});

(URL ? describe : describe.skip)("metrics job", () => {
  let h: DbHandle;
  let orgId = "";
  let postId = "";

  async function wipe() {
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
  }

  async function seedPost(platform = "x", publishedAt = POSTED, platformPostId = "1001") {
    const [s] = await h.db.insert(stories).values({ orgId, slug: `s${platformPostId}`, status: "composed", headline: "H", body: "" }).returning();
    const [d] = await h.db.insert(postDrafts).values({ orgId, storyId: s!.id, status: "published", bodyText: "b", cardHeadline: "H", composeVersion: "t", platform }).returning();
    const [p] = await h.db.insert(publishedPosts).values({ orgId, draftId: d!.id, platform, platformPostId, permalink: `https://x.com/f/status/${platformPostId}`, text: "b", publishedAt }).returning();
    return p!.id;
  }

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await wipe();
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it("migration 0007 runs on a database with old metric rows: org, platform and time filled in", async () => {
    // Up to 0006 only
    const dir = mkdtempSync(join(tmpdir(), "socia-mig-"));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const journalPath = join(dir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx <= 6) }));
    await runMigrations(URL!, dir);
    const [org] = await h.db.execute<{ id: string }>(sql`INSERT INTO orgs (name, settings) VALUES ('1st India', '{"hashtagScript":"latin","fixedHashtags":[],"maxHashtags":4,"dailyCaps":{"x":800},"headlineWords":9}') RETURNING id`).then((r) => r.rows);
    const [story] = await h.db.execute<{ id: string }>(sql`INSERT INTO stories (org_id, slug, status) VALUES (${org!.id}, 'old', 'composed') RETURNING id`).then((r) => r.rows);
    const [draft] = await h.db.execute<{ id: string }>(sql`INSERT INTO post_drafts (org_id, story_id, body_text, card_headline, compose_version) VALUES (${org!.id}, ${story!.id}, 'b', 'h', 't') RETURNING id`).then((r) => r.rows);
    const [post] = await h.db.execute<{ id: string }>(sql`INSERT INTO published_posts (org_id, draft_id, platform, platform_post_id, permalink, text) VALUES (${org!.id}, ${draft!.id}, 'x', '9', 'https://x.com/f/status/9', 't') RETURNING id`).then((r) => r.rows);
    await h.db.execute(sql`INSERT INTO post_metrics (post_id, fetched_at, impressions, likes, comments, shares, saves) VALUES (${post!.id}, '2026-10-01T00:00:00Z', 10, 1, 0, 0, 0)`);

    await runMigrations(URL!);
    const [old] = await h.db.select().from(postMetrics);
    expect(old).toMatchObject({ orgId: org!.id, platform: "x", ageBucket: null, impressions: 10 });
    expect(old!.capturedAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  }, 60_000);

  it("captures each due bucket once, fake numbers marked as sample data, legacy columns filled", async () => {
    await wipe();
    await runMigrations(URL!);
    const [org] = await h.db.insert(orgs).values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } }).returning();
    orgId = org!.id;
    postId = await seedPost();
    let clock = at(0.5);
    const job = new MetricsJob({ db: h.db, providers: fakes(), pollMs: 300_000, log, now: () => clock });
    expect(await job.run()).toBe(0);

    clock = at(7);
    expect(await job.run()).toBe(2);
    clock = at(7.1);
    expect(await job.run()).toBe(0);
    const rows = await h.db.select().from(postMetrics).where(eq(postMetrics.postId, postId));
    expect(rows.map((r) => r.ageBucket).sort()).toEqual(["1h", "6h"]);
    const six = rows.find((r) => r.ageBucket === "6h")!;
    const one = rows.find((r) => r.ageBucket === "1h")!;
    expect(six.impressions!).toBeGreaterThan(one.impressions!);
    expect(six).toMatchObject({ orgId, platform: "x", raw: { source: "fake", bucket: "6h" }, comments: six.replies, saves: six.bookmarks, shares: six.reposts! + six.quotes! });

    // The loop only runs when the poll interval has passed
    clock = at(30);
    await job.tick();
    expect((await h.db.select().from(postMetrics).where(eq(postMetrics.postId, postId))).map((r) => r.ageBucket).sort()).toEqual(["1h", "24h", "6h"]);
    clock = at(30.01);
    expect(await job.tick()).toBe(false);
    expect(await h.db.select().from(postMetrics)).toHaveLength(3);

    // Past 8 days a post is no longer looked at
    clock = at(24 * 9);
    expect(await job.run()).toBe(0);
  });

  it("live: only the current bucket; a failing platform writes nothing and is tried again", async () => {
    const yt = await seedPost("youtube", POSTED, "dQw4w9WgXcQ");
    let fail = true;
    const http = (async () => {
      if (fail) return new Response("quota", { status: 403 });
      return new Response(JSON.stringify({ items: [{ id: "dQw4w9WgXcQ", statistics: { viewCount: "900", likeCount: "40", commentCount: "3" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    let clock = at(30);
    const job = new MetricsJob({ db: h.db, providers: { ...fakes(), youtube: new YoutubeMetricsProvider({ apiKey: "k", http }) }, pollMs: 300_000, log, now: () => clock });
    await job.run();
    expect(await h.db.select().from(postMetrics).where(eq(postMetrics.postId, yt))).toEqual([]);
    fail = false;
    clock = at(31);
    await job.run();
    const rows = await h.db.select().from(postMetrics).where(eq(postMetrics.postId, yt));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ageBucket: "24h", impressions: 900, likes: 40, replies: 3, raw: { source: "live" } });
  });
});
