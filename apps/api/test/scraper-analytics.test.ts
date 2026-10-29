// Web Scraper v2 (stories, districts, keyword watches) and post analytics (desk numbers, platform
// numbers), handoff/scraper-analytics-contract.md. Needs TEST_DATABASE_URL (the database is wiped).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrendRow } from "@socia/core";
import { assets, auditLog, createDb, orgs, postDrafts, postMetrics, publishedPosts, runMigrations, saveTrendRun, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { analyticsRange } from "../src/routes/analytics";

const URL = process.env.TEST_DATABASE_URL;
const now = Date.now();
const ago = (h: number) => new Date(now - h * 3600_000);

const row = (r: Partial<TrendRow> & Pick<TrendRow, "title" | "rank" | "clusterId" | "clusterRank">): TrendRow => ({
  type: "articles", window: "24h", url: `https://news.example.in/${r.rank}`, platform: "RSS", sourceName: "Rajasthan Patrika", reasonWhy: "", superTag: "General", subTag: "",
  district: null, volume: "", growth: "", shares: "", publishedAt: ago(2), imageUrl: null, imageSource: null, headline: r.title, summary: "", alert: null, sources: [], score: 0, ...r,
});

describe("analyticsRange", () => {
  it("defaults to the last 7 days; refuses an empty or reversed period and more than 92 days", () => {
    const at = new Date("2026-10-29T00:00:00Z");
    expect(analyticsRange({}, at)).toEqual({ from: new Date("2026-10-22T00:00:00Z"), to: at });
    expect(() => analyticsRange({ from: "2026-10-29T00:00:00Z", to: "2026-10-28T00:00:00Z" })).toThrow(/before its end/);
    expect(() => analyticsRange({ from: "2026-06-01T00:00:00Z", to: "2026-10-01T00:00:00Z" })).toThrow(/92 days/);
  });
});

(URL ? describe : describe.skip)("Web Scraper v2 and analytics API", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  const who = { op: { cookie: "", csrf: "", id: "" }, ed: { cookie: "", csrf: "", id: "" }, viewer: { cookie: "", csrf: "", id: "" } };
  type Who = (typeof who)["op"];

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3006"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null,
  };

  async function call(w: Who | null, method: string, url: string, payload?: unknown, csrf = true) {
    const headers: Record<string, string> = w ? { cookie: w.cookie, ...(csrf ? { "x-csrf": w.csrf } : {}) } : {};
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers });
    const json = res.headers["content-type"]?.toString().startsWith("application/json");
    return { status: res.statusCode, body: json && res.body ? JSON.parse(res.body) : null };
  }

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const passwordHash = await hashPassword("correct horse battery");
    const made = await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash, role: "operator" },
      { orgId, name: "Ed", email: "ed@test", passwordHash, role: "editor" },
      { orgId, name: "View", email: "viewer@test", passwordHash, role: "viewer" },
    ]).returning();
    app = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-sa-")), "http://localhost/dev-files"), config }, false);
    for (const [name, into] of Object.entries(who)) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${name}@test`, password: "correct horse battery" } });
      into.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
      into.csrf = JSON.parse(res.body).csrfToken;
      into.id = made.find((u) => u.email === `${name}@test`)!.id;
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  describe("stories, districts, watches", () => {
    const asaramSources = [
      { name: "ABP Live Rajasthan", url: "https://abp.in/a", publishedAt: ago(1).toISOString() },
      { name: "News18 Rajasthan", url: "https://n18.in/a", publishedAt: ago(2).toISOString() },
      { name: "Patrika Jodhpur", url: "https://patrika.in/a", publishedAt: ago(3).toISOString() },
    ];

    beforeAll(async () => {
      const rows: TrendRow[] = [];
      for (const window of ["24h", "7d"] as const) {
        rows.push(
          row({ window, title: "जोधपुर: आसाराम की पैरोल खत्म, जेल में एंट्री नहीं", rank: 1, clusterId: "s1", clusterRank: 1, district: "Jodhpur", sourceName: "ABP Live Rajasthan", url: "https://abp.in/a", sources: asaramSources, publishedAt: ago(1) }),
          row({ window, title: "Asaram News: पैरोल खत्म होने के बाद जेल में लेट पहुंचे आसाराम", rank: 2, clusterId: "s1", clusterRank: 1, district: "Jodhpur", sourceName: "News18 Rajasthan", url: "https://n18.in/a", sources: asaramSources }),
          row({ window, title: "Jaipur metro phase 2 approved", rank: 3, clusterId: "s2", clusterRank: 2, district: "Jaipur", summary: "JDA says work starts in December." }),
          // Beyond the desk's top 20 stories: only a narrowing filter shows it
          row({ window, title: "कोटा में कोचिंग छात्रों के लिए नई गाइडलाइन", rank: 4, clusterId: "s3", clusterRank: 21, district: "Kota", publishedAt: ago(30) }),
        );
      }
      await saveTrendRun(h.db, orgId, { trigger: "schedule", startedAt: new Date(), sources: [] }, rows);
    });

    it("one row per story with its sources, the top 20 stories by default; group=0 gives every article", async () => {
      const res = await call(who.viewer, "GET", "/trends?type=articles");
      expect(res.status).toBe(200);
      expect(res.body.items.map((i: { clusterId: string; rank: number }) => [i.clusterId, i.rank])).toEqual([["s1", 1], ["s2", 2]]);
      expect(res.body.items[0]).toMatchObject({ sourceCount: 3, sources: asaramSources, district: "Jodhpur", watchHits: [], sourceName: "ABP Live Rajasthan" });
      expect(res.body.items[1]).toMatchObject({ sourceCount: 1, sources: [{ name: "Rajasthan Patrika", url: "https://news.example.in/3" }] });
      const raw = await call(who.viewer, "GET", "/trends?type=articles&group=0");
      expect(raw.body.items.map((i: { rank: number; clusterId: string }) => [i.rank, i.clusterId])).toEqual([[1, "s1"], [2, "s1"], [3, "s2"]]);
      expect((await call(who.viewer, "GET", "/trends?type=articles&group=2")).status).toBe(400);
    });

    it("filters by district (any case), past the top 20; counts stories per district for 24 h", async () => {
      const kota = await call(who.viewer, "GET", "/trends?type=articles&district=kota");
      expect(kota.body.items.map((i: { district: string | null; rank: number }) => [i.rank, i.district])).toEqual([[1, "Kota"]]);
      expect((await call(who.viewer, "GET", "/trends?type=articles&district=Ajmer")).body.items).toEqual([]);
      const d = await call(who.viewer, "GET", "/trends/districts");
      expect(d.status).toBe(200);
      expect(d.body.districts).toEqual([{ name: "Jaipur", count: 1 }, { name: "Jodhpur", count: 1 }, { name: "Kota", count: 1 }]);
      expect((await call(null, "GET", "/trends/districts")).status).toBe(401);
    });

    it("keyword watches: add (any case once), list, mark and filter items, new hits, remove", async () => {
      expect((await call(who.viewer, "GET", "/me/trend-watches")).body).toEqual({ watches: [], max: 50 });
      const added = await call(who.viewer, "POST", "/me/trend-watches", { keyword: "  Metro " });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({ created: true, watch: { keyword: "Metro", id: expect.any(String), createdAt: expect.any(String) } });
      expect(await call(who.viewer, "POST", "/me/trend-watches", { keyword: "METRO" })).toMatchObject({ status: 200, body: { created: false, watch: { id: added.body.watch.id } } });
      expect((await call(who.viewer, "POST", "/me/trend-watches", { keyword: "   " })).status).toBe(400);
      expect((await call(who.viewer, "POST", "/me/trend-watches", { keyword: "!!!" })).status).toBe(400);
      expect((await call(who.viewer, "POST", "/me/trend-watches", { keyword: "x".repeat(81) })).status).toBe(400);
      expect((await call(who.viewer, "POST", "/me/trend-watches", { keyword: "पैरोल" }, false)).status).toBe(403);
      expect((await call(who.viewer, "POST", "/me/trend-watches", { keyword: "पैरोल" })).status).toBe(201);

      const all = await call(who.viewer, "GET", "/trends?type=articles");
      expect(all.body.items.map((i: { watchHits: string[] }) => i.watchHits)).toEqual([["पैरोल"], ["Metro"]]);
      const watched = await call(who.viewer, "GET", "/trends?type=articles&watched=1&group=0");
      expect(watched.body.items.map((i: { rank: number }) => i.rank)).toEqual([1, 2, 3]);
      // Another user's watches are their own
      expect((await call(who.ed, "GET", "/trends?type=articles&watched=1")).body.items).toEqual([]);

      const hits = await call(who.viewer, "GET", `/me/trend-watches/hits?since=${encodeURIComponent(ago(1.5).toISOString())}`);
      expect(hits.status).toBe(200);
      expect(hits.body.count).toBe(1);
      expect(hits.body.items[0]).toMatchObject({ clusterId: "s1", watchHits: ["पैरोल"], rank: 1 });
      expect((await call(who.viewer, "GET", "/me/trend-watches/hits")).body.count).toBe(2);
      expect((await call(who.viewer, "GET", "/me/trend-watches/hits?since=yesterday")).status).toBe(400);
      expect((await call(who.ed, "GET", "/me/trend-watches/hits")).body).toMatchObject({ count: 0, items: [] });

      expect((await call(who.ed, "DELETE", `/me/trend-watches/${added.body.watch.id}`)).status).toBe(404);
      expect((await call(who.viewer, "DELETE", `/me/trend-watches/${added.body.watch.id}`)).status).toBe(204);
      expect((await call(who.viewer, "GET", "/me/trend-watches")).body.watches.map((w: { keyword: string }) => w.keyword)).toEqual(["पैरोल"]);
    });

    it("at most 50 keywords each", async () => {
      for (let i = 0; i < 49; i++) expect((await call(who.op, "POST", "/me/trend-watches", { keyword: `word${i}` })).status).toBe(201);
      expect((await call(who.op, "POST", "/me/trend-watches", { keyword: "fifty" })).status).toBe(201);
      expect(await call(who.op, "POST", "/me/trend-watches", { keyword: "one more" })).toMatchObject({ status: 409, body: { error: "watch_limit" } });
      expect((await call(who.op, "POST", "/me/trend-watches", { keyword: "FIFTY" })).status).toBe(200);
    });
  });

  describe("analytics", () => {
    // Three IST days: 20, 21 and 22 Oct 2026
    const from = "2026-10-19T18:30:00.000Z";
    const to = "2026-10-22T18:30:00.000Z";
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const postIds: Record<string, string> = {};

    beforeAll(async () => {
      const story = async (key: string, createdAt: string, district: string | null, category: string | null) => {
        const [s] = await h.db.insert(stories).values({
          orgId, source: "samvadia", externalId: key, slug: key, status: "composed", headline: `Headline ${key}`, body: "", district, createdAt: new Date(createdAt),
          external: category ? { storyId: key, itemId: key, version: 1, kind: "story", guid: key, title: key, reporter: null, districtCode: null, publishedAt: createdAt, footagePath: null, footageStatus: null, category } : null,
        }).returning();
        const [d] = await h.db.insert(postDrafts).values({
          orgId, storyId: s!.id, status: "ready", bodyText: key, cardHeadline: key, hashtags: key === "A" ? ["#Jaipur", "#Politics"] : ["#Jaipur"], composeVersion: "t",
        }).returning();
        return { story: s!, draft: d! };
      };
      const a = await story("A", "2026-10-20T04:00:00Z", "Jaipur", "Politics");
      const b = await story("B", "2026-10-21T10:00:00Z", "Kota", "Crime");
      const c = await story("C", "2026-10-21T20:00:00Z", null, null);
      await story("D", "2026-10-10T04:00:00Z", "Ajmer", "Politics"); // before the period
      await h.db.insert(assets).values({ orgId, storyId: c.story.id, kind: "video", slug: "C", attachedBy: "footage", storageKey: "footage/c.mp4" });
      const audit = (draftId: string, actorId: string, action: string, at: string, after: Record<string, unknown> = {}) =>
        ({ orgId, actorId, action, entityType: "post_draft", entityId: draftId, after, at: new Date(at) });
      await h.db.insert(auditLog).values([
        audit(a.draft.id, who.ed.id, "draft.approve", "2026-10-20T05:00:00Z"),
        audit(b.draft.id, who.ed.id, "draft.reject", "2026-10-21T10:30:00Z", { reason: "duplicate" }),
        audit(c.draft.id, who.op.id, "draft.mark_posted", "2026-10-21T21:00:00Z"),
      ]);
      const posts = await h.db.insert(publishedPosts).values([
        { orgId, draftId: a.draft.id, platform: "x", platformPostId: "1001", permalink: "https://x.com/f/status/1001", text: "A", publishedAt: new Date("2026-10-20T05:12:00Z"), publishedBy: who.ed.id },
        { orgId, draftId: c.draft.id, platform: "x", platformPostId: "1003", permalink: "https://x.com/f/status/1003", text: "C", publishedAt: new Date("2026-10-21T21:00:00Z"), publishedBy: who.op.id, manual: true },
      ]).returning();
      postIds.A = posts[0]!.id;
      postIds.C = posts[1]!.id;
      const m = (postId: string, ageBucket: "1h" | "24h", capturedAt: string, impressions: number, likes: number, reposts: number, replies: number, quotes: number) =>
        ({ orgId, postId, platform: "x", ageBucket, capturedAt: new Date(capturedAt), impressions, likes, reposts, replies, quotes, bookmarks: 1, raw: { source: "fake" } });
      await h.db.insert(postMetrics).values([
        m(postIds.A, "1h", "2026-10-20T06:12:00Z", 1000, 50, 10, 5, 5),
        m(postIds.A, "24h", "2026-10-21T05:12:00Z", 2000, 100, 20, 10, 10),
        m(postIds.C, "1h", "2026-10-21T22:00:00Z", 500, 5, 0, 0, 0),
      ]);
    });

    it("desk: received, approved, posted, rejected, approve-to-post median, per IST day and hour, districts, reasons, editors", async () => {
      const res = await call(who.ed, "GET", `/analytics/desk?${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ from, to });
      expect(res.body.totals).toEqual({ received: 3, approved: 2, posted: 2, rejected: 1, medianApproveToPostMin: 12 });
      expect(res.body.perDay).toEqual([
        { day: "2026-10-20", received: 1, posted: 1, rejected: 0 },
        { day: "2026-10-21", received: 1, posted: 0, rejected: 1 },
        { day: "2026-10-22", received: 1, posted: 1, rejected: 0 },
      ]);
      expect(res.body.byHour).toHaveLength(24);
      expect(res.body.byHour.filter((x: { posted: number }) => x.posted)).toEqual([{ hour: 2, posted: 1 }, { hour: 10, posted: 1 }]);
      expect(res.body.byDistrict).toEqual(expect.arrayContaining([{ district: "Jaipur", posted: 1 }, { district: null, posted: 1 }]));
      expect(res.body.byCategory).toEqual(expect.arrayContaining([{ category: "Politics", posted: 1 }, { category: null, posted: 1 }]));
      expect(res.body.rejectReasons).toEqual([{ reason: "duplicate", count: 1 }]);
      expect(res.body.byEditor).toEqual([
        { userId: who.ed.id, name: "Ed", approved: 1, posted: 1, rejected: 1 },
        { userId: who.op.id, name: "Op", approved: 1, posted: 1, rejected: 0 },
      ]);
    });

    it("editors and admins only; the period is checked", async () => {
      expect((await call(who.op, "GET", `/analytics/desk?${q}`)).status).toBe(403);
      expect((await call(who.viewer, "GET", "/analytics/posts")).status).toBe(403);
      expect((await call(null, "GET", "/analytics/insights")).status).toBe(401);
      expect((await call(who.ed, "GET", `/analytics/desk?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`)).status).toBe(400);
      expect((await call(who.ed, "GET", "/analytics/desk?from=2026-01-01T00:00:00Z&to=2026-10-01T00:00:00Z")).status).toBe(400);
      expect((await call(who.ed, "GET", "/analytics/desk")).body.perDay.length).toBeGreaterThanOrEqual(7);
    });

    it("posts: latest numbers per post, sorted, with the story's headline, district, hashtags and footage; sample data says fake", async () => {
      const res = await call(who.ed, "GET", `/analytics/posts?${q}&sort=engagement`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 2, modes: { x: "fake", facebook: "fake", instagram: "fake", youtube: "fake" } });
      const [first, second] = res.body.items;
      expect(first).toMatchObject({
        id: postIds.A, platform: "x", permalink: "https://x.com/f/status/1001", headline: "Headline A", district: "Jaipur", category: "Politics", hashtags: ["#Jaipur", "#Politics"],
        hasFootage: false, mode: "fake", postedAt: "2026-10-20T05:12:00.000Z",
        metrics: { ageBucket: "24h", impressions: 2000, likes: 100, reposts: 20, replies: 10, quotes: 10, engagementRate: 0.07 },
      });
      expect(second).toMatchObject({ id: postIds.C, hasFootage: true, metrics: { engagementRate: 0.01 } });
      expect((await call(who.ed, "GET", `/analytics/posts?${q}&sort=impressions&limit=1&platform=x`)).body).toMatchObject({ mode: "fake", items: [{ id: postIds.A }] });
      expect((await call(who.ed, "GET", `/analytics/posts?${q}&platform=facebook`)).body).toMatchObject({ total: 0, items: [], mode: "fake" });
      expect((await call(who.ed, "GET", `/analytics/posts?${q}&sort=views`)).status).toBe(400);
    });

    it("insights: hashtags, districts, categories, best hours and footage vs not, by mean engagement rate", async () => {
      const res = await call(who.ed, "GET", `/analytics/insights?${q}`);
      expect(res.status).toBe(200);
      expect(res.body.topHashtags[0]).toEqual({ tag: "#Jaipur", posts: 2, avgEngagement: 0.04 });
      expect(res.body.topHashtags).toContainEqual({ tag: "#Politics", posts: 1, avgEngagement: 0.07 });
      expect(res.body.byDistrict).toEqual(expect.arrayContaining([{ district: "Jaipur", posts: 1, avgEngagement: 0.07 }, { district: null, posts: 1, avgEngagement: 0.01 }]));
      expect(res.body.byHour.find((x: { hour: number }) => x.hour === 10)).toEqual({ hour: 10, posts: 1, avgEngagement: 0.07 });
      expect(res.body.footageVsNot).toEqual({ withFootage: { posts: 1, avgEngagement: 0.01 }, without: { posts: 1, avgEngagement: 0.07 } });
      expect(res.body.modes.x).toBe("fake");
    });
  });
});
