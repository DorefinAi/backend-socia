// Phase 1 end to end on a real Postgres: breaking files land in day folders on a copy of the share and come
// out as ready X drafts with no card (card on demand). Needs TEST_DATABASE_URL. No Chromium.

import { copyFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIC_VERSION, createDb, ingestedFiles, orgs, postDecisions, postDrafts, publishedPosts, readIngestStatus, recordIngestPoll, runMigrations, stories, users, type DbHandle,
} from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BreakingShareSource, ShareUnreachable, type ShareFs } from "../src/breaking-source";
import { DataUnavailable, institutionHandles, phaseOneData } from "../src/data-files";
import { Dictionaries, composeNext } from "../src/stages/compose";
import { convertNext } from "../src/stages/convert";
import { Ingest } from "../src/stages/ingest";

const URL_ = process.env.TEST_DATABASE_URL;
const log = pino({ level: "silent" });
const FIXTURES = new URL("../../../packages/core/test/fixtures/breaking/", import.meta.url);
const fixture = (name: string) => new URL(name, FIXTURES);

describe("explore roll (reporter-prior brief §7.2.3)", () => {
  it("draftProposals keeps core's list and falls back to reason codes without one", async () => {
    const { draftProposals } = await import("../src/stages/compose");
    const core = [{ item: "#X", kind: "hashtag" as const, layer: "emit" as const, source: "brand.geo" as const, reason: "r" }];
    let fellBack = 0;
    expect(draftProposals({ hashtags: [], handles: [], handleSuggestions: [], hashtagSuggestions: [], proposals: core }, () => fellBack++)).toEqual(core);
    expect(fellBack).toBe(0);
    draftProposals({ hashtags: [], handles: [], handleSuggestions: [], hashtagSuggestions: [] }, () => fellBack++);
    // The caller is told (compose logs it at warn)
    expect(fellBack).toBe(1);
    // An older core with no proposals and no rule ids: each handle's source falls back to its reason code
    expect(
      draftProposals({ hashtags: ["#F"], handles: [{ handle: "JaipurPolice", reason: "police" }], handleSuggestions: [{ handle: "A", reason: "subject", title: "A" }], hashtagSuggestions: ["#S"] }),
    ).toEqual([
      { item: "#F", kind: "hashtag", layer: "emit", source: "footer", reason: "footer" },
      { item: "@JaipurPolice", kind: "handle", layer: "emit", source: "district.police", reason: "district.police" },
      { item: "#S", kind: "hashtag", layer: "suggest", source: "suggestion", reason: "suggestion" },
      { item: "@A", kind: "handle", layer: "suggest", source: "subject", reason: "A" },
    ]);
  });
});

describe("data files fail loudly (b6 fix brief P5, no database)", () => {
  it("rejects a campaigns file with a misspelt kind WHOLE, keeps the last good copy and says why in the status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const path = join(dir, "campaigns.json");
    const good = { entries: [{ tag: "ACB", kind: "keyword", pattern: "ACB" }] };
    await writeFile(path, JSON.stringify(good));
    const statuses: { ok: boolean; message?: string }[] = [];
    const data = phaseOneData(log, (s) => void statuses.push(s), { CAMPAIGNS_FILE: path });
    expect((await data.campaigns.get()).value.rules.map((r) => r.tag)).toEqual(["ACB"]);

    // A typo in one entry: nothing of the new file is used, not even its good entry
    await writeFile(path, JSON.stringify({ entries: [{ tag: "New", kind: "keyword", pattern: "x" }, { tag: "Typo", kind: "campain", pattern: "y", start: "2026-11-01", end: "2026-11-30" }] }));
    await utimes(path, new Date(), new Date(Date.now() + 5_000));
    (data.campaigns as unknown as { checkedAt: number }).checkedAt = 0;
    expect((await data.campaigns.get()).value.rules.map((r) => r.tag)).toEqual(["ACB"]);
    const last = statuses.at(-1)!;
    expect(last.ok).toBe(false);
    expect(last.message).toMatch(/campaigns file was rejected \(1 problem: .*kind must be "campaign" or "keyword", not "campain"/);
    expect(last.message).toMatch(/using the last good copy/);

    // The same rejected version is not parsed or reported again every minute
    const reported = statuses.length;
    (data.campaigns as unknown as { checkedAt: number }).checkedAt = 0;
    expect((await data.campaigns.get()).value.rules.map((r) => r.tag)).toEqual(["ACB"]);
    expect(statuses).toHaveLength(reported);
    // A fixed file loads again and says so
    await writeFile(path, JSON.stringify({ entries: [{ tag: "New", kind: "keyword", pattern: "x" }] }));
    await utimes(path, new Date(), new Date(Date.now() + 10_000));
    (data.campaigns as unknown as { checkedAt: number }).checkedAt = 0;
    expect((await data.campaigns.get()).value.rules.map((r) => r.tag)).toEqual(["New"]);
    expect(statuses.at(-1)).toMatchObject({ ok: true });
  });

  it("loads the shipped beat-handles file against the directory files, and rejects a beat whose handle is in none (L8)", async () => {
    const statuses: { file: string; ok: boolean; message?: string }[] = [];
    const shipped = phaseOneData(log, (s) => void statuses.push(s));
    expect([...(await shipped.beats.get()).value.beats.keys()].sort()).toEqual(["education", "jda", "tourism"]);

    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const path = join(dir, "beat-handles.json");
    await writeFile(path, JSON.stringify({ education: { keywords: "स्कूल", handles: ["@NoSuchHandle1"] } }));
    const data = phaseOneData(log, (s) => void statuses.push(s), { BEAT_HANDLES_FILE: path });
    // Never a good copy: no beats at all rather than an invented handle
    expect((await data.beats.get()).value.beats.size).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ file: "beats", ok: false });
    expect(statuses.at(-1)!.message).toMatch(/in no directory file/);
  });

  it("R2: the shipped directory loads with every handle_type; the nightly prior candidates are its institutions only", async () => {
    const statuses: { file: string; ok: boolean; message?: string }[] = [];
    const shipped = phaseOneData(log, (s) => void statuses.push(s));
    await Promise.all([shipped.handles.get(), shipped.subjects.get(), shipped.parties.get(), shipped.reporters.get()]);
    expect(statuses.filter((s) => /handle_type|not an institution/.test(s.message ?? ""))).toEqual([]);
    const inst = institutionHandles(log);
    for (const h of ["rajgovofficial", "incrajasthan", "bjp4rajasthan", "rajcmo"]) expect(inst.has(h), h).toBe(true);
    for (const h of ["bhajanlalbjp", "svoruganti1466", "jaipur_police", "kotapolice", "dcdmjaipur", "rituraj9999"]) expect(inst.has(h), h).toBe(false);
  });

  it("R2: a district-handles entry with a bad handle_type is rejected alone and reported; a reporter's person handle is dropped from its prior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const districts = join(dir, "district-handles.json");
    await writeFile(districts, JSON.stringify({
      version: 2,
      state: [{ handle: "@RajGovOfficial", handle_type: "institution", role: "govt", verified: true }, { handle: "@BhajanlalBjp", handle_type: "person", role: "cm", verified: true }],
      districts: { Kota: [{ handle: "@KotaPolice", role: "police", verified: true }, { handle: "@DMKota", handle_type: "district", role: "collector", verified: true }] },
    }));
    const reporters = join(dir, "reporter-handles.json");
    await writeFile(reporters, JSON.stringify({
      version: 1,
      entries: [{ handle: "@rituraj9999", handle_type: "person", names_en: ["rituraj"], verified: true, prior: { n: 121, handles: { RajGovOfficial: 0.52, BhajanlalBjp: 0.4 } } }],
    }));
    const statuses: { file: string; ok: boolean; skipped?: number }[] = [];
    // The skipped entries go to the log at warn, named; the status counts them
    const warned: { file?: string; problems?: string[] }[] = [];
    const capture = pino({ level: "warn" }, { write: (line: string) => void warned.push(JSON.parse(line)) });
    const data = phaseOneData(capture, (s) => void statuses.push(s), { DISTRICT_HANDLES_FILE: districts, REPORTER_HANDLES_FILE: reporters });
    const problemsOf = (file: string) => warned.filter((w) => w.file === file).flatMap((w) => w.problems ?? []).join(" ");
    const rules = (await data.handles.get()).value;
    expect(rules.districts.kota).toEqual({ police: [], collector: ["DMKota"] });
    expect(rules.bound!.has("kotapolice")).toBe(true);
    expect(statuses.find((s) => s.file === "handles")).toMatchObject({ ok: true, skipped: 1 });
    expect(problemsOf("handles")).toMatch(/districts\.Kota\[0\] \(@KotaPolice\): "handle_type" is missing.*entry rejected/);
    const roster = (await data.reporters.get()).value;
    expect(roster.byToken.get("RITURAJ")?.handle).toBe("rituraj9999");
    expect(Object.keys(roster.profiles!.get("rituraj9999")!.prior!.handles)).toEqual(["RajGovOfficial"]);
    expect(problemsOf("reporters")).toMatch(/@BhajanlalBjp is a person handle, not an institution — dropped/);
  });

  it("takes the places file's district tags as known-good normalisation targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const path = join(dir, "hashtag-normalise.json");
    await writeFile(path, JSON.stringify({ variants: { jodhpur: "Jodhpur", Sawaimadhopur: "SawaiMadhopur" } }));
    const data = phaseOneData(log, undefined, { HASHTAG_NORMALISE_FILE: path });
    expect((await data.normalise.get()).value.variants.get("jodhpur")).toBe("Jodhpur");
  });

  it("rejects a normalisation target nobody confirmed, even at first start (falls back to none)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const path = join(dir, "hashtag-normalise.json");
    await writeFile(path, JSON.stringify({ variants: { Jaipr: "Jaipurr" } }));
    const statuses: { ok: boolean; message?: string }[] = [];
    const data = phaseOneData(log, (s) => void statuses.push(s), { HASHTAG_NORMALISE_FILE: path });
    expect((await data.normalise.get()).value.variants.size).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ ok: false, message: expect.stringMatching(/#Jaipurr is not a known-good tag.*using none/) });
  });
});

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
    while (await composeNext(h.db, new Dictionaries(h.db, orgId), log, { cardOnDemand: true, data, exploreRate: 0 }));
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
    // No place line and no place prefix: "कोटा में ..." is the headline's, so the district is INFERRED (b6 fix
    // brief P0) — stored for the queue, with its provenance, and only offered on the draft
    expect(kota).toMatchObject({ layout: "breaking", mediaState: "none", status: "composed", parseMethod: "breaking", needsCheck: [], districtFrom: "text" });
    expect(kota.fileTags).toMatchObject({ big: true, full: true, desk: "VKS", reporter: "REPORTER" });
    expect(all.find((s) => s.id !== kota.id)).toMatchObject({ status: "failed", needsCheck: ["empty"] });

    const [draft] = await h.db.select().from(postDrafts);
    // Before b7 this went out "#Kota: ..." with @KotaPolice; an inferred district now picks no police force
    expect(draft).toMatchObject({ status: "ready", cardRev: 0, hashtags: ["#RajasthanWithFirstIndia"], mentions: [] });
    expect(draft!.bodyText.startsWith("कोटा में हिस्ट्रीशीटर")).toBe(true);
    // Why those handles, stored with the draft for the desk: the class the rules hung off, the reason,
    // and the reporter name the file carried. "REPORTER" is the fixture's placeholder for a real name,
    // so it resolves to no byline and is reported rather than guessed at.
    expect(draft!.handlePick).toMatchObject({ cls: "incident", handles: [], reporterToken: "REPORTER" });
    expect((draft!.handlePick as { why: string }).why).toMatch(/crime, fire or accident/);
    // A crime story carries no byline anyway, so the unknown name is not raised as something to look at
    // — but it is still stored, which is what lets an editor's own edit teach it.
    expect((draft!.handlePick as { warnings: string[] }).warnings.join(" ")).not.toMatch(/reporter list/);
    expect(draft!.composeVersion.startsWith("b8.")).toBe(true);
    // The footer is the only hashtag that goes on a post by itself; the inferred district is offered first.
    // This org has no topic rules, so nothing else is offered; packages/core covers the case where one matches.
    expect(draft!.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    expect(draft!.hashtagSuggestions).toEqual(["#Kota"]);
    // ...and why, for the desk: the rule id and the reason line behind each offered tag
    expect((draft!.handlePick as { tagSuggestions: unknown[] }).tagSuggestions).toEqual([
      { tag: "#Kota", source: "district.inferred.headline", reason: expect.stringMatching(/inferred/) },
    ]);

    // The decision log's proposal half (reporter-prior brief §2): written with the draft, undecided, with what the
    // file name said about the reporter (L1: the file name only) and every item with its rule id
    const [logged] = await h.db.select().from(postDecisions);
    expect(logged).toMatchObject({
      draftId: draft!.id, storyId: kota.id, logicVersion: LOGIC_VERSION, composeVersion: draft!.composeVersion, explore: false, proposalRev: 1,
      filenameRaw: "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt", reporterStatus: "unknown_token", reporterToken: "REPORTER",
      slotRaw: "REPORTER", storyClass: "incident", district: "Kota", districtFrom: "text", decision: null, decidedAt: null,
    });
    expect(logged!.draftText.startsWith("कोटा में हिस्ट्रीशीटर")).toBe(true);
    expect(logged!.proposals).toEqual([
      { item: "#RajasthanWithFirstIndia", kind: "hashtag", layer: "emit", source: "brand.geo", reason: "a Rajasthan story" },
      { item: "#Kota", kind: "hashtag", layer: "suggest", source: "district.inferred.headline", reason: expect.stringMatching(/inferred/) },
    ]);

    // A restart skips the first-start files and the ingested ones without reading them again
    expect(await settle(ingestFor())).toBe(0);
    expect(await h.db.select().from(stories)).toHaveLength(2);
  }, 60_000);

  it("D1: when the decision log cannot be written at all, the draft still goes through", async () => {
    const ingest = ingestFor();
    await settle(ingest);
    await h.db.execute(sql`ALTER TABLE post_decisions RENAME TO post_decisions_away`);
    try {
      const name = "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt";
      await put("29_OCTOBER_2026", name, fixture(name));
      expect(await settle(ingest)).toBe(1);
      const [draft] = await h.db.select().from(postDrafts);
      expect(draft).toMatchObject({ status: "ready" });
      expect((await h.db.select().from(stories))[0]).toMatchObject({ status: "composed" });
    } finally {
      await h.db.execute(sql`ALTER TABLE post_decisions_away RENAME TO post_decisions`);
    }
    expect(await h.db.select().from(postDecisions)).toEqual([]);
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
    // The undecided proposal follows the rewrite
    const [relogged] = await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, first!.id));
    expect(relogged).toMatchObject({ proposalRev: 2 });
    expect(relogged!.draftText).toContain("दो गिरफ्तार");
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
    // The update is a draft of its own with a proposal of its own
    expect(await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, update.id))).toHaveLength(1);
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
