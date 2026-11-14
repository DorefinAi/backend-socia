// Handle fixes F1 (14 Nov): migration 0029 types the existing Settings handles, and the posted-use count that ends a
// Settings handle's suggest-only period (G4). Needs TEST_DATABASE_URL (the database is wiped).

import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { handlePostedUses } from "../src/composer";
import { handleDirectory, publishedPosts } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";

(TEST_URL ? describe : describe.skip)("Settings handles (F1)", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
  });
  afterAll(async () => h?.close());

  it("0029 sets every untyped manual and Wikidata row to organisation, and leaves desk and reporter rows alone", async () => {
    const orgId = s.org.id;
    await h.db.insert(handleDirectory).values([
      { orgId, entityName: "Manual", handle: "ManualOne", source: "manual" },
      { orgId, entityName: "Promoted", handle: "PromotedOne", source: "wikidata:Q42" },
      { orgId, entityName: "Typed", handle: "TypedOne", source: "manual", entityType: "police" },
      { orgId, entityName: "Desk", handle: "DeskOne", source: "desk" },
      { orgId, entityName: "Reporter", handle: "ReporterOne", source: "reporter" },
    ]);
    // The migration's own data statement, as the migrator runs it (its last statement)
    const file = readFileSync(new URL("../migrations/0029_handle_type.sql", import.meta.url), "utf8");
    const update = file.split("--> statement-breakpoint").at(-1)!.trim();
    expect(update).toMatch(/^UPDATE "handle_directory" SET "entity_type" = 'organisation'/);
    await h.db.execute(sql.raw(update));
    const rows = await h.db.select({ handle: handleDirectory.handle, type: handleDirectory.entityType }).from(handleDirectory).where(eq(handleDirectory.orgId, orgId));
    expect(Object.fromEntries(rows.map((r) => [r.handle, r.type]))).toEqual({
      ManualOne: "organisation", PromotedOne: "organisation", TypedOne: "police", DeskOne: null, ReporterOne: null,
    });
  });

  it("the type column takes the six types only", async () => {
    await expect(h.db.insert(handleDirectory).values({ orgId: s.org.id, entityName: "Bad", handle: "BadType", source: "manual", entityType: "minister" })).rejects.toThrow();
  });

  it("posted uses: live published posts carrying the whole @handle, any case; recalled posts and longer handles do not count", async () => {
    // One draft per post: a draft has at most one live Copy & Posted record
    const post = async (text: string, recalled = false) => ({ orgId: s.org.id, draftId: (await s.draft()).id, platform: "x", text, ...(recalled && { recalledAt: new Date() }) });
    await h.db.insert(publishedPosts).values(await Promise.all([
      post("#Jaipur: जयपुर मेट्रो का किराया बढ़ा\n\n#RajasthanWithFirstIndia @JaipurMetro"),
      post("मेट्रो फेज 2 @jaipurmetro, @jaipur_police"),
      post("@JaipurMetroRail is another account"),
      post("recalled @JaipurMetro", true),
    ]));
    const uses = await handlePostedUses(h.db, s.org.id, ["@JaipurMetro", "jaipur_police", "NeverPosted", "bad'handle"]);
    expect(Object.fromEntries(uses)).toEqual({ jaipurmetro: 2, jaipur_police: 1, neverposted: 0, "bad'handle": 0 });
    // Another org's posts are not counted
    expect(Object.fromEntries(await handlePostedUses(h.db, crypto.randomUUID(), ["JaipurMetro"]))).toEqual({ jaipurmetro: 0 });
  });
});
