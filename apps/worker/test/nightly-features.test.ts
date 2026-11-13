// The maintenance loop's nightly reporter features (reporter-prior brief §7.1): once per IST day, never twice,
// a failure retried an hour later and never thrown. Needs TEST_DATABASE_URL (the database is wiped).

import { LOGIC_VERSION, createDb, getKv, orgs, postDecisions, postDrafts, reporterFeatures, runMigrations, stories, type DbHandle } from "@socia/db";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURES_KV, NightlyFeatures } from "../src/stages/crons";
import { reporterPriorSettings } from "../src/config";

const URL_ = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });

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
      orgId, draftId: draft!.id, storyId: story!.id, reporterToken: "RITURAJ", reporterStatus: "matched", logicVersion: LOGIC_VERSION, composeVersion: "t",
      draftText: "h", proposals: [], decision: "copy_posted", decidedAt: new Date("2026-11-12T10:00:00Z"), finalText: "h #Jaipur", finalHashtags: ["#Jaipur"], finalHandles: [],
    });
  }, 60_000);
  afterAll(async () => h?.close());

  it("takes one snapshot per IST day and records the day", async () => {
    const job = new NightlyFeatures(h.db, orgId, log);
    const morning = new Date("2026-11-13T00:30:00Z"); // 06:00 IST
    expect(await job.tick(morning)).toBe(1);
    expect(await job.tick(new Date(morning.getTime() + 30_000))).toBeNull();
    expect(await getKv(h.db, FEATURES_KV)).toMatchObject({ day: "2026-11-13", reporters: 1 });
    // A restarted worker reads the day back and does not run again
    expect(await new NightlyFeatures(h.db, orgId, log).tick(new Date(morning.getTime() + 3600_000))).toBeNull();
    // The next IST day
    expect(await job.tick(new Date("2026-11-13T18:31:00Z"))).toBe(1);
    expect(await h.db.select().from(reporterFeatures)).toHaveLength(2);
  });

  it("never throws: a failure waits an hour", async () => {
    const broken = new NightlyFeatures(h.db, "not-a-uuid", log);
    const at = new Date("2026-11-20T00:30:00Z");
    expect(await broken.tick(at)).toBeNull();
    // The retry waits; nothing reaches the database meanwhile
    expect(await broken.tick(new Date(at.getTime() + 60_000))).toBeNull();
  });
});
