// End to end on a real Postgres and a real Chromium: a Kruti Dev file lands in a folder, and comes
// out as a posted X draft (to the fake X client). Needs TEST_DATABASE_URL.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveDraft, claimDraft, createDb, handleDirectory, hashtagRules, ingestedFiles, orgs, postDrafts, publishJobs,
  publishedPosts, runMigrations, stories, users, type DbHandle,
} from "@socia/db";
import { FakeXClient, FolderSource, LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBucket } from "../src/bucket";
import { CardRenderer } from "../src/card/renderer";
import { Dictionaries, composeNext } from "../src/stages/compose";
import { convertNext } from "../src/stages/convert";
import { Ingest } from "../src/stages/ingest";
import { Publisher, sameText } from "../src/stages/publish";
import { renderNext } from "../src/stages/render";

const URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });

describe("sameText", () => {
  it("ignores the t.co link X adds for media", () => {
    expect(sameText("खबर\n\n#Jaipur https://t.co/abc", "खबर\n\n#Jaipur")).toBe(true);
  });
});

(URL ? describe : describe.skip)("pipeline: share → draft → X", () => {
  let h: DbHandle;
  let renderer: CardRenderer;
  let dir: string;
  let orgId: string;

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: ["#1stIndiaNews"], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    await h.db.insert(hashtagRules).values({ orgId, matchType: "city", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 5 });
    await h.db.insert(handleDirectory).values({ orgId, entityName: "भजनलाल शर्मा", aliases: [], handle: "BhajanlalBjp", verifiedAt: new Date() });
    renderer = new CardRenderer(1);
    await renderer.start();
    dir = await mkdtemp(join(tmpdir(), "socia-e2e-"));
  }, 60_000);

  afterAll(async () => {
    await renderer?.close();
    await h?.close();
  });

  it("ingests, converts, composes, renders and posts", async () => {
    const share = join(dir, "share");
    const store = new LocalStorage(join(dir, "store"), "http://localhost/dev-files");
    await import("node:fs/promises").then((fs) => fs.mkdir(join(share, "breaking"), { recursive: true }));
    // Kruti Dev: "जयपुर मेट्रो को मंजूरी" / "मुख्यमंत्री भजनलाल शर्मा ने कहा।"
    await writeFile(join(share, "breaking", "JPR_METRO.txt"), Buffer.from("t;iqj esVªks dks eatwjh\r\neq[;ea=h Hktuyky 'kekZ us dgkA", "latin1"));
    await writeFile(join(share, "breaking", "JPR_METRO_01.jpg"), Buffer.from([0xff, 0xd8, 0xff]));

    let clock = Date.now();
    const ingest = new Ingest({ db: h.db, storage: store, source: new FolderSource(share), orgId, log, now: () => clock });
    expect(await ingest.scan()).toBe(0); // first sighting: wait for a stable size
    clock += 2500;
    expect(await ingest.scan()).toBe(2);
    clock += 2500;
    expect(await ingest.scan()).toBe(0); // nothing new

    expect(await convertNext(h.db, store, log)).toBe(true);
    const [story] = await h.db.select().from(stories);
    expect(story!.headline).toBe("जयपुर मेट्रो को मंजूरी");
    expect(story!.body).toBe("मुख्यमंत्री भजनलाल शर्मा ने कहा।");
    expect(story!.sourceEncoding).toBe("krutidev");
    expect(story!.mediaState).toBe("attached");

    expect(await composeNext(h.db, new Dictionaries(h.db, orgId), log)).toBe(true);
    let [draft] = await h.db.select().from(postDrafts);
    expect(draft!.status).toBe("rendering");
    // A shared-folder story has no district, so no "#Jaipur:" line; no topic rule matched, and the fixed brand tag is enough (no #FirstIndiaNews)
    expect(draft!.hashtags).toEqual(["#1stIndiaNews"]);
    expect(draft!.bodyText).toBe("जयपुर मेट्रो को मंजूरी\n\nमुख्यमंत्री भजनलाल शर्मा ने कहा।");
    expect(draft!.mentionSuggestions).toEqual([{ handleId: expect.any(String), entity: "भजनलाल शर्मा", handle: "@BhajanlalBjp", exact: true }]);

    expect(await renderNext(h.db, store, renderer, log)).toBe(true);
    [draft] = await h.db.select().from(postDrafts);
    expect(draft!.status).toBe("ready");
    expect(draft!.cardFontPx).toBeGreaterThanOrEqual(28);
    const png = await store.get(draft!.cardKey!);
    expect(png.subarray(1, 4).toString()).toBe("PNG");

    // an operator approves; skip the 10 s undo window
    const [priya] = await h.db.insert(users).values({ orgId, name: "Priya", email: "p@test", passwordHash: "x", role: "operator" }).returning();
    const actor = { id: priya!.id, orgId, name: "Priya", role: "operator" as const };
    const claimed = await claimDraft(h.db, actor, draft!.id);
    const { job } = await approveDraft(h.db, actor, draft!.id, claimed.version);
    await h.db.update(publishJobs).set({ nextAttemptAt: sql`now()` }).where(eq(publishJobs.id, job.id));

    const x = new FakeXClient("1stIndiaNews");
    const publisher = new Publisher({ db: h.db, storage: store, x, bucket: new MemoryBucket(10, 60), account: "1stIndiaNews", log, active: () => true });
    expect(await publisher.tick()).toBe(true);

    const [post] = await h.db.select().from(publishedPosts);
    expect(post!.permalink).toMatch(/^https:\/\/x\.com\/1stIndiaNews\/status\/\d+$/);
    expect(x.posts.get(post!.platformPostId)!.text).toBe("जयपुर मेट्रो को मंजूरी\n\nमुख्यमंत्री भजनलाल शर्मा ने कहा।\n\n#1stIndiaNews");
    expect((await h.db.select().from(ingestedFiles)).length).toBe(2);
  }, 60_000);

  it("does not post twice when a worker died after posting", async () => {
    const [draft] = await h.db.select().from(postDrafts).limit(1);
    const x = new FakeXClient("1stIndiaNews");
    const { id } = await x.createPost("एक पोस्ट\n\n#Jaipur", []);
    await h.db.update(postDrafts).set({ status: "queued", bodyText: "एक पोस्ट", hashtags: ["#Jaipur"], mentions: [] }).where(eq(postDrafts.id, draft!.id));
    const [job] = await h.db.insert(publishJobs).values({ orgId, draftId: draft!.id, attempts: 1, createdAt: new Date(Date.now() - 5_000) }).returning();

    const publisher = new Publisher({ db: h.db, storage: new LocalStorage(dir, ""), x, bucket: new MemoryBucket(10, 60), account: "a", log, active: () => true });
    await publisher.tick();
    const [done] = await h.db.select().from(publishJobs).where(eq(publishJobs.id, job!.id));
    expect(done!.platformPostId).toBe(id);
    expect(x.posts.size).toBe(1);
  }, 30_000);

  it("posts the operator's own card, and records which card went out", async () => {
    const store = new LocalStorage(join(dir, "store"), "http://localhost/dev-files");
    const auto = Buffer.from("auto card");
    const custom = Buffer.from("custom card");
    await store.put("cards/auto-2.png", auto, "image/png");
    await store.put("cards/x/custom-1.png", custom, "image/png");

    const [story] = await h.db.insert(stories).values({ orgId, slug: "custom_card", status: "composed", headline: "अपना कार्ड", body: "" }).returning();
    const [op] = await h.db.insert(users).values({ orgId, name: "Op", email: "op2@test", passwordHash: "x", role: "operator" }).returning();
    // the rendered card is behind an edit (not ready), but the operator's card is set
    const [draft] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: story!.id, status: "ready", bodyText: "अपना कार्ड", cardHeadline: "अपना कार्ड", composeVersion: "t", cardRev: 2, cardRenderedRev: 1, cardKey: "cards/auto-2.png", customCardKey: "cards/x/custom-1.png" })
      .returning();
    const actor = { id: op!.id, orgId, name: "Op", role: "operator" as const };
    const claimed = await claimDraft(h.db, actor, draft!.id);
    const { job } = await approveDraft(h.db, actor, draft!.id, claimed.version);
    await h.db.update(publishJobs).set({ nextAttemptAt: sql`now()` }).where(eq(publishJobs.id, job.id));

    const uploads: Buffer[] = [];
    class RecordingX extends FakeXClient {
      override async uploadImage(png?: Uint8Array): Promise<string> {
        uploads.push(Buffer.from(png!));
        return super.uploadImage();
      }
    }
    const x = new RecordingX("1stIndiaNews");
    const publisher = new Publisher({ db: h.db, storage: store, x, bucket: new MemoryBucket(10, 60), account: "1stIndiaNews", log, active: () => true });
    expect(await publisher.tick()).toBe(true);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.equals(custom)).toBe(true);
    const [post] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, draft!.id));
    expect(post).toMatchObject({ cardKey: "cards/x/custom-1.png", manual: false });
  }, 30_000);
});
