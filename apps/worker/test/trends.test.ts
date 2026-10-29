// The Web Scraper job on a real Postgres, with the sources served from recorded fixtures (no network):
// a run at start, og:image read once per article page ever, the desk's "fetch now", and pruning.
// Needs TEST_DATABASE_URL.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { googleNewsSearchUrl, googleTrendsUrl, type SourcePlan } from "@socia/core";
import { createDb, orgs, requestTrendRefresh, runMigrations, trendItems, trendRuns, users, type DbHandle } from "@socia/db";
import type { WebGet } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TrendsJob } from "../src/stages/trends";

const URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });
const fixture = (name: string) => readFileSync(join(__dirname, "../../../packages/core/test/fixtures/trends", name), "utf8");

const plan: SourcePlan = {
  googleNews: { hi: "राजस्थान", en: "Rajasthan" },
  feeds: [{ name: "Amar Ujala", url: "https://feeds.example/amarujala.xml", rajasthan: true }, { name: "Times of India", url: "https://feeds.example/toi.xml", rajasthan: true }],
  geo: "IN",
  gdelt: true,
};

/** Serves the fixtures; every Amar Ujala article page has an og:image; GDELT answers 429 as it did on the day */
function fakeWeb() {
  const asked: string[] = [];
  const feeds: Record<string, string> = {
    [googleNewsSearchUrl("राजस्थान", "hi")]: fixture("google-news-hi.xml"),
    [googleNewsSearchUrl("Rajasthan", "en")]: fixture("google-news-en.xml"),
    "https://feeds.example/amarujala.xml": fixture("amarujala-rajasthan.xml"),
    "https://feeds.example/toi.xml": fixture("toi-jaipur.xml"),
    [googleTrendsUrl("IN")]: fixture("google-trends-in.xml"),
  };
  const get: WebGet = async (url) => {
    asked.push(url);
    const ok = (body: string, contentType: string) => ({ status: 200, contentType, body: Buffer.from(body), url });
    if (feeds[url]) return ok(feeds[url]!, "application/xml");
    if (url.startsWith("https://www.amarujala.com/")) return ok(`<html><head><meta property="og:image" content="/img/${asked.length}.jpg"></head></html>`, "text/html; charset=utf-8");
    if (url.includes("gdeltproject")) return { status: 429, contentType: "text/plain", body: Buffer.from("Please limit requests"), url };
    return { status: 404, contentType: "text/html", body: Buffer.alloc(0), url };
  };
  return { get, asked };
}

(URL ? describe : describe.skip)("trends job", () => {
  let h: DbHandle;
  let orgId = "";
  let userId = "";
  let clock = new Date("2026-10-28T18:00:00Z");

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const [u] = await h.db.insert(users).values({ orgId, name: "Ed", email: "ed@test", passwordHash: "x", role: "editor" }).returning();
    userId = u!.id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it("runs at start, stores the ranked items and how each source did", async () => {
    const web = fakeWeb();
    const job = new TrendsJob({ db: h.db, orgId, get: web.get, settings: { pollMs: 900_000, plan, ogMaxPerRun: 30 }, log, now: () => clock });
    await job.tick();
    const [run] = await h.db.select().from(trendRuns);
    expect(run).toMatchObject({ trigger: "startup" });
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.sources.map((s) => [s.name, s.ok])).toEqual([
      ["Google News (hi)", true], ["Google News (en)", true], ["Amar Ujala", true], ["Times of India", true], ["Google Trends", true], ["GDELT", false],
    ]);
    expect(run!.sources.at(-1)!.lastError).toBe("Too many requests: GDELT allows about one every 5 seconds. Pausing GDELT for 2 min.");
    expect(run!.sources[0]).toMatchObject({ ok: true, itemsLastRun: expect.any(Number), lastSuccessAt: run!.sources[0]!.at });
    const items = await h.db.select().from(trendItems).where(eq(trendItems.runId, run!.id));
    expect(items.length).toBe(run!.itemCount);
    for (const type of ["topics", "articles", "hashtags"]) {
      const ranks = items.filter((i) => i.type === type && i.window === "24h").map((i) => i.rank).sort((a, b) => a - b);
      expect(ranks.length).toBeGreaterThan(0);
      expect(ranks.length).toBeLessThanOrEqual(20);
      expect(ranks).toEqual(ranks.map((_, i) => i + 1));
    }

    // Each feed once; Amar Ujala article pages once each for og:image; Google News links are never read
    const feedAsks = web.asked.filter((u) => !u.startsWith("https://www.amarujala.com/"));
    expect(feedAsks).toHaveLength(6);
    const pages = web.asked.filter((u) => u.startsWith("https://www.amarujala.com/"));
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages.length).toBeGreaterThan(0);
    expect(web.asked.some((u) => u.startsWith("https://news.google.com/rss/articles/"))).toBe(false);
    const withPage = items.filter((i) => i.url.startsWith("https://www.amarujala.com/"));
    const fresh = await h.db.select().from(trendItems).where(eq(trendItems.id, withPage[0]!.id));
    expect(fresh[0]).toMatchObject({ ogChecked: true, imageSource: "Amar Ujala" });
    expect(fresh[0]!.imageUrl).toMatch(/^https:\/\/www\.amarujala\.com\/img\/\d+\.jpg$/);
  });

  it("does not run again before it is due, never re-reads a page, and runs when the desk asks", async () => {
    const web = fakeWeb();
    const job = new TrendsJob({ db: h.db, orgId, get: web.get, settings: { pollMs: 900_000, plan, ogMaxPerRun: 30 }, log, now: () => clock });
    await job.tick(); // a new process: its first tick is a startup run
    expect(web.asked.filter((u) => u.startsWith("https://www.amarujala.com/"))).toEqual([]);
    const runs = await h.db.select().from(trendRuns);
    expect(runs).toHaveLength(2);
    const latest = await h.db.select().from(trendItems).where(eq(trendItems.runId, runs.find((r) => r.id !== runs[0]!.id && r.trigger === "startup")!.id));
    expect(latest.filter((i) => i.url.startsWith("https://www.amarujala.com/")).every((i) => i.ogChecked && i.imageUrl)).toBe(true);

    web.asked.length = 0;
    clock = new Date(clock.getTime() + 60_000);
    await job.tick();
    expect(web.asked).toEqual([]);

    clock = new Date(clock.getTime() + 1000);
    await requestTrendRefresh(h.db, orgId, userId);
    clock = new Date(clock.getTime() + 1000);
    await job.tick();
    const manual = await h.db.select().from(trendRuns).where(eq(trendRuns.trigger, "manual"));
    expect(manual).toHaveLength(1);

    clock = new Date(clock.getTime() + 900_000);
    await job.tick();
    expect(await h.db.select().from(trendRuns).where(eq(trendRuns.trigger, "schedule"))).toHaveLength(1);
  });

  it("prunes runs older than 7 days, with their items", async () => {
    await h.db.update(trendRuns).set({ startedAt: sql`now() - interval '8 days'` }).where(eq(trendRuns.trigger, "startup"));
    const job = new TrendsJob({ db: h.db, orgId, get: fakeWeb().get, settings: { pollMs: 900_000, plan, ogMaxPerRun: 0 }, log, now: () => clock });
    await job.run("manual");
    const runs = await h.db.select().from(trendRuns);
    expect(runs.some((r) => r.trigger === "startup")).toBe(false);
    const orphans = await h.db.execute(sql`SELECT count(*)::int AS n FROM trend_items i LEFT JOIN trend_runs r ON r.id = i.run_id WHERE r.id IS NULL`);
    expect((orphans.rows[0] as { n: number }).n).toBe(0);
  });
});
