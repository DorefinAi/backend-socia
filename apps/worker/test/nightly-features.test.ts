// The nightly reporter features (reporter-prior brief §7.1) on their own loop: once per IST day, never twice, a
// failure retried an hour later, never thrown, escalated after three in a row and kept in kv; missed days logged.
// Needs TEST_DATABASE_URL (the database is wiped).

import { LOGIC_VERSION, createDb, getKv, orgs, postDecisions, postDrafts, reporterFeatures, runMigrations, stories, type DbHandle } from "@socia/db";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reporterPriorSettings } from "../src/config";
import { FEATURES_ERROR_KV, FEATURES_KV, NightlyFeatures } from "../src/stages/crons";
import { PriorCandidatesUnavailable } from "../src/data-files";

const URL_ = process.env.TEST_DATABASE_URL;

/** A pino logger whose lines are collected */
function capture() {
  const lines: { level: number; msg: string; [k: string]: unknown }[] = [];
  const log = pino({ level: "info" }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  return { log, lines, at: (level: "info" | "warn" | "error") => lines.filter((l) => l.level === { info: 30, warn: 40, error: 50 }[level]) };
}

describe("reporter prior settings", () => {
  it("defaults the cap to 30% and explore to 10%, and refuses a share outside 0..1", () => {
    const before = { ...process.env };
    try {
      delete process.env.REPORTER_PRIOR_CAP;
      delete process.env.REPORTER_PRIOR_EXPLORE;
      expect(reporterPriorSettings()).toEqual({ cap: 0.3, exploreRate: 0.1, smoothingM: 20 });
      process.env.REPORTER_PRIOR_CAP = "1.5";
      expect(() => reporterPriorSettings()).toThrow(/REPORTER_PRIOR_CAP must be a number from 0 to 1/);
    } finally {
      process.env = before;
    }
  });
});

(URL_ ? describe : describe.skip)("NightlyFeatures", () => {
  let h: DbHandle;
  let orgId = "";

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const [story] = await h.db.insert(stories).values({ orgId, slug: "s", status: "composed", headline: "h", body: "" }).returning();
    const [draft] = await h.db.insert(postDrafts).values({ orgId, storyId: story!.id, status: "published", bodyText: "h", cardHeadline: "h", composeVersion: "t" }).returning();
    await h.db.insert(postDecisions).values({
      orgId, draftId: draft!.id, storyId: story!.id, reporterToken: "RITURAJ", reporterHandle: "@Rituraj", reporterStatus: "matched", logicVersion: LOGIC_VERSION,
      composeVersion: "t", draftText: "h", proposals: [], decision: "copy_posted", decidedAt: new Date("2026-11-12T10:00:00Z"), finalText: "h #Jaipur",
      finalHashtags: ["#Jaipur"], finalHandles: [],
    });
  }, 60_000);
  afterAll(async () => h?.close());

  it("takes one snapshot per IST day, keyed by handle, and records the day", async () => {
    const { log } = capture();
    const job = new NightlyFeatures(h.db, h.pool, orgId, log);
    const morning = new Date("2026-11-13T00:30:00Z"); // 06:00 IST
    expect(await job.run(morning)).toBe(1);
    expect(await job.run(new Date(morning.getTime() + 30_000))).toBeNull();
    expect(await getKv(h.db, FEATURES_KV)).toMatchObject({ day: "2026-11-13", reporters: 1, written: 1 });
    expect((await h.db.select().from(reporterFeatures))[0]).toMatchObject({ reporter: "rituraj" });
    // A restarted worker reads the day back and does not run again
    expect(await new NightlyFeatures(h.db, h.pool, orgId, log).run(new Date(morning.getTime() + 3600_000))).toBeNull();
    // The next IST day; the loop tick itself always says "nothing more to do now"
    expect(await job.tick(new Date("2026-11-13T18:31:00Z"))).toBe(false);
    expect(await h.db.select().from(reporterFeatures)).toHaveLength(2);
  });

  it("logs the days it missed when it comes back", async () => {
    const { log, at } = capture();
    const job = new NightlyFeatures(h.db, h.pool, orgId, log);
    // Last ran for 2026-11-14 (above); back on the 17th: the 15th and 16th were missed
    expect(await job.run(new Date("2026-11-17T01:00:00Z"))).toBe(1);
    expect(at("warn")).toEqual([expect.objectContaining({ lastDay: "2026-11-14", today: "2026-11-17", missedDays: 2 })]);
  });

  it("never throws: a failure waits an hour, escalates to error from the third in a row, and is kept in kv", async () => {
    const { log, at } = capture();
    const broken = new NightlyFeatures(h.db, h.pool, "not-a-uuid", log);
    let t = new Date("2026-11-20T00:30:00Z").getTime();
    expect(await broken.run(new Date(t))).toBeNull();
    // The retry waits: nothing is tried, nothing logged
    expect(await broken.run(new Date(t + 60_000))).toBeNull();
    expect(at("warn")).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      t += 3600_000 + 1;
      expect(await broken.run(new Date(t))).toBeNull();
    }
    expect(at("warn")).toHaveLength(2);
    expect(at("error")).toHaveLength(1);
    expect(at("error")[0]).toMatchObject({ failures: 3 });
    expect(await getKv(h.db, FEATURES_ERROR_KV)).toMatchObject({ failures: 3, message: expect.any(String) });
  });

  it("R4: prior candidates that cannot be built (a broken directory file) or come back empty FAIL the run: no snapshot, retried hourly until it succeeds that day", async () => {
    const { log, at } = capture();
    const day = "2026-11-25";
    let candidates: () => Set<string> = () => {
      throw new PriorCandidatesUnavailable("the parties directory file did not load (party-handles.json): no prior candidates are built and no snapshot is written until it loads");
    };
    const job = new NightlyFeatures(h.db, h.pool, orgId, log, 20, async () => candidates());
    const rows = async () => (await h.db.select().from(reporterFeatures)).filter((r) => r.snapshotDate === day);
    const before = await getKv<{ day: string }>(h.db, FEATURES_KV);
    let t = new Date(`${day}T00:30:00Z`).getTime();

    expect(await job.run(new Date(t))).toBeNull();
    // Nothing written, the day not marked done: the previous day's snapshot stays the latest
    expect(await rows()).toEqual([]);
    expect(await getKv(h.db, FEATURES_KV)).toEqual(before);
    expect(at("warn").at(-1)!.msg).toMatch(/prior candidates could not be built, so no snapshot was taken; trying again in an hour/);
    expect(await getKv(h.db, FEATURES_ERROR_KV)).toMatchObject({ message: expect.stringMatching(/parties directory file did not load/) });
    // Not tried again within the hour
    let asked = 0;
    candidates = () => {
      asked++;
      return new Set<string>();
    };
    expect(await job.run(new Date(t + 30 * 60_000))).toBeNull();
    expect(asked).toBe(0);
    // An hour on: tried again; an EMPTY list is a failure too
    t += 3600_000 + 1;
    expect(await job.run(new Date(t))).toBeNull();
    expect(asked).toBe(1);
    expect(await rows()).toEqual([]);
    // Fixed: the next hourly try writes that day's snapshot, with its candidates
    candidates = () => new Set(["rajgovofficial"]);
    t += 3600_000 + 1;
    expect(await job.run(new Date(t))).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]!.features.prior).toMatchObject({ typed: true });
    expect(await getKv(h.db, FEATURES_KV)).toMatchObject({ day });
  });

  it("S2: a run that failed at 23:50 does not hold the next day back — it runs at 00:00 — and the missed day gives the real reason", async () => {
    const { log, at } = capture();
    // The last snapshot is 2026-11-25 (above). The 27th's runs fail all day, the last at 23:50 IST
    let candidates: () => Set<string> = () => {
      throw new PriorCandidatesUnavailable("the parties directory file did not load (party-handles.json)");
    };
    const job = new NightlyFeatures(h.db, h.pool, orgId, log, 20, async () => candidates());
    expect(await job.run(new Date("2026-11-27T18:20:00Z"))).toBeNull(); // 23:50 IST on the 27th
    candidates = () => new Set(["rajgovofficial"]);
    // 00:00 IST on the 28th, ten minutes later: the new day clears the hour's wait
    expect(await job.run(new Date("2026-11-27T18:30:00Z"))).toBe(1);
    expect(await getKv(h.db, FEATURES_KV)).toMatchObject({ day: "2026-11-28" });
    const missed = at("warn").filter((l) => /days with no snapshot/.test(l.msg));
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ lastDay: "2026-11-25", today: "2026-11-28", missedDays: 2, failedOn: "2026-11-27" });
    expect(missed[0]!.msg).toBe("reporter features: days with no snapshot — previous run failed: the parties directory file did not load (party-handles.json)");
    expect(at("warn").filter((l) => /worker was not running/.test(l.msg))).toEqual([]);
  });
});

describe("NightlyFeatures when the day marker cannot be read", () => {
  it("waits the hour after a failed kv read too: not retried (nor escalated) every minute", async () => {
    const { log, lines } = capture();
    // A database that fails every call: the kv read, and the kv write that records the failure
    let calls = 0;
    const dead = new Proxy({}, { get: () => () => { calls++; throw new Error("database down"); } });
    const job = new NightlyFeatures(dead as never, dead as never, "org", log);
    const t = new Date("2026-11-20T00:30:00Z").getTime();
    const failuresLogged = () => lines.filter((l) => /could not read when the reporter features last ran/.test(l.msg));
    expect(await job.run(new Date(t))).toBeNull();
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    // One tick a minute for the next 59 minutes: nothing tried, nothing logged
    for (let i = 1; i < 60; i++) expect(await job.run(new Date(t + i * 60_000))).toBeNull();
    expect(calls).toBe(afterFirst);
    expect(failuresLogged()).toHaveLength(1);
    expect(failuresLogged()[0]).toMatchObject({ level: 40, failures: 1 });
    // An hour on it is tried again: the second failure, still a warning
    expect(await job.run(new Date(t + 3600_000))).toBeNull();
    expect(calls).toBeGreaterThan(afterFirst);
    expect(failuresLogged()).toHaveLength(2);
    expect(failuresLogged()[1]).toMatchObject({ level: 40, failures: 2 });
  });
});
