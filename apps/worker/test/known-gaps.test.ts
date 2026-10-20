// Regression tests for the gaps found in the 20 Oct 2026 review, all fixed since. Each note says what
// used to go wrong; a failure here is a bug in src/, not in the test. Needs TEST_DATABASE_URL (the database is wiped).

import { createDb, ingestedFiles, orgs, postDrafts, runMigrations, stories, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CardRenderer } from "../src/card/renderer";
import { renderNext } from "../src/stages/render";

const URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });

(URL ? describe : describe.skip)("known gaps: render", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
  });
  afterAll(async () => h?.close());

  // Was: a card that cannot be drawn is retried every 30 s forever. The draft stays `rendering`, which
  // no queue view shows, so the story silently never reaches an operator. `render_failed` (shown in
  // the Failed view) exists in the state machine but nothing ever sets it.
  it("gives up on a card that keeps failing and shows it in the Failed view", async () => {
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    const [file] = await h.db.insert(ingestedFiles).values({ orgId: org!.id, sha256: "s", sourcePath: "/a.txt", fileName: "a.txt", bytes: 1, storageKey: "raw/a", kind: "text", slug: "a" }).returning();
    const [story] = await h.db.insert(stories).values({ orgId: org!.id, fileId: file!.id, slug: "a", status: "composed", headline: "h", body: "" }).returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({ orgId: org!.id, storyId: story!.id, status: "rendering", bodyText: "h", cardHeadline: "h", hashtags: [], composeVersion: "t" })
      .returning();

    const broken = { render: async () => { throw new Error("font file missing"); } } as unknown as CardRenderer;
    const storage = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-gap-")), "");
    for (let attempt = 0; attempt < 10; attempt++) {
      await renderNext(h.db, storage, broken, log);
      await h.db.update(postDrafts).set({ renderLeaseUntil: null }).where(eq(postDrafts.id, draft!.id)); // skip the 30 s wait
    }
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, draft!.id));
    expect(row!.renderError).toContain("font file missing");
    expect(row!.status).toBe("render_failed");
  });
});
