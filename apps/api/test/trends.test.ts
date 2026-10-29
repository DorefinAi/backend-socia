// The Web Scraper API: list, live search, "fetch now", trend → X draft, and the publishers' pictures
// served through the API. The web is a fake serving recorded fixtures. Needs TEST_DATABASE_URL.

import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleNewsSearchUrl, type TrendRow } from "@socia/core";
import { assets, auditLog, createDb, getKv, hashtagRules, orgs, postDrafts, runMigrations, saveTrendRun, stories, trendRuns, users, type DbHandle } from "@socia/db";
import { LocalStorage, type WebGet } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { REFRESHES_PER_MINUTE, SEARCHES_PER_MINUTE, sniffImage } from "../src/routes/trends";

const URL = process.env.TEST_DATABASE_URL;
const fixture = (name: string) => readFileSync(join(__dirname, "../../../packages/core/test/fixtures/trends", name), "utf8");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const GIF = Buffer.from("GIF89a----------");

describe("sniffImage", () => {
  it("knows PNG, JPEG and WebP, nothing else", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
    expect(sniffImage(GIF)).toBeNull();
    expect(sniffImage(Buffer.from("<html>"))).toBeNull();
  });
});

const row = (r: Partial<TrendRow> & Pick<TrendRow, "title" | "rank">): TrendRow => ({
  type: "topics", window: "24h", url: `https://www.bhaskar.com/${r.rank}`, platform: "RSS", sourceName: "Dainik Bhaskar", reasonWhy: "", superTag: "Politics", subTag: "",
  district: null, volume: "", growth: "", shares: "", publishedAt: new Date(), imageUrl: null, imageSource: null, headline: r.title, summary: "", alert: null,
  clusterId: `c${r.rank}`, clusterRank: r.rank, sources: [], score: 0, ...r,
});

(URL ? describe : describe.skip)("trends API", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  const asked: string[] = [];
  const who = { op: { cookie: "", csrf: "" }, ed: { cookie: "", csrf: "" }, viewer: { cookie: "", csrf: "" } };
  type Who = (typeof who)["op"];
  const ids: Record<string, string> = {};

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null,
  };

  const web: WebGet = async (url) => {
    asked.push(url);
    const ok = (body: string | Buffer, contentType: string) => ({ status: 200, contentType, body: Buffer.isBuffer(body) ? body : Buffer.from(body), url });
    if (url === googleNewsSearchUrl("पंचायत चुनाव", "hi")) return ok(fixture("google-news-hi.xml"), "application/xml");
    if (url === googleNewsSearchUrl("पंचायत चुनाव", "en")) return ok(fixture("google-news-en.xml"), "application/xml");
    if (url === "https://img.example.in/lead.png") return ok(PNG, "image/png");
    if (url === "https://img.example.in/anim.gif") return ok(GIF, "image/gif");
    return { status: 429, contentType: "text/plain", body: Buffer.from("slow down"), url };
  };

  async function call(w: Who | null, method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers: w ? { cookie: w.cookie, "x-csrf": w.csrf } : {} });
    const json = res.headers["content-type"]?.toString().startsWith("application/json");
    return { status: res.statusCode, body: json && res.body ? JSON.parse(res.body) : null, raw: res };
  }

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: ["#RajasthanWithFirstIndia"], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    await h.db.insert(hashtagRules).values({ orgId, matchType: "district", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 5 });
    const passwordHash = await hashPassword("correct horse battery");
    await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash, role: "operator" },
      { orgId, name: "Ed", email: "ed@test", passwordHash, role: "editor" },
      { orgId, name: "View", email: "viewer@test", passwordHash, role: "viewer" },
    ]);
    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-trends-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config, web }, false);
    for (const [name, into] of Object.entries(who)) {
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${name}@test`, password: "correct horse battery" } });
      into.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
      into.csrf = JSON.parse(res.body).csrfToken;
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("is empty before the first run, and needs a session", async () => {
    expect(await call(who.viewer, "GET", "/trends")).toMatchObject({ status: 200, body: { items: [], fetchedAt: null, sources: [], alerts: [] } });
    expect((await call(null, "GET", "/trends")).status).toBe(401);
    expect((await call(who.viewer, "GET", "/trends?type=videos")).status).toBe(400);
  });

  it("lists the newest run's items, filtered, in the ScraperItem shape", async () => {
    const sources = [
      { name: "Google News (hi)", group: "News", ok: true, at: new Date().toISOString(), items: 10, itemsLastRun: 10, lastSuccessAt: new Date().toISOString() },
      { name: "GDELT", group: "Volume", ok: false, lastError: "Paused: GDELT asked us to slow down. Next try in about 2 min.", at: new Date().toISOString(), items: 0, itemsLastRun: 0, lastSuccessAt: null },
    ];
    await saveTrendRun(h.db, orgId, { trigger: "schedule", startedAt: new Date(Date.now() - 3600_000), sources: [] }, [row({ title: "पुराना", rank: 1 })]);
    const alerts = [{
      level: "orange" as const, text: "भारी बारिश की संभावना", event: "Heavy Rain", severity: "Severe", validFrom: null, validUntil: "2026-10-28T19:00:00.000Z",
      districts: ["Jaipur"], issuer: "IMD Jaipur", url: "https://sachet.ndma.gov.in/x", source: "NDMA Sachet" as const,
    }];
    const { items } = await saveTrendRun(h.db, orgId, { trigger: "schedule", startedAt: new Date(), sources, alerts }, [
      row({ title: "जयपुर हाईकोर्ट का फैसला", rank: 1, district: "Jaipur", alert: { level: "orange", title: "भारी बारिश की संभावना", validUntil: "2026-10-28T19:00:00.000Z" }, volume: "3 articles", shares: "2 publishers", reasonWhy: "हाईकोर्ट का फैसला (Dainik Bhaskar)", imageUrl: "https://img.example.in/lead.png", imageSource: "Dainik Bhaskar", summary: "अदालत ने सुनवाई के बाद आदेश दिया।" }),
      row({ title: "बारिश की चेतावनी", rank: 2, superTag: "Weather", platform: "Google News", sourceName: "Navbharat Times", imageUrl: "https://img.example.in/anim.gif" }),
      row({ title: "Investor caution", rank: 1, type: "articles" }),
    ]);
    ids.hc = items[0]!.id;
    ids.rain = items[1]!.id;
    ids.article = items[2]!.id;
    // A search run never replaces the desk's list
    await saveTrendRun(h.db, orgId, { trigger: "search", query: "x", startedAt: new Date(), sources: [] }, [row({ title: "search hit", rank: 1 })]);

    const res = await call(who.viewer, "GET", "/trends?type=topics&window=24h");
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual(sources);
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual(["जयपुर हाईकोर्ट का फैसला", "बारिश की चेतावनी"]);
    expect(res.body.items[0]).toEqual({
      id: ids.hc, rank: 1, title: "जयपुर हाईकोर्ट का फैसला", type: "topics", platform: "RSS", url: "https://www.bhaskar.com/1",
      engagementStats: { viewsOrVolume: "3 articles", growthRate: "", sharesOrPosts: "2 publishers" },
      reasonWhy: "हाईकोर्ट का फैसला (Dainik Bhaskar)", superTag: "Politics", subTag: "", timeFrame: "24h", scrapedAt: expect.any(String), publishedAt: expect.any(String),
      district: "Jaipur", sourceName: "Dainik Bhaskar", imageUrl: `/trends/${ids.hc}/image`, imageSource: "Dainik Bhaskar",
      alert: { level: "orange", title: "भारी बारिश की संभावना", validUntil: "2026-10-28T19:00:00.000Z" },
      // v2 (scraper-analytics-contract §A): the story, its sources (this row has none stored: its own), watch hits
      clusterId: "c1", sourceCount: 1, sources: [{ name: "Dainik Bhaskar", url: "https://www.bhaskar.com/1", publishedAt: expect.any(String) }], watchHits: [],
    });
    expect(res.body.alerts).toEqual([expect.objectContaining({ level: "orange", districts: ["Jaipur"], source: "NDMA Sachet" })]);
    expect((await call(who.viewer, "GET", "/trends?type=topics&superTag=Weather")).body.items.map((i: { id: string }) => i.id)).toEqual([ids.rain]);
    expect((await call(who.viewer, "GET", "/trends?platform=Google%20News")).body.items.map((i: { id: string }) => i.id)).toEqual([ids.rain]);
    expect((await call(who.viewer, "GET", `/trends?q=${encodeURIComponent("हाईकोर्ट")}`)).body.items.map((i: { id: string }) => i.id)).toEqual([ids.hc]);
    expect((await call(who.viewer, "GET", "/trends?q=%25")).body.items).toEqual([]);
    expect((await call(who.viewer, "GET", "/trends?type=articles")).body.items.map((i: { id: string }) => i.id)).toEqual([ids.article]);
  });

  it("searches Google News live, stores the results apart, and limits searches per user", async () => {
    asked.length = 0;
    const res = await call(who.op, "POST", "/trends/search", { q: "  पंचायत   चुनाव " });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i: { type: string; id: string }) => i.type === "articles" && /^[0-9a-f-]{36}$/.test(i.id))).toBe(true);
    expect(res.body.sources.map((s: { name: string; group: string; ok: boolean }) => [s.name, s.group, s.ok])).toEqual([
      ["Google News (hi)", "News", true], ["Google News (en)", "News", true], ["Bing News", "News", false], ["GDELT", "Volume", false],
    ]);
    expect(res.body.sources.at(-1).lastError).toBe("Too many requests: GDELT allows about one every 5 seconds. Pausing GDELT for 2 min.");
    expect(asked).toHaveLength(4);
    const [search] = await h.db.select().from(trendRuns).where(and(eq(trendRuns.trigger, "search"), eq(trendRuns.query, "पंचायत चुनाव")));
    expect(search).toBeTruthy();
    expect((await call(who.op, "GET", "/trends")).body.items[0].id).toBe(ids.hc);

    expect((await call(who.op, "POST", "/trends/search", { q: "a" })).status).toBe(400);
    expect((await call(null, "POST", "/trends/search", { q: "पंचायत चुनाव" })).status).toBe(401);
    for (let n = 1; n < SEARCHES_PER_MINUTE; n++) expect((await call(who.op, "POST", "/trends/search", { q: "पंचायत चुनाव" })).status).toBe(200);
    expect(await call(who.op, "POST", "/trends/search", { q: "पंचायत चुनाव" })).toMatchObject({ status: 429, body: { error: "rate_limited" } });
  });

  it("queues a run for editors, limited per minute", async () => {
    expect((await call(who.op, "POST", "/trends/refresh")).status).toBe(403);
    const noCsrf = await app.inject({ method: "POST", url: "/trends/refresh", headers: { cookie: who.ed.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    const res = await call(who.ed, "POST", "/trends/refresh");
    expect(res).toMatchObject({ status: 202, body: { queued: true } });
    expect(await getKv<{ at: string }>(h.db, `trends.refresh.${orgId}`)).toMatchObject({ at: expect.any(String) });
    for (let n = 1; n < REFRESHES_PER_MINUTE; n++) expect((await call(who.ed, "POST", "/trends/refresh")).status).toBe(202);
    expect((await call(who.ed, "POST", "/trends/refresh")).status).toBe(429);
  });

  it("turns a trend into a story and an X draft, once; no picture is attached", async () => {
    expect(await call(who.op, "POST", `/trends/${ids.hc}/draft`, { platform: "instagram" })).toMatchObject({ status: 400, body: { error: "platform_not_supported" } });
    expect((await call(who.op, "POST", `/trends/${ids.hc}/draft`, {})).status).toBe(400);
    expect((await call(who.viewer, "POST", `/trends/${ids.hc}/draft`, { platform: "x" })).status).toBe(403);
    expect((await call(who.op, "POST", `/trends/00000000-0000-0000-0000-000000000000/draft`, { platform: "x" })).status).toBe(404);

    const res = await call(who.op, "POST", `/trends/${ids.hc}/draft`, { platform: "x" });
    expect(res).toMatchObject({ status: 200, body: { draftId: expect.any(String), created: true } });
    const draftId = res.body.draftId;
    const [d] = await h.db.select({ d: postDrafts, s: stories }).from(postDrafts).innerJoin(stories, eq(stories.id, postDrafts.storyId)).where(eq(postDrafts.id, draftId));
    expect(d!.s).toMatchObject({ source: "trend", status: "composed", mediaState: "none", district: "Jaipur", headline: "जयपुर हाईकोर्ट का फैसला", body: "अदालत ने सुनवाई के बाद आदेश दिया।" });
    expect(d!.d).toMatchObject({ status: "rendering", platform: "x", hashtags: ["#RajasthanWithFirstIndia"] });
    expect(d!.d.bodyText).toBe("#Jaipur: जयपुर हाईकोर्ट का फैसला\n\nअदालत ने सुनवाई के बाद आदेश दिया।");
    expect(await h.db.select().from(assets).where(eq(assets.storyId, d!.s.id))).toEqual([]);
    const [a] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "trend.drafted"), eq(auditLog.entityId, draftId)));
    expect(a!.after).toMatchObject({ trendItemId: ids.hc, url: "https://www.bhaskar.com/1" });

    // The desk's draft view works for a trend story
    const view = await call(who.op, "GET", `/drafts/${draftId}`);
    expect(view.body.story).toMatchObject({ source: "trend", priority: "normal", category: null, external: null });
    // Drafting the same news again gives the same draft
    expect((await call(who.op, "POST", `/trends/${ids.hc}/draft`, { platform: "x" })).body).toEqual({ draftId, created: false });

    // Once rendered it is in the X queue like any other draft
    await h.db.update(postDrafts).set({ status: "ready", cardRenderedRev: 1, cardKey: "cards/t.png" }).where(eq(postDrafts.id, draftId));
    const queue = await call(who.op, "GET", "/x/queue");
    expect(queue.body.items.find((i: { id: string }) => i.id === draftId)).toMatchObject({ source: "trend", district: "Jaipur", priority: "normal", category: null });
  });

  it("serves the publisher's picture through the API, fetched once; refuses anything that is not PNG/JPEG/WebP", async () => {
    asked.length = 0;
    expect((await call(null, "GET", `/trends/${ids.hc}/image`)).status).toBe(401);
    const first = await call(who.viewer, "GET", `/trends/${ids.hc}/image`);
    expect(first.status).toBe(200);
    expect(first.raw.headers["content-type"]).toBe("image/png");
    expect(first.raw.rawPayload.equals(PNG)).toBe(true);
    const again = await call(who.viewer, "GET", `/trends/${ids.hc}/image`);
    expect(again.status).toBe(200);
    expect(asked.filter((u) => u === "https://img.example.in/lead.png")).toHaveLength(1);

    expect((await call(who.viewer, "GET", `/trends/${ids.rain}/image`)).status).toBe(404);
    expect((await call(who.viewer, "GET", `/trends/${ids.rain}/image`)).status).toBe(404);
    expect(asked.filter((u) => u === "https://img.example.in/anim.gif")).toHaveLength(1);
    expect((await call(who.viewer, "GET", `/trends/${ids.article}/image`)).status).toBe(404);
  });
});
