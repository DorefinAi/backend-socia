// Phase 1 end to end on a real Postgres: breaking files land in day folders on a copy of the share and come
// out as ready X drafts with no card (card on demand). Needs TEST_DATABASE_URL. No Chromium.

import { copyFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb, ingestedFiles, orgs, postDrafts, publishedPosts, readIngestStatus, recordIngestPoll, runMigrations, stories, users, type DbHandle,
} from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BreakingShareSource, ShareUnreachable, type ShareFs } from "../src/breaking-source";
import { DataUnavailable, phaseOneData } from "../src/data-files";
import { Dictionaries, composeNext } from "../src/stages/compose";
import { convertNext } from "../src/stages/convert";
import { Ingest } from "../src/stages/ingest";

const URL_ = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });
const FIXTURES = new URL("../../../packages/core/test/fixtures/breaking/", import.meta.url);
const fixture = (name: string) => new URL(name, FIXTURES);

describe("BreakingShareSource (no database)", () => {
  it("lists today's and yesterday's BREAKING files only", async () => {
    const root = await mkdtemp(join(tmpdir(), "socia-share-"));
    await mkdir(join(root, "OCTOBER_2026", "30_OCTOBER_2026"), { recursive: true });
    await mkdir(join(root, "OCTOBER_2026", "31_OCTOBER_2026"), { recursive: true });
    await mkdir(join(root, "OCTOBER_2026", "29_OCTOBER_2026"), { recursive: true });
    await mkdir(join(root, "2025", "OCTOBER_2025", "31_OCTOBER_2025"), { recursive: true });
    await writeFile(join(root, "OCTOBER_2026", "29_OCTOBER_2026", "BTN_RAJ_BREAKING_0_29OCT.txt"), "x");
    await writeFile(join(root, "OCTOBER_2026", "30_OCTOBER_2026", "BTN_RAJ_BREAKING_1_30OCT_NDR_JPR_BIG.txt"), "x");
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "BTN_RAJ_BREAKING_2_31OCT_NDR_JPR_BIG.txt"), "x");
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "BTN_RJ_BRAKING_5_31OCT.txt"), "x");
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "BTN_RAJ_SCROLL_3_31OCT.txt"), "x");
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "nat_flash_rj_breaking_4.txt"), "x");
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "BTN_RAJ_BREAKING_6_HUGE.txt"), Buffer.alloc(1024 * 1024 + 1, 0x41));

    let now = new Date("2026-10-31T09:00:00Z"); // 14:30 IST on the 31st: yesterday still read
    const src = new BreakingShareSource(root, { now: () => now });
    expect((await src.list()).map((f) => f.path).sort()).toEqual([
      "OCTOBER_2026/30_OCTOBER_2026/BTN_RAJ_BREAKING_1_30OCT_NDR_JPR_BIG.txt",
      "OCTOBER_2026/31_OCTOBER_2026/BTN_RAJ_BREAKING_2_31OCT_NDR_JPR_BIG.txt",
      "OCTOBER_2026/31_OCTOBER_2026/BTN_RJ_BRAKING_5_31OCT.txt",
    ]);
    expect(src.health()).toMatchObject({ reachable: true, todayFolder: "OCTOBER_2026/31_OCTOBER_2026", alsoScanning: "OCTOBER_2026/30_OCTOBER_2026", filesToday: 2 });

    // November has no folder yet: yesterday's still listed, no error
    now = new Date("2026-11-01T03:00:00Z");
    expect(await src.list()).toHaveLength(2);
    expect(src.health()).toMatchObject({ reachable: true, todayFolder: null, expectedFolder: "01_NOVEMBER_2026" });

    // Nothing outside the root, however the path is written
    for (const bad of ["../secret.txt", "OCTOBER_2026/../../x.txt", "OCTOBER_2026\\..\\..\\x.txt", "C:x.txt", "//server/share/x.txt"]) {
      await expect(src.read(bad)).rejects.toThrow();
    }
  });

  it("calls a missing root, an I/O error or a hang ShareUnreachable, with no path in the message", async () => {
    const root = await mkdtemp(join(tmpdir(), "socia-share-"));
    const gone = new BreakingShareSource(join(root, "missing"));
    await expect(gone.list()).rejects.toBeInstanceOf(ShareUnreachable);
    expect(gone.health()).toMatchObject({ reachable: false, lastError: { code: "ENOENT" } });
    expect(gone.health()!.lastError!.message).not.toContain(root);

    const hang: ShareFs = { readdir: () => new Promise(() => undefined), stat: async () => ({ size: 1, mtime: new Date() }), readFileBounded: async () => Buffer.from("") };
    const slow = new BreakingShareSource(root, { fs: hang, timeoutMs: 30 });
    await expect(slow.list()).rejects.toMatchObject({ name: "ShareUnreachable", code: "ETIMEDOUT" });
    expect(slow.health()).toMatchObject({ reachable: false, lastError: { code: "ETIMEDOUT" } });

    // The top folder answers, a day folder fails with EIO: still unreachable, health updated
    const eio: ShareFs = {
      readdir: async (p) => (p === root ? [{ name: "OCTOBER_2026", isDirectory: () => true, isFile: () => false }] : Promise.reject(Object.assign(new Error("io"), { code: "EIO" }))),
      stat: hang.stat,
      readFileBounded: hang.readFileBounded,
    };
    const broken = new BreakingShareSource(root, { fs: eio, now: () => new Date("2026-10-31T09:00:00Z") });
    await expect(broken.list()).rejects.toMatchObject({ code: "EIO" });
    expect(broken.health()).toMatchObject({ reachable: false, lastError: { code: "EIO" } });
  });
});

(URL_ ? describe : describe.skip)("phase 1 pipeline: share → ready draft", () => {
  let h: DbHandle;
  let orgId: string;
  let dir: string;
  let store: LocalStorage;
  let clock: number;
  const data = phaseOneData(log);
  const day = (d: string) => join(dir, "share", "OCTOBER_2026", d);

  async function put(folder: string, name: string, body: string | URL, mtime = clock) {
    const to = join(day(folder), name);
    if (body instanceof URL) await copyFile(body, to);
    else await writeFile(to, body);
    await utimes(to, new Date(mtime), new Date(mtime));
  }

  /** Two scans 3 s apart (the stable-size wait), then the pipeline until it has nothing left */
  async function settle(ingest: Ingest): Promise<number> {
    await ingest.scan();
    clock += 3000;
    const taken = await ingest.scan();
    while (await convertNext(h.db, store, log, data));
    while (await composeNext(h.db, new Dictionaries(h.db, orgId), log, { cardOnDemand: true, data }));
    return taken;
  }

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: ["#1stIndiaNews"], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
  }, 60_000);

  beforeEach(async () => {
    await h.db.execute(sql`TRUNCATE published_posts, post_drafts, stories, ingested_files, kv CASCADE`);
    dir = await mkdtemp(join(tmpdir(), "socia-p1-"));
    await mkdir(day("28_OCTOBER_2026"), { recursive: true });
    await mkdir(day("29_OCTOBER_2026"), { recursive: true });
    store = new LocalStorage(join(dir, "store"), "http://localhost/dev-files");
    clock = new Date("2026-10-29T06:00:00Z").getTime(); // 11:30 IST on the 29th
  });

  afterAll(async () => {
    await h?.close();
  });

  const ingestFor = () =>
    new Ingest({ db: h.db, storage: store, source: new BreakingShareSource(join(dir, "share"), { now: () => new Date(clock) }), orgId, log, now: () => clock, layout: "breaking", startFromNow: true });

  it("skips what was there at first start, then ingests, parses and composes new files", async () => {
    await put("29_OCTOBER_2026", "BTN_RJ_BREAKING_2198_28OCT_mh_CONTROL_AJM3_big.txt", fixture("BTN_RJ_BREAKING_2198_28OCT_mh_CONTROL_AJM3_big.txt"), clock - 60_000);
    const ingest = ingestFor();
    expect(await settle(ingest)).toBe(0);

    await put("29_OCTOBER_2026", "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt", fixture("btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt"));
    await put("29_OCTOBER_2026", "BTN_RJ_BREAKING_9999_29OCT_US_CONTROL_EMPTY.txt", fixture("BTN_RJ_BREAKING_9999_29OCT_US_CONTROL_EMPTY.txt"));
    await put("29_OCTOBER_2026", "BTN_RAJ_SCROLL_1_29OCT.txt", "scroll");
    expect(await settle(ingest)).toBe(2); // the scroll file is never listed

    const all = await h.db.select().from(stories);
    const kota = all.find((s) => s.district === "Kota")!;
    expect(kota).toMatchObject({ layout: "breaking", mediaState: "none", status: "composed", parseMethod: "breaking", needsCheck: [] });
    expect(kota.fileTags).toMatchObject({ big: true, full: true, desk: "VKS", reporter: "REPORTER" });
    expect(all.find((s) => s.id !== kota.id)).toMatchObject({ status: "failed", needsCheck: ["empty"] });

    const [draft] = await h.db.select().from(postDrafts);
    expect(draft).toMatchObject({ status: "ready", cardRev: 0, hashtags: ["#RajasthanWithFirstIndia"], mentions: ["@KotaPolice"] });
    expect(draft!.bodyText.startsWith("#Kota: कोटा में हिस्ट्रीशीटर")).toBe(true);

    // A restart skips the first-start files and the ingested ones without reading them again
    expect(await settle(ingestFor())).toBe(0);
    expect(await h.db.select().from(stories)).toHaveLength(2);
  }, 60_000);

  it("takes a late file in yesterday's folder, even with an old mtime (copied in)", async () => {
    const ingest = ingestFor();
    expect(await settle(ingest)).toBe(0);
    clock = new Date("2026-10-29T03:00:00Z").getTime() + 24 * 3600_000; // 08:30 IST on the 30th, long after 02:00
    await mkdir(day("30_OCTOBER_2026"), { recursive: true });
    // Saved into the 29th's folder, its mtime from before the first start
    await put("29_OCTOBER_2026", "BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt", fixture("BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt"), clock - 30 * 3600_000);
    expect(await settle(ingest)).toBe(1);
    expect((await h.db.select().from(stories))[0]).toMatchObject({ district: "Dausa", status: "composed" });
  }, 60_000);

  it("re-saved with new text: rewrites the unposted draft; after posting: a new draft flagged as an update", async () => {
    const ingest = ingestFor();
    await settle(ingest);
    const name = "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt";
    await put("29_OCTOBER_2026", name, fixture(name));
    expect(await settle(ingest)).toBe(1);
    const [first] = await h.db.select().from(postDrafts);

    clock += 60_000;
    await put("29_OCTOBER_2026", name, `${name}\n\nकोटा में हिस्ट्रीशीटर के घर में तोड़फोड़, दो गिरफ्तार\nपुलिस ने दो आरोपियों को पकड़ा\n`);
    expect(await settle(ingest)).toBe(1);
    const drafts = await h.db.select().from(postDrafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ id: first!.id, version: first!.version + 1, status: "ready" });
    expect(drafts[0]!.bodyText).toContain("दो गिरफ्तार");
    const [story] = await h.db.select().from(stories).where(eq(stories.id, first!.storyId));
    expect(story!.needsCheck).toContain("resaved");

    // Posted by hand, then saved again
    const [u] = await h.db.insert(users).values({ orgId, name: "Op", email: `op${Date.now()}@t`, passwordHash: "x", role: "operator" }).returning();
    await h.db.update(postDrafts).set({ status: "published" }).where(eq(postDrafts.id, first!.id));
    await h.db.insert(publishedPosts).values({ orgId, draftId: first!.id, platform: "x", text: "t", publishedBy: u!.id, manual: true });
    clock += 60_000;
    await put("29_OCTOBER_2026", name, `${name}\n\nकोटा में हिस्ट्रीशीटर के घर में तोड़फोड़, तीसरा आरोपी भी गिरफ्तार\nपुलिस की कार्रवाई जारी\n`);
    expect(await settle(ingest)).toBe(1);
    const after = await h.db.select().from(postDrafts);
    expect(after).toHaveLength(2);
    const update = after.find((d) => d.id !== first!.id)!;
    expect(update.bodyText).toContain("तीसरा आरोपी");
    const [updStory] = await h.db.select().from(stories).where(eq(stories.id, update.storyId));
    expect(updStory).toMatchObject({ updateOfDraftId: first!.id });
    expect(updStory!.needsCheck).toContain("update_of_posted");
    expect((await h.db.select().from(postDrafts).where(eq(postDrafts.id, first!.id)))[0]!.status).toBe("published");
  }, 60_000);

  it("one story that throws is marked failed and the next one goes through", async () => {
    const ingest = ingestFor();
    await settle(ingest);
    await put("29_OCTOBER_2026", "BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt", fixture("BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt"));
    await put("29_OCTOBER_2026", "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt", fixture("btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt"), clock + 1000);
    await ingest.scan();
    clock += 3000;
    expect(await ingest.scan()).toBe(2);
    // The first story's raw file is lost from storage: reading it throws
    const [firstFile] = await h.db.select().from(ingestedFiles).orderBy(ingestedFiles.mtime).limit(1);
    await h.db.update(ingestedFiles).set({ storageKey: "raw/missing.txt" }).where(eq(ingestedFiles.id, firstFile!.id));

    expect(await convertNext(h.db, store, log, data)).toBe(true);
    expect(await convertNext(h.db, store, log, data)).toBe(true);
    const rows = await h.db.select().from(stories);
    expect(rows.find((s) => s.fileId === firstFile!.id)).toMatchObject({ status: "failed", lastError: expect.stringContaining("Could not convert") });
    expect(rows.find((s) => s.fileId !== firstFile!.id)).toMatchObject({ status: "converted", district: "Kota" });

    // An unreadable places file is not the story's fault: it stays waiting and the error goes to the loop
    await put("29_OCTOBER_2026", "BTN_RJ_BREAKING_6072_29OCT_US_CONTROL_REPORTER_karari_big.txt", fixture("BTN_RJ_BREAKING_6072_29OCT_US_CONTROL_REPORTER_karari_big.txt"));
    await ingest.scan();
    clock += 3000;
    await ingest.scan();
    const noData = phaseOneData(log, undefined, { PLACES_FILE: join(dir, "nope.json") });
    await expect(convertNext(h.db, store, log, noData)).rejects.toBeInstanceOf(DataUnavailable);
    expect((await h.db.select().from(stories).where(eq(stories.status, "ingested")))).toHaveLength(1);
  }, 60_000);

  it("records the share's health and says a repeated error only once", async () => {
    const health = { kind: "breaking" as const, reachable: false, expectedFolder: "29_OCTOBER_2026", todayFolder: null, alsoScanning: null, filesToday: 0, lastFileAt: null, lastFileName: null, checkedAt: new Date().toISOString(), lastError: null };
    for (let i = 0; i < 3; i++) await recordIngestPoll(h.db, orgId, { mode: "folder", taken: 0, error: "The breaking-news share cannot be read (ENOENT).", cursor: null, source: health, quietRepeats: true });
    const status = await readIngestStatus(h.db);
    expect(status?.recentErrors.filter((e) => e.message.includes("ENOENT"))).toHaveLength(1);
    expect(status?.source).toMatchObject({ reachable: false, expectedFolder: "29_OCTOBER_2026" });
  });
});
