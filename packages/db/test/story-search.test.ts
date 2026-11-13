// story_search: the match ranks, the sweep's upsert guard and the hand-run rollback of 0025.
// The database parts need TEST_DATABASE_URL (the database is wiped).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrate";
import { orgs, stories, storySearch } from "../src/schema";
import { matchOfRank, syncStorySearch } from "../src/search";
import { TEST_URL, freshDb } from "./helpers";

const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

describe("matchOfRank", () => {
  it("maps every rank and refuses anything else", () => {
    expect([4, 3, 2, 1].map(matchOfRank)).toEqual(["text", "translated", "translated", "phonetic"]);
    for (const bad of [0, 5, 2.5, Number.NaN]) expect(() => matchOfRank(bad)).toThrow(/unknown match rank/);
  });
});

(TEST_URL ? describe : describe.skip)("story_search sweep and 0025 rollback", () => {
  let h: DbHandle;
  let storyId = "";
  beforeAll(async () => {
    h = await freshDb();
    const [org] = await h.db.insert(orgs).values({ name: "A", settings }).returning();
    const [s] = await h.db.insert(stories).values({ orgId: org!.id, slug: "s", status: "composed", headline: "जयपुर में बारिश", body: "" }).returning();
    storyId = s!.id;
  }, 60_000);
  afterAll(async () => h?.close());

  const rows = async (q: ReturnType<typeof sql>) => (await h.db.execute(q)).rows as Record<string, unknown>[];

  it("never overwrites a row built from a newer version of the story", async () => {
    expect(await syncStorySearch(h.db)).toMatchObject({ written: 1 });
    // The row claims a newer source than the story: an older sweep result must not replace it
    await h.db.update(storySearch).set({ searchText: " newer ", sourceUpdatedAt: sql`now() + interval '1 hour'` }).where(eq(storySearch.storyId, storyId));
    expect(await syncStorySearch(h.db)).toMatchObject({ candidates: 0 });
    const [row] = await h.db.select().from(storySearch).where(eq(storySearch.storyId, storyId));
    expect(row!.searchText).toBe(" newer ");
  });

  it("the rollback drops story_search and stories_updated_idx, and migrates forward again", async () => {
    await h.pool.query(await readFile(join(MIGRATIONS_DIR, "down", "0025_story_search.down.sql"), "utf8"));
    expect(await rows(sql`SELECT to_regclass('public.story_search') AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT indexname FROM pg_indexes WHERE indexname = 'stories_updated_idx'`)).toEqual([]);
    await runMigrations(TEST_URL!);
    expect(await rows(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'story_search' ORDER BY indexname`)).toEqual([
      { indexname: "story_search_key_trgm" },
      { indexname: "story_search_org_created_idx" },
      { indexname: "story_search_pkey" },
      { indexname: "story_search_text_trgm" },
    ]);
    expect(await syncStorySearch(h.db)).toMatchObject({ written: 1 });
  });
});
