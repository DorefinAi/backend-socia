// Web Scraper v2 (stories, districts, keyword watches), handoff/scraper-analytics-contract.md §A.
// Needs TEST_DATABASE_URL (the database is wiped).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrendRow } from "@socia/core";
import { createDb, orgs, runMigrations, saveTrendRun, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL = process.env.TEST_DATABASE_URL;
const now = Date.now();
const ago = (h: number) => new Date(now - h * 3600_000);

const row = (r: Partial<TrendRow> & Pick<TrendRow, "title" | "rank" | "clusterId" | "clusterRank">): TrendRow => ({
  type: "articles", window: "24h", url: `https://news.example.in/${r.rank}`, platform: "RSS", sourceName: "Rajasthan Patrika", reasonWhy: "", superTag: "General", subTag: "",
  district: null, volume: "", growth: "", shares: "", publishedAt: ago(2), imageUrl: null, imageSource: null, headline: r.title, summary: "", alert: null, sources: [], score: 0, ...r,
});

(URL ? describe : describe.skip)("Web Scraper v2 API", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  const who = { op: { cookie: "", csrf: "", id: "" }, ed: { cookie: "", csrf: "", id: "" }, viewer: { cookie: "", csrf: "", id: "" } };
  type Who = (typeof who)["op"];

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3006"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
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
});
