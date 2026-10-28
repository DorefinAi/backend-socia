// SOURCE_MODE=samvadia on a real Postgres: approved stories in a Samvadia-shaped schema become Socia
// stories once (story id + version), footage is copied from a folder with the FTP's layout (photos;
// videos only recorded; caps and types respected), late footage still attaches, and the story goes on
// through compose → render → approve → fake X. Needs TEST_DATABASE_URL (the database is wiped).

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SamvadiaReader, approveDraft, assets, bodyFromDescription, claimDraft, createDb, getKv, hashtagRules, mapStory, orgs, postDrafts,
  publishJobs, publishedPosts, readIngestStatus, runMigrations, setKv, stories, users, type DbHandle,
} from "@socia/db";
import { FakeXClient, FolderFootage, LocalStorage } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryBucket } from "../src/bucket";
import { CardRenderer } from "../src/card/renderer";
import { Dictionaries, composeNext } from "../src/stages/compose";
import { Publisher } from "../src/stages/publish";
import { renderNext } from "../src/stages/render";
import { CURSOR_KEY, SamvadiaIngest } from "../src/stages/samvadia";

const URL = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });
const SCHEMA = "samvadia_fixture";

describe("mapping a Samvadia story", () => {
  const base = {
    id: "s1", itemId: "i1", version: 1, kind: "original", slug: "261026_BRN_DHAN_AV_MUKESH", title: "261026_BRN_DHAN_AV_MUKESH",
    description: "((पिछला संस्करण रद्द करें: X))\n\nबारां:\n\nपहला वाक्य। दूसरा वाक्य।\n\nसंवाददाता: मुकेश मीणा, बारां ब्यूरो",
    district: "Baran", guid: "g", publishedAt: new Date(), headline: "", body: "", reporterSlug: "MUKESH", districtCode: "BRN",
    itemKind: "story", footageStatus: "found", footagePath: "/BARAN/x/", footageFiles: [],
  };

  it("keeps only the body from the feed description", () => {
    expect(bodyFromDescription(base.description)).toBe("पहला वाक्य। दूसरा वाक्य।");
  });

  it("falls back to the body's first sentence for a missing headline, and dedupes on id + version", () => {
    const m = mapStory({ ...base, version: 2, kind: "update" });
    expect(m.headline).toBe("पहला वाक्य।");
    expect(m.body).toBe("पहला वाक्य। दूसरा वाक्य।");
    expect(m.externalId).toBe("s1:v2");
    expect(m.district).toBe("Baran");
    expect(m.parseNote).toMatch(/no headline/);
  });

  it("uses Samvadia's own headline and body when it has them", () => {
    const m = mapStory({ ...base, headline: "धान की बंपर आवक", body: "मंडी में आवक।" });
    expect([m.headline, m.body, m.parseNote]).toEqual(["धान की बंपर आवक", "मंडी में आवक।", null]);
  });
});

(URL ? describe : describe.skip)("samvadia source", () => {
  let h: DbHandle;
  let orgId: string;
  let dir: string;
  let footageRoot: string;
  let store: LocalStorage;
  let reader: SamvadiaReader;
  let clock = Date.now();

  // The pg pool under drizzle: plain SQL with parameters for the fixture schema
  const q = (text: string, params: unknown[] = []) => (h.db as unknown as { $client: { query: (t: string, p: unknown[]) => Promise<unknown> } }).$client.query(text, params);

  async function approve(opts: { d?: string; district?: string; subject: string; headline: string; body: string; path?: string | null; publishedAt?: Date; itemKind?: string; storyState?: string }) {
    const itemId = randomUUID();
    const storyId = randomUUID();
    const slug = `271026_${opts.d ?? "BRN"}_${opts.subject}_AV_MUKESH`;
    await q(`INSERT INTO ${SCHEMA}.items (id, headline, body, reporter_slug, district_code, kind, footage_status, footage_path) VALUES ($1,$2,$3,'MUKESH',$4,$5,$6,$7)`, [
      itemId, opts.headline, opts.body, opts.d ?? "BRN", opts.itemKind ?? "story", opts.path ? "found" : "waiting", opts.path ?? null,
    ]);
    await q(`INSERT INTO ${SCHEMA}.stories (id, item_id, version, kind, slug, title, description, district, guid, state, published_at) VALUES ($1,$2,1,'original',$3::text,$3::text,$4,$5,$6,$7,$8)`, [
      storyId, itemId, slug, `बारां:\n\n${opts.body}\n\nसंवाददाता: मुकेश, बारां ब्यूरो`, opts.district ?? "Baran", `vartmaan-${storyId}-v1`, opts.storyState ?? "ready", opts.publishedAt ?? new Date(),
    ]);
    return { itemId, storyId, slug };
  }

  async function addVersion(itemId: string, version: number, kind: "update" | "kill", slug: string) {
    const id = randomUUID();
    await q(`INSERT INTO ${SCHEMA}.stories (id, item_id, version, kind, slug, title, description, district, guid, state, published_at) VALUES ($1,$2,$3,$4,$5::text,$5::text,'x','Baran',$6,'ready',now())`, [
      id, itemId, version, kind, slug, `vartmaan-${id}-v${version}`,
    ]);
    return id;
  }

  async function footage(path: string, files: Record<string, number | string>) {
    const full = join(footageRoot, ...path.split("/").filter(Boolean));
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(full, name, ".."), { recursive: true });
      await writeFile(join(full, name), typeof content === "number" ? Buffer.alloc(content, 1) : content);
    }
  }

  const ingest = (overrides: Partial<ConstructorParameters<typeof SamvadiaIngest>[0]> = {}) =>
    new SamvadiaIngest({
      db: h.db, storage: store, reader, footage: new FolderFootage(footageRoot), orgId, log,
      media: { types: ["jpg", "jpeg", "png", "mp4"], maxBytes: 1000, video: false }, rescanMs: 60_000, backfillHours: 24, now: () => clock,
      ...overrides,
    });

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql.raw(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA public;`));
    await runMigrations(URL!);
    // Samvadia's two tables, only the columns Socia reads
    await h.db.execute(sql.raw(`CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.items (id uuid PRIMARY KEY, headline text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', reporter_slug text,
        district_code varchar(8), kind varchar(16) NOT NULL DEFAULT 'story', footage_status varchar(16) NOT NULL DEFAULT 'not_checked',
        footage_path text, footage_files jsonb NOT NULL DEFAULT '[]'::jsonb);
      CREATE TABLE ${SCHEMA}.stories (id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES ${SCHEMA}.items(id), version int NOT NULL, kind varchar(16) NOT NULL,
        slug varchar(96) NOT NULL, title text NOT NULL, description text NOT NULL, district text NOT NULL, guid text NOT NULL UNIQUE,
        state varchar(16) NOT NULL, published_at timestamptz, UNIQUE (item_id, version));`));
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: ["#1stIndiaNews"], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    await h.db.insert(hashtagRules).values({ orgId, matchType: "district", name: "बारां", aliases: ["Baran"], hashtagLatin: "Baran", hashtagDevanagari: "बारां", priority: 5 });
    dir = await mkdtemp(join(tmpdir(), "socia-samvadia-"));
    footageRoot = join(dir, "ftp");
    store = new LocalStorage(join(dir, "store"), "http://localhost/dev-files");
    reader = new SamvadiaReader(URL!, { schema: SCHEMA });
  }, 60_000);

  afterAll(async () => {
    await reader?.close();
    await h?.db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)).catch(() => undefined);
    await h?.close();
  });

  it("reads through a session that refuses writes", async () => {
    expect(await reader.sessionIsReadOnly()).toBe(true);
    const pool = (reader as unknown as { pool: { query: (s: string) => Promise<unknown> } }).pool;
    await expect(pool.query(`INSERT INTO items (id) VALUES (gen_random_uuid())`)).rejects.toThrow(/read-only transaction/);
    await expect(pool.query(`UPDATE stories SET state = 'waiting'`)).rejects.toThrow(/read-only transaction/);
  });

  it("takes ready originals, updates and press releases; not kills, waiting stories or day plans", async () => {
    const a = await approve({ subject: "DHAN", headline: "मंडी में धान की बंपर आवक", body: "किसानों को अच्छे दाम मिले।", path: "/BARAN/oct2026/27102026/271026_BRN_DHAN_AV_MUKESH/" });
    await addVersion(a.itemId, 2, "update", a.slug);
    await addVersion(a.itemId, 3, "kill", a.slug);
    await approve({ subject: "WAIT", headline: "इंतजार", body: "अभी फीड में नहीं।", storyState: "waiting" });
    await approve({ subject: "PLAN", headline: "आज का प्लान", body: "बैठक।", itemKind: "day_plan" });
    await approve({ subject: "PR", headline: "प्रेस नोट", body: "सरकार की घोषणा।", itemKind: "press_release" });
    const { fresh } = await reader.storiesSince({ publishedAt: new Date(0).toISOString(), storyId: "00000000-0000-0000-0000-000000000000" }, 600_000, 100);
    expect(fresh.map((s) => `${s.slug.split("_")[2]}:${s.kind}:${s.version}`).sort()).toEqual(["DHAN:original:1", "DHAN:update:2", "PR:original:1"]);
    // Oldest first, by (published_at, id)
    const keys = fresh.map((s) => `${new Date(s.publishedAt).toISOString()}|${s.id}`);
    expect([...keys].sort()).toEqual(keys);
    // Clean slate for the ingest tests
    await q(`DELETE FROM ${SCHEMA}.stories; DELETE FROM ${SCHEMA}.items;`);
  });

  it("turns approved stories into Socia stories once, and copies footage photos-first", async () => {
    const path = "/BARAN/oct2026/27102026/271026_BRN_MANDI_AV_MUKESH/";
    await footage(path, { "271026_BRN_MANDI_AV_MUKESH_01.jpg": 100, "271026_BRN_MANDI_AV_MUKESH_02.jpg": 200, "271026_BRN_MANDI_AV_MUKESH.mp4": 300, "big.jpg": 5000, "clip.xml": "<x/>", "VISUALS/raw.mp4": 50 });
    const a = await approve({ subject: "MANDI", headline: "मंडी में धान की बंपर आवक", body: "किसानों को अच्छे दाम मिले।", path });
    const run = ingest();

    expect(await run.poll()).toBe(1); // the story; footage waits for a second, stable look
    const [story] = await h.db.select().from(stories);
    expect(story).toMatchObject({ source: "samvadia", status: "converted", externalId: `${a.storyId}:v1`, district: "Baran", headline: "मंडी में धान की बंपर आवक", fileId: null, mediaState: "awaiting" });
    expect(story!.external).toMatchObject({ itemId: a.itemId, version: 1, footagePath: path, reporter: "MUKESH", districtCode: "BRN" });
    expect(await getKv(h.db, CURSOR_KEY)).toMatchObject({ storyId: a.storyId });

    clock += 2500;
    expect(await run.poll()).toBe(5);
    const media = await h.db.select().from(assets).where(eq(assets.storyId, story!.id));
    const by = Object.fromEntries(media.map((m) => [m.fileName, m]));
    expect(Object.keys(by).sort()).toEqual(["271026_BRN_MANDI_AV_MUKESH.mp4", "271026_BRN_MANDI_AV_MUKESH_01.jpg", "271026_BRN_MANDI_AV_MUKESH_02.jpg", "big.jpg", "raw.mp4"]);
    expect(by["271026_BRN_MANDI_AV_MUKESH_01.jpg"]).toMatchObject({ kind: "image", skipReason: null, bytes: 100, attachedBy: "footage" });
    expect((await store.get(by["271026_BRN_MANDI_AV_MUKESH_01.jpg"]!.storageKey!)).length).toBe(100);
    expect(by["271026_BRN_MANDI_AV_MUKESH.mp4"]).toMatchObject({ kind: "video", storageKey: null, skipReason: "video_off" });
    expect(by["raw.mp4"]).toMatchObject({ sourcePath: `${path}VISUALS/raw.mp4`.replace("//", "/"), skipReason: "video_off" });
    expect(by["big.jpg"]).toMatchObject({ storageKey: null, skipReason: "too_big" });
    const [after] = await h.db.select().from(stories).where(eq(stories.id, story!.id));
    expect(after!.mediaState).toBe("attached");

    clock += 2500;
    expect(await run.poll()).toBe(0); // nothing twice
    expect((await h.db.select().from(assets)).length).toBe(5);

    // Video copying switched on later: the recorded videos are copied now
    const withVideo = ingest({ media: { types: ["jpg", "mp4"], maxBytes: 1000, video: true }, rescanMs: 0 });
    await withVideo.poll();
    clock += 2500;
    await withVideo.poll();
    const vids = await h.db.select().from(assets).where(and(eq(assets.storyId, story!.id), eq(assets.kind, "video")));
    expect(vids.every((v) => v.storageKey && v.skipReason === null)).toBe(true);

    const status = await readIngestStatus(h.db);
    expect(status).toMatchObject({ mode: "samvadia", lastError: null, cursor: { storyId: a.storyId } });
  });

  it("dedupes on story id + version: an update is a new story, the same version never twice", async () => {
    const [first] = await h.db.select().from(stories);
    const ext = first!.external!;
    await addVersion(ext.itemId, 2, "update", first!.slug);
    const run = ingest();
    expect(await run.poll()).toBeGreaterThanOrEqual(1);
    const all = await h.db.select({ id: stories.externalId }).from(stories);
    expect(all.map((s) => s.id!.split(":")[1]).sort()).toEqual(["v1", "v2"]);

    // Forget the cursor entirely: everything comes back from Samvadia, nothing is duplicated
    await setKv(h.db, CURSOR_KEY, { publishedAt: new Date(0).toISOString(), storyId: "00000000-0000-0000-0000-000000000000" });
    await ingest().poll();
    expect((await h.db.select().from(stories)).length).toBe(2);
  });

  it("takes a story that committed late, inside the overlap window behind the cursor", async () => {
    const cursor = (await getKv<{ publishedAt: string }>(h.db, CURSOR_KEY))!;
    await approve({ subject: "LATECOMMIT", headline: "देर से दर्ज खबर", body: "यह खबर कर्सर से पहले की तारीख की है।", publishedAt: new Date(Date.parse(cursor.publishedAt) - 60_000) });
    await ingest().poll();
    expect((await h.db.select().from(stories).where(sql`${stories.slug} LIKE '%LATECOMMIT%'`)).length).toBe(1);
  });

  it("attaches footage that arrives late: a path Samvadia fills in later, and a new file in a folder", async () => {
    const a = await approve({ subject: "BARISH", headline: "बेमौसम बारिश से फसल को नुकसान", body: "खेतों में पानी भरा।", path: null });
    const run = ingest({ rescanMs: 30_000 });
    await run.poll();
    const [story] = await h.db.select().from(stories).where(eq(stories.externalId, `${a.storyId}:v1`));
    expect(story!.mediaState).toBe("awaiting");

    const path = "/BARAN/oct2026/27102026/271026_BRN_BARISH_AV_MUKESH/";
    await footage(path, { "a.jpg": 10 });
    await q(`UPDATE ${SCHEMA}.items SET footage_path = $2, footage_status = 'found' WHERE id = $1`, [a.itemId, path]);
    clock += 31_000; // next rescan re-reads Samvadia's footage path
    await run.poll();
    clock += 2500;
    await run.poll();
    let media = await h.db.select().from(assets).where(eq(assets.storyId, story!.id));
    expect(media.map((m) => m.fileName)).toEqual(["a.jpg"]);
    const [refreshed] = await h.db.select().from(stories).where(eq(stories.id, story!.id));
    expect(refreshed!.mediaState).toBe("attached");
    expect(refreshed!.external!.footagePath).toBe(path);

    await footage(path, { "b_late.jpg": 20 });
    clock += 31_000;
    await run.poll();
    clock += 2500;
    await run.poll();
    media = await h.db.select().from(assets).where(eq(assets.storyId, story!.id));
    expect(media.map((m) => m.fileName).sort()).toEqual(["a.jpg", "b_late.jpg"]);
  });

  it("records a failed poll in the ingest status and keeps going", async () => {
    const broken = new SamvadiaIngest({
      db: h.db, storage: store, footage: new FolderFootage(footageRoot), orgId, log, media: { types: ["jpg"], maxBytes: 1000, video: false }, rescanMs: 60_000, backfillHours: 24,
      reader: { storiesSince: async () => { throw new Error("connection refused"); }, footageFor: async () => [], close: async () => undefined },
    });
    await expect(broken.poll()).rejects.toThrow(/connection refused/);
    const status = await readIngestStatus(h.db);
    expect(status!.lastError!.message).toMatch(/connection refused/);
    expect(status!.lastOkAt).not.toBeNull();
    await ingest().poll();
    expect((await readIngestStatus(h.db))!.lastError).toBeNull();
  });

  it("goes on through compose (district hashtag), render and approve to a fake X post", async () => {
    // A story whose text never names the district: the hashtag comes from Samvadia's district
    const a = await approve({ subject: "SADAK", headline: "नई सड़क का लोकार्पण", body: "मंत्री ने फीता काटा।" });
    await ingest().poll();
    const dict = new Dictionaries(h.db, orgId);
    while (await composeNext(h.db, dict, log));
    const [draft] = await h.db
      .select({ d: postDrafts })
      .from(postDrafts)
      .innerJoin(stories, eq(stories.id, postDrafts.storyId))
      .where(eq(stories.externalId, `${a.storyId}:v1`));
    expect(draft!.d.hashtags).toEqual(["#Baran", "#1stIndiaNews"]);
    expect(draft!.d.bodyText).toBe("नई सड़क का लोकार्पण");

    const renderer = new CardRenderer(1);
    await renderer.start();
    try {
      // Render just this draft: park the others
      await h.db.update(postDrafts).set({ renderLeaseUntil: sql`now() + interval '1 hour'` }).where(sql`${postDrafts.id} <> ${draft!.d.id}`);
      expect(await renderNext(h.db, store, renderer, log)).toBe(true);
    } finally {
      await renderer.close();
    }
    const [ready] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, draft!.d.id));
    expect(ready!.status).toBe("ready");

    const [op] = await h.db.insert(users).values({ orgId, name: "Op", email: "op@test", passwordHash: "x", role: "operator" }).returning();
    const actor = { id: op!.id, orgId, name: "Op", role: "operator" as const };
    const claimed = await claimDraft(h.db, actor, ready!.id);
    const { job } = await approveDraft(h.db, actor, ready!.id, claimed.version);
    await h.db.update(publishJobs).set({ nextAttemptAt: sql`now()` }).where(eq(publishJobs.id, job.id));
    const x = new FakeXClient("1stIndiaNews");
    await new Publisher({ db: h.db, storage: store, x, bucket: new MemoryBucket(10, 60), account: "1stIndiaNews", log, active: () => true }).tick();
    const [post] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, ready!.id));
    expect(x.posts.get(post!.platformPostId)!.text).toBe("नई सड़क का लोकार्पण\n\n#Baran #1stIndiaNews");
  }, 60_000);
});
