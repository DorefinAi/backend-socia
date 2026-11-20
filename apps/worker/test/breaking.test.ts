// Phase 1 end to end on a real Postgres: breaking files land in day folders on a copy of the share and come
// out as ready X drafts with no card (card on demand). Needs TEST_DATABASE_URL. No Chromium.

import { copyFile, mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIC_VERSION, createDb, ingestedFiles, orgs, postDecisions, postDrafts, publishedPosts, readIngestStatus, recordIngestPoll, runMigrations, stories, users, type DbHandle,
} from "@socia/db";
import { LocalStorage, type FileSource } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BreakingShareSource, ShareUnreachable, type ShareFs } from "../src/breaking-source";
import {
  BROKEN_REMINDER_MS, DataUnavailable, PriorCandidatesUnavailable, brokenDirectoryFiles, loadDataFiles, nightlyInstitutions, phaseOneData, reloadDataFiles, startDataFiles,
} from "../src/data-files";
import { Dictionaries, composeNext, priorGate } from "../src/stages/compose";
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
    const inst = await nightlyInstitutions(shipped);
    for (const h of ["rajgovofficial", "incrajasthan", "bjp4rajasthan", "rajcmo"]) expect(inst.has(h), h).toBe(true);
    for (const h of ["bhajanlalbjp", "svoruganti1466", "jaipur_police", "kotapolice", "dcdmjaipur", "rituraj9999"]) expect(inst.has(h), h).toBe(false);
    // P3 / D2: the police accounts and the central armed police forces are typed "police": never a candidate either
    for (const h of ["policerajasthan", "rajpolicehelp", "acbrajasthan", "delhipolice", "crpfindia", "bsf_india"]) expect(inst.has(h), h).toBe(false);
  });

  it("R3 + R2: the nightly re-checks the files on disk first, and builds NO candidates while a directory file is broken", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    await copyFile(new URL("../config/party-handles.json", import.meta.url), parties);
    const data = phaseOneData(log, undefined, { PARTY_HANDLES_FILE: parties });
    await loadDataFiles(data);
    expect((await nightlyInstitutions(data)).has("incrajasthan")).toBe(true);

    // R3: an institution added on disk a moment ago (inside the loaders' one-minute wait) is in tonight's candidates
    const file = JSON.parse(await readFile(parties, "utf8")) as { entries: unknown[] };
    file.entries.push({ handle: "@NewPartyX", handle_type: "institution", party: "newx", scope: "state", keywords_en: ["NEWPARTYX"], verified: true });
    await writeFile(parties, JSON.stringify(file));
    await utimes(parties, new Date(), new Date(Date.now() + 5_000));
    expect((await nightlyInstitutions(data)).has("newpartyx")).toBe(true);

    // R2: half-saved at night. The composer turns the prior off; the nightly does the same — no candidates from the
    // last good copy — and says which file
    await writeFile(parties, '{ "version": 1, "entries": [ { "handle": "@INCRaj');
    await utimes(parties, new Date(), new Date(Date.now() + 10_000));
    await expect(nightlyInstitutions(data)).rejects.toBeInstanceOf(PriorCandidatesUnavailable);
    await expect(nightlyInstitutions(data)).rejects.toThrow(/the parties directory file did not load .*no prior candidates are built and no snapshot is written/);
    expect(priorGate(data, log)).toMatch(/parties directory file did not load/);
    // A process where it never loaded: the same
    const never = phaseOneData(log, undefined, { PARTY_HANDLES_FILE: parties });
    await loadDataFiles(never);
    await expect(nightlyInstitutions(never)).rejects.toBeInstanceOf(PriorCandidatesUnavailable);
  });

  it("R1: a broken file restored with its OLD timestamp is back on within 60 s, and says \"back on\" once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    const good = await readFile(new URL("../config/party-handles.json", import.meta.url), "utf8");
    const OLD = new Date("2026-01-01T00:00:00Z");
    await writeFile(parties, good);
    await utimes(parties, OLD, OLD);
    const lines: { level: number; msg?: string }[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = phaseOneData(capture, undefined, { PARTY_HANDLES_FILE: parties });
      await data.parties.get();
      expect(data.parties.ok()).toBe(true);
      // Broken (a half-saved edit), then restored from a backup: the restored copy carries the OLD mtime again
      await writeFile(parties, '{ "version": 1, "entries": [ { "handle": "@INCRaj');
      await utimes(parties, new Date(), new Date());
      clock += 61_000;
      await data.parties.get();
      expect(data.parties.ok()).toBe(false);
      await writeFile(parties, good);
      await utimes(parties, OLD, OLD);
      clock += 61_000;
      await data.parties.get();
      expect(data.parties.ok()).toBe(true);
      expect(brokenDirectoryFiles(data).map((b) => b.file)).not.toContain("parties");
      clock += 61_000;
      await data.parties.get();
      expect(lines.filter((l) => l.msg === "back on: parties")).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("R7: a broken file's error is logged when it changes and once an hour while it stays, not every minute", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    await writeFile(parties, '{ "version": 1, "entries": [ { "handle": "@INCRaj');
    const errors: { msg?: string }[] = [];
    const capture = pino({ level: "error" }, { write: (line: string) => void errors.push(JSON.parse(line)) });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = phaseOneData(capture, undefined, { PARTY_HANDLES_FILE: parties });
      // 59 one-minute ticks (just under an hour), the file read again on each (R1): one error line
      for (let i = 0; i < 59; i++) {
        await data.parties.get();
        clock += 61_000;
      }
      expect(errors).toHaveLength(1);
      expect(errors[0]!.msg).toMatch(/data file could not be read; using none/);
      // Still broken an hour after the first line: one reminder
      clock = clock + BROKEN_REMINDER_MS;
      await data.parties.get();
      expect(errors).toHaveLength(2);
      expect(errors[1]!.msg).toMatch(/\(still broken\)$/);
      // A different error: at once
      await writeFile(parties, "{ not json at all");
      clock += 61_000;
      await data.parties.get();
      expect(errors).toHaveLength(3);
      expect(errors[2]!.msg).not.toMatch(/still broken/);
    } finally {
      now.mockRestore();
    }
  });

  it("R5 + R8: fixing a \"District\" typo in a directory file brings the beat handle back, without a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const subjectsPath = join(dir, "subject-handles.json");
    const good = await readFile(new URL("../config/subject-handles.json", import.meta.url), "utf8");
    const typo = JSON.parse(good) as { entries: { handle: string; handle_type: string }[] };
    typo.entries.find((e) => e.handle === "@KumariDiya")!.handle_type = "District";
    await writeFile(subjectsPath, JSON.stringify(typo));
    const warned: { file?: string; problems?: string[] }[] = [];
    const capture = pino({ level: "warn" }, { write: (line: string) => void warned.push(JSON.parse(line)) });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = phaseOneData(capture, undefined, { SUBJECT_HANDLES_FILE: subjectsPath });
      await loadDataFiles(data);
      // The typo: the subject entry is rejected, so @KumariDiya has no type and is left out of the tourism beat (P6)
      expect((await data.beats.get()).value.beats.get("tourism")!.handles).toEqual([]);
      expect(warned.filter((w) => w.file === "beats").flatMap((w) => w.problems ?? []).join(" ")).toMatch(/"tourism": @KumariDiya has no valid handle_type.*left out of this beat/);

      // Fixed in the subject file. The beats file itself is untouched (same mtime): it is parsed again because a
      // directory file it is checked against changed — and S5: in the SAME read, which brings the subject file up to
      // date first (no earlier subjects.get(), no "one story late")
      await writeFile(subjectsPath, good);
      await utimes(subjectsPath, new Date(), new Date(Date.now() + 5_000));
      clock += 61_000;
      expect((await data.beats.get()).value.beats.get("tourism")!.handles).toEqual(["KumariDiya"]);
    } finally {
      now.mockRestore();
    }
  });

  it("S5: the reload loop sees a directory fix and re-checks the beats in the same tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const subjectsPath = join(dir, "subject-handles.json");
    const good = await readFile(new URL("../config/subject-handles.json", import.meta.url), "utf8");
    const typo = JSON.parse(good) as { entries: { handle: string; handle_type: string }[] };
    typo.entries.find((e) => e.handle === "@KumariDiya")!.handle_type = "District";
    await writeFile(subjectsPath, JSON.stringify(typo));
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = (await startDataFiles({ pipeline: true, maintenance: false, log, env: { SUBJECT_HANDLES_FILE: subjectsPath } }))!;
      expect(data.beats.current()!.beats.get("tourism")!.handles).toEqual([]);
      await writeFile(subjectsPath, good);
      await utimes(subjectsPath, new Date(), new Date(Date.now() + 5_000));
      clock += 61_000;
      await reloadDataFiles(data, false);
      // No story was composed: the beats copy in memory is already the re-checked one
      expect(data.beats.current()!.beats.get("tourism")!.handles).toEqual(["KumariDiya"]);
    } finally {
      now.mockRestore();
    }
  });

  it("S1: subject-handles.json broken from startup — 10 minutes of reload ticks give at most one error line per file, and no disk re-reads by the beats check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const subjectsPath = join(dir, "subject-handles.json");
    await writeFile(subjectsPath, '{ "version": 2, "entries": [ { "handle": "@Kumari');
    const lines: { level: number; msg?: string; file?: string }[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      // The shipped beats name @KumariDiya, which only the (broken) subject file carries: the beats are refused too
      const data = (await startDataFiles({ pipeline: true, maintenance: false, log: capture, env: { SUBJECT_HANDLES_FILE: subjectsPath } }))!;
      for (let i = 0; i < 10; i++) {
        clock += 61_000;
        await reloadDataFiles(data, false);
      }
      expect(data.subjects.ok()).toBe(false);
      // No warning a minute from the beats or reporters check reading the broken file from disk (S1)
      expect(lines.filter((l) => /directory file could not be read/.test(l.msg ?? ""))).toEqual([]);
      // Each broken file says so once in the 10 minutes (the hourly reminder is R7's test)
      const errorsBy = new Map<string, number>();
      for (const l of lines) if (l.level >= 50) errorsBy.set(l.file ?? "?", (errorsBy.get(l.file ?? "?") ?? 0) + 1);
      expect(errorsBy.get("subjects")).toBe(1);
      for (const [file, n] of errorsBy) expect(n, file).toBeLessThanOrEqual(1);
      expect(lines.filter((l) => l.level >= 50 && /still broken/.test(l.msg ?? ""))).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it("S3: the reload loop updates /ingest/status — \"back on\" shows with no story composed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    const good = await readFile(new URL("../config/party-handles.json", import.meta.url), "utf8");
    await writeFile(parties, '{ "version": 1, "entries": [ { "handle": "@INCRaj');
    const statuses: { file: string; ok: boolean }[] = [];
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = (await startDataFiles({ pipeline: true, maintenance: true, log, onStatus: (s) => void statuses.push(s), env: { PARTY_HANDLES_FILE: parties } }))!;
      expect(statuses.filter((s) => s.file === "parties").at(-1)).toMatchObject({ ok: false });
      await writeFile(parties, good);
      clock += 61_000;
      await reloadDataFiles(data, true);
      expect(statuses.filter((s) => s.file === "parties").at(-1)).toMatchObject({ ok: true });
      // The first tick also read the pipeline-only files, once each
      for (const f of ["places", "normalise", "campaigns"]) expect(statuses.filter((s) => s.file === f), f).toEqual([expect.objectContaining({ ok: true })]);
    } finally {
      now.mockRestore();
    }
  });

  it("S4: callers that arrive during a read share it — one parse, one \"back on\"", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    const good = await readFile(new URL("../config/party-handles.json", import.meta.url), "utf8");
    await writeFile(parties, "{ not json");
    const lines: { msg?: string; file?: string }[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = phaseOneData(capture, undefined, { PARTY_HANDLES_FILE: parties });
      await data.parties.get();
      await writeFile(parties, good);
      clock += 61_000;
      // A story's compose, the reload loop and the reporters/beats checks, all at once
      const reads = await Promise.all([data.parties.get(), data.parties.get(), data.reporters.get(), data.beats.get(), data.parties.get()]);
      expect(new Set([reads[0], reads[1], reads[4]]).size).toBe(1);
      expect(lines.filter((l) => l.msg === "back on: parties")).toHaveLength(1);
      expect(lines.filter((l) => l.msg === "data file loaded" && l.file === "parties")).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it("S6: every successful parse gets a version label of its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    const good = await readFile(new URL("../config/party-handles.json", import.meta.url), "utf8");
    const OLD = new Date("2026-01-01T00:00:00Z");
    await writeFile(parties, good);
    await utimes(parties, OLD, OLD);
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const data = phaseOneData(log, undefined, { PARTY_HANDLES_FILE: parties });
      const versions = [(await data.parties.get()).version];
      // Broken, then restored with the OLD mtime (R1): the same mtime parsed again
      await writeFile(parties, "{ not json");
      await utimes(parties, new Date(), new Date());
      clock += 61_000;
      await data.parties.get();
      await writeFile(parties, good);
      await utimes(parties, OLD, OLD);
      clock += 61_000;
      versions.push((await data.parties.get()).version);
      // A plain edit
      await utimes(parties, new Date(), new Date(Date.now() + 5_000));
      clock += 61_000;
      versions.push((await data.parties.get()).version);
      expect(new Set(versions).size).toBe(3);
      expect(versions[0]).toMatch(/^\d+\.1$/);
      expect(versions[1]!.split(".")[0]).toBe(versions[0]!.split(".")[0]);
    } finally {
      now.mockRestore();
    }
  });

  it("startup, maintenance only: each data file is read and logged once; the nightly needs no second read", async () => {
    const lines: { level: number; msg?: string; file?: string }[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const statuses: unknown[] = [];
    expect(await startDataFiles({ pipeline: false, maintenance: false, log: capture })).toBeNull();
    const data = (await startDataFiles({ pipeline: false, maintenance: true, log: capture, onStatus: (s) => void statuses.push(s) }))!;
    const loadedOnce = () => {
      const by = new Map<string, number>();
      for (const l of lines) if (l.msg === "data file loaded") by.set(l.file!, (by.get(l.file!) ?? 0) + 1);
      return Object.fromEntries(by);
    };
    expect(loadedOnce()).toEqual({ handles: 1, subjects: 1, parties: 1, reporters: 1, beats: 1 });
    // No directory file read a second time from disk for the reporters' or the beats' checks
    expect(lines.filter((l) => /directory file could not be read/.test(l.msg ?? ""))).toEqual([]);
    // The status is the pipeline's to record, not this process's
    expect(statuses).toEqual([]);
    // The nightly run: the files are re-checked on disk (R3), unchanged, so nothing is parsed or logged again
    expect((await nightlyInstitutions(data)).has("incrajasthan")).toBe(true);
    expect(loadedOnce()).toEqual({ handles: 1, subjects: 1, parties: 1, reporters: 1, beats: 1 });
    // Only the routine per-entry notes (beat labels with no key yet); no error and no second read
    expect(lines.filter((l) => l.level >= 40 && l.msg !== "data file entries skipped")).toEqual([]);
  });

  it("P5: a directory file that did not load turns the prior and beats off (logged once, named); back on when it loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-cfg-"));
    const parties = join(dir, "party-handles.json");
    await writeFile(parties, "{ not json");
    const lines: { level: number; msg?: string; files?: { file: string; path: string }[] }[] = [];
    const capture = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const data = phaseOneData(log, undefined, { PARTY_HANDLES_FILE: parties });
    await Promise.all([data.handles.get(), data.subjects.get(), data.parties.get(), data.reporters.get()]);
    expect(brokenDirectoryFiles(data)).toEqual([{ file: "parties", path: parties }]);
    const off = priorGate(data, capture);
    expect(off).toBe("the reporter prior and declared beats are off: the parties directory file did not load");
    // The desk's line names the file, never its path on the server; the log has both
    expect(off).not.toContain(dir);
    const errs = lines.filter((l) => l.level >= 50);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.msg).toMatch(/reporter prior and declared beats are OFF: the directory file parties \(.*party-handles\.json\) did not load/);
    expect(errs[0]!.files).toEqual([{ file: "parties", path: parties }]);
    // The next story: still off, not logged again
    expect(priorGate(data, capture)).toBe(off);
    expect(lines.filter((l) => l.level >= 50)).toHaveLength(1);

    // Fixed: back on, and said once
    await copyFile(new URL("../config/party-handles.json", import.meta.url), parties);
    await utimes(parties, new Date(), new Date(Date.now() + 5_000));
    (data.parties as unknown as { checkedAt: number }).checkedAt = 0;
    await data.parties.get();
    expect(brokenDirectoryFiles(data)).toEqual([]);
    expect(priorGate(data, capture)).toBeNull();
    expect(lines.at(-1)!.msg).toMatch(/back on/);
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
    // Up to 4 MB is taken; one byte more is skipped
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "BTN_RAJ_BREAKING_6_HUGE.txt"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x41));
    await writeFile(join(root, "OCTOBER_2026", "31_OCTOBER_2026", "BTN_RAJ_BREAKING_7_4MB.txt"), Buffer.alloc(4 * 1024 * 1024, 0x41));

    let now = new Date("2026-10-31T09:00:00Z"); // 14:30 IST on the 31st: yesterday still read
    const src = new BreakingShareSource(root, { now: () => now });
    expect((await src.list()).map((f) => f.path).sort()).toEqual([
      "OCTOBER_2026/30_OCTOBER_2026/BTN_RAJ_BREAKING_1_30OCT_NDR_JPR_BIG.txt",
      "OCTOBER_2026/31_OCTOBER_2026/BTN_RAJ_BREAKING_2_31OCT_NDR_JPR_BIG.txt",
      "OCTOBER_2026/31_OCTOBER_2026/BTN_RAJ_BREAKING_7_4MB.txt",
      "OCTOBER_2026/31_OCTOBER_2026/BTN_RJ_BRAKING_5_31OCT.txt",
      // The national flash is taken (owner, 15 Nov 2026); SCROLL is not
      "OCTOBER_2026/31_OCTOBER_2026/nat_flash_rj_breaking_4.txt",
    ]);
    expect(src.health()).toMatchObject({ reachable: true, todayFolder: "OCTOBER_2026/31_OCTOBER_2026", alsoScanning: "OCTOBER_2026/30_OCTOBER_2026", filesToday: 4 });
    expect((await src.read("OCTOBER_2026/31_OCTOBER_2026/BTN_RAJ_BREAKING_7_4MB.txt")).length).toBe(4 * 1024 * 1024);

    // November has no folder yet: yesterday's still listed, no error
    now = new Date("2026-11-01T03:00:00Z");
    expect(await src.list()).toHaveLength(4);
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

  it("watches today's and yesterday's folders: a .txt change calls onChange; the day moving on swaps the watches", async () => {
    const root = "/share";
    const tree: Record<string, string[]> = {
      [root]: ["OCTOBER_2026", "NOVEMBER_2026"],
      [`${root}/OCTOBER_2026`]: ["30_OCTOBER_2026", "31_OCTOBER_2026"],
      [`${root}/NOVEMBER_2026`]: ["01_NOVEMBER_2026"],
    };
    const born = new Date("2026-10-31T08:59:00Z");
    const watched = new Map<string, { emit: (name: string | null) => void; fail: (err: unknown) => void; closed: boolean }>();
    let failNext = false;
    const fakeFs: ShareFs = {
      readdir: async (p) => {
        const key = p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
        const dirs = tree[key];
        if (dirs) return dirs.map((name) => ({ name, isDirectory: () => true, isFile: () => false }));
        return [{ name: "BTN_RAJ_BREAKING_1_31OCT.txt", isDirectory: () => false, isFile: () => true }];
      },
      stat: async () => ({ size: 10, mtime: new Date("2026-10-31T09:00:00Z"), birthtime: born }),
      readFileBounded: async () => Buffer.from("x"),
      watch: (p, onEvent, onError) => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("no watch"), { code: "EPERM" });
        }
        const key = p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
        const w = { emit: onEvent, fail: onError, closed: false };
        watched.set(key, w);
        return { close: () => void (w.closed = true) };
      },
    };
    let changes = 0;
    let now = new Date("2026-10-31T09:00:00Z");
    const src = new BreakingShareSource(root, { fs: fakeFs, now: () => now, onChange: () => void changes++ });

    // The file's creation time on the share comes through as addedAt
    expect((await src.list())[0]).toMatchObject({ addedAt: born });
    const live = () => [...watched].filter(([, w]) => !w.closed).map(([k]) => k).sort();
    expect(live()).toEqual([`${root}/OCTOBER_2026/30_OCTOBER_2026`, `${root}/OCTOBER_2026/31_OCTOBER_2026`]);

    // A text file added or saved: one change each; anything else (a temp file) is not one; no name might be one
    watched.get(`${root}/OCTOBER_2026/31_OCTOBER_2026`)!.emit("BTN_RAJ_BREAKING_2_31OCT.txt");
    watched.get(`${root}/OCTOBER_2026/31_OCTOBER_2026`)!.emit("~$temp.tmp");
    watched.get(`${root}/OCTOBER_2026/30_OCTOBER_2026`)!.emit(null);
    expect(changes).toBe(2);

    // Listing again changes nothing; the next day: the 30th's watch stops, the 1st's starts
    await src.list();
    expect(live()).toHaveLength(2);
    now = new Date("2026-11-01T03:00:00Z");
    await src.list();
    expect(live()).toEqual([`${root}/NOVEMBER_2026/01_NOVEMBER_2026`, `${root}/OCTOBER_2026/31_OCTOBER_2026`]);

    // A watch that errors is dropped and started again on the next listing; one that cannot start is tried again too
    watched.get(`${root}/OCTOBER_2026/31_OCTOBER_2026`)!.fail(new Error("network name no longer available"));
    expect(live()).toEqual([`${root}/NOVEMBER_2026/01_NOVEMBER_2026`]);
    failNext = true;
    await src.list();
    expect(live()).toEqual([`${root}/NOVEMBER_2026/01_NOVEMBER_2026`]);
    await src.list();
    expect(live()).toEqual([`${root}/NOVEMBER_2026/01_NOVEMBER_2026`, `${root}/OCTOBER_2026/31_OCTOBER_2026`]);

    // close() stops every watch
    await src.close();
    expect(live()).toEqual([]);
  });

  it("a share that fails every watch: after three failures in a row it stops asking and says so once; scans carry on", async () => {
    const root = "/share";
    const tree: Record<string, string[]> = { [root]: ["OCTOBER_2026"], [`${root}/OCTOBER_2026`]: ["30_OCTOBER_2026", "31_OCTOBER_2026"] };
    const fails: ((err: unknown) => void)[] = [];
    let started = 0;
    const fakeFs: ShareFs = {
      readdir: async (p) => {
        const dirs = tree[p.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")];
        return dirs ? dirs.map((name) => ({ name, isDirectory: () => true, isFile: () => false })) : [];
      },
      stat: async () => ({ size: 1, mtime: new Date() }),
      readFileBounded: async () => Buffer.from(""),
      watch: (_p, _onEvent, onError) => {
        started++;
        fails.push(onError);
        return { close: () => undefined };
      },
    };
    const warn = vi.fn();
    const quiet = { warn, info: () => undefined, debug: () => undefined, error: () => undefined } as unknown as pino.Logger;
    const src = new BreakingShareSource(root, { fs: fakeFs, log: quiet, now: () => new Date("2026-10-31T09:00:00Z"), onChange: () => undefined });
    // Each watch fails as soon as it starts (as Node reports "UNKNOWN: unknown error, watch" on such a server)
    for (let i = 0; i < 4; i++) {
      await src.list();
      while (fails.length) fails.shift()!(new Error("UNKNOWN: unknown error, watch"));
    }
    expect(started).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatch(/does not send change notices/);
    // Listing still works, and no watch is asked for again
    expect(await src.list()).toEqual([]);
    expect(started).toBe(4);
  });

  it("without onChange nothing is watched", async () => {
    let watches = 0;
    const fakeFs: ShareFs = {
      readdir: async (p) =>
        /_2026$/.test(p) && !/OCTOBER_2026$/.test(p)
          ? [{ name: "a.txt", isDirectory: () => false, isFile: () => true }]
          : [{ name: /OCTOBER_2026$/.test(p) ? "31_OCTOBER_2026" : "OCTOBER_2026", isDirectory: () => true, isFile: () => false }],
      stat: async () => ({ size: 1, mtime: new Date() }),
      readFileBounded: async () => Buffer.from(""),
      watch: () => {
        watches++;
        return { close: () => undefined };
      },
    };
    await new BreakingShareSource("/share", { fs: fakeFs, now: () => new Date("2026-10-31T09:00:00Z") }).list();
    expect(watches).toBe(0);
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

  it("received_at is the file's last save when taken; a re-save keeps it; an update of a posted story takes its save time", async () => {
    const files = new Map<string, { bytes: Buffer; mtime: Date; addedAt: Date | null }>();
    const source: FileSource = {
      list: async () => [...files].map(([path, f]) => ({ path, name: path.split("/").pop()!, size: f.bytes.length, mtime: f.mtime, addedAt: f.addedAt })),
      read: async (p) => files.get(p)!.bytes,
      close: async () => undefined,
    };
    const ingest = new Ingest({ db: h.db, storage: store, source, orgId, log, now: () => clock, layout: "breaking" });
    const run = async () => {
      await ingest.scan();
      clock += 1500;
      const taken = await ingest.scan();
      while (await convertNext(h.db, store, log, data));
      while (await composeNext(h.db, new Dictionaries(h.db, orgId), log, { cardOnDemand: true, data, exploreRate: 0 }));
      return taken;
    };
    const text = (headline: string) => Buffer.from(`x\n\nजयपुर: ${headline}\nपुलिस मौके पर पहुंची\n`);
    const at = (ms: number) => new Date(clock + ms);
    // The newest story whose current file has this path (an update of a posted story is a second one)
    const story = async (path: string) =>
      (await h.db.select().from(stories).innerJoin(ingestedFiles, eq(ingestedFiles.id, stories.fileId)).where(eq(ingestedFiles.sourcePath, path)).orderBy(sql`${stories.createdAt} DESC`))[0]!.stories;

    // Saved on the share in the order A, B; taken in together: each sorts at its own last save (Explorer's "Date
    // modified", owner 19 Nov 2026), not its creation: a copy made earlier and written later sorts at the writing
    const A = "OCTOBER_2026/29_OCTOBER_2026/BTN_RJ_BREAKING_1_29OCT_A.txt";
    const B = "OCTOBER_2026/29_OCTOBER_2026/BTN_RJ_BREAKING_2_29OCT_B.txt";
    files.set(A, { bytes: text("पहली खबर"), mtime: at(-60_000), addedAt: at(-90_000) });
    files.set(B, { bytes: text("दूसरी खबर"), mtime: at(-30_000), addedAt: at(-40_000) });
    expect(await run()).toBe(2);
    const a = await story(A);
    expect(a.receivedAt.getTime()).toBe(clock - 1500 - 60_000);
    expect((await story(B)).receivedAt.getTime()).toBe(clock - 1500 - 30_000);

    // Saved again with new text (its creation time is unchanged, its mtime new): the story keeps its place
    files.set(A, { bytes: text("पहली खबर, नया अपडेट"), mtime: at(0), addedAt: files.get(A)!.addedAt });
    expect(await run()).toBe(1);
    expect((await story(A)).receivedAt.getTime()).toBe(a.receivedAt.getTime());

    // Posted, then saved again: the update is a new story, placed at that save's time
    const [draftA] = await h.db.select().from(postDrafts).where(eq(postDrafts.storyId, a.id));
    await h.db.update(postDrafts).set({ status: "published" }).where(eq(postDrafts.id, draftA!.id));
    const saved = at(0);
    files.set(A, { bytes: text("पहली खबर, दूसरा अपडेट"), mtime: saved, addedAt: files.get(A)!.addedAt });
    expect(await run()).toBe(1);
    const update = await story(A);
    expect(update.id).not.toBe(a.id);
    expect(update.receivedAt.getTime()).toBe(saved.getTime());

    // No creation time: the mtime; a time far ahead of this clock (a wrong server clock): now
    const C = "OCTOBER_2026/29_OCTOBER_2026/BTN_RJ_BREAKING_3_29OCT_C.txt";
    const D = "OCTOBER_2026/29_OCTOBER_2026/BTN_RJ_BREAKING_4_29OCT_D.txt";
    const cMtime = at(-5_000);
    files.set(C, { bytes: text("तीसरी खबर"), mtime: cMtime, addedAt: null });
    files.set(D, { bytes: text("चौथी खबर"), mtime: at(3_600_000), addedAt: at(3_600_000) });
    expect(await run()).toBe(2);
    expect((await story(C)).receivedAt.getTime()).toBe(cMtime.getTime());
    expect((await story(D)).receivedAt.getTime()).toBe(clock);
  }, 60_000);

  it("a file deleted from the share after it was taken: the newest 4 stories, posted or not, get file_deleted; back again, it goes", async () => {
    const files = new Map<string, { bytes: Buffer; mtime: Date; addedAt: Date }>();
    let listing: "all" | "empty" = "all";
    const source: FileSource = {
      list: async () => (listing === "empty" ? [] : [...files].map(([path, f]) => ({ path, name: path.split("/").pop()!, size: f.bytes.length, mtime: f.mtime, addedAt: f.addedAt }))),
      read: async (p) => files.get(p)!.bytes,
      close: async () => undefined,
    };
    const ingest = new Ingest({ db: h.db, storage: store, source, orgId, log, now: () => clock, layout: "breaking" });
    const pipeline = async () => {
      while (await convertNext(h.db, store, log, data));
      while (await composeNext(h.db, new Dictionaries(h.db, orgId), log, { cardOnDemand: true, data, exploreRate: 0 }));
    };
    /** One scan; the clock moves on 1.5 s (the 2 s poll) */
    const tick = async () => {
      await ingest.scan();
      clock += 1500;
    };
    /** Story number → whether it carries file_deleted */
    const byNo = async () => {
      const rows = await h.db.select({ path: ingestedFiles.sourcePath, needsCheck: stories.needsCheck }).from(stories).innerJoin(ingestedFiles, eq(ingestedFiles.id, stories.fileId));
      return Object.fromEntries(rows.map((r) => [Number(/BREAKING_(\d+)_/.exec(r.path)![1]), r.needsCheck.includes("file_deleted")]));
    };
    const path = (n: number) => `OCTOBER_2026/29_OCTOBER_2026/BTN_RJ_BREAKING_${n}_29OCT_X.txt`;
    const text = (n: number) => Buffer.from(`x\n\nजयपुर: खबर नंबर ${n}\nपुलिस मौके पर पहुंची\n`);
    // Five stories added a minute apart: 1 is the oldest, 5 the newest; 1 is outside the newest 4
    for (let n = 1; n <= 5; n++) files.set(path(n), { bytes: text(n), mtime: new Date(clock - (6 - n) * 60_000), addedAt: new Date(clock - (6 - n) * 60_000) });
    await tick();
    await tick();
    await pipeline();
    expect(await byNo()).toEqual({ 1: false, 2: false, 3: false, 4: false, 5: false });

    // 5 (newest, waiting) and 3 (posted) are deleted from the share; 1 (outside the newest 4) too
    const [s3] = await h.db.select({ id: stories.id }).from(stories).innerJoin(ingestedFiles, eq(ingestedFiles.id, stories.fileId)).where(eq(ingestedFiles.sourcePath, path(3)));
    await h.db.update(postDrafts).set({ status: "published" }).where(eq(postDrafts.storyId, s3!.id));
    const kept = new Map(files);
    for (const n of [1, 3, 5]) files.delete(path(n));
    // One scan that misses them is not enough (a share hiccup): nothing yet
    await tick();
    expect(await byNo()).toEqual({ 1: false, 2: false, 3: false, 4: false, 5: false });
    // Missed again 1.5 s later: deleted. The posted story too; the oldest (not among the newest 4) is not checked
    await tick();
    expect(await byNo()).toEqual({ 1: false, 2: false, 3: true, 4: false, 5: true });
    // The flag stays through more scans and the pipeline, and is written once (no duplicates)
    await tick();
    await pipeline();
    const [row5] = await h.db.select({ needsCheck: stories.needsCheck }).from(stories).innerJoin(ingestedFiles, eq(ingestedFiles.id, stories.fileId)).where(eq(ingestedFiles.sourcePath, path(5)));
    expect(row5!.needsCheck.filter((c) => c === "file_deleted")).toHaveLength(1);

    // An empty listing (the share answered nothing) judges nothing: no flag is added or removed
    listing = "empty";
    await tick();
    await tick();
    expect(await byNo()).toEqual({ 1: false, 2: false, 3: true, 4: false, 5: true });
    listing = "all";

    // 5 is put back (the same file): its flag goes at once; 3 stays deleted
    files.set(path(5), kept.get(path(5))!);
    await tick();
    expect(await byNo()).toEqual({ 1: false, 2: false, 3: true, 4: false, 5: false });
    // The posted draft was never touched
    expect((await h.db.select({ status: postDrafts.status }).from(postDrafts).where(eq(postDrafts.storyId, s3!.id)))[0]!.status).toBe("published");
  }, 60_000);

  it("reads a Notepad Unicode (UTF-16) file into the queue, and rejects a file that is not text (no draft)", async () => {
    const ingest = ingestFor();
    expect(await settle(ingest)).toBe(0); // first start: nothing there
    const text = "जयपुर: सड़क हादसे में दो घायल\nपुलिस मौके पर पहुंची\n";
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    await writeFile(join(day("29_OCTOBER_2026"), "BTN_RJ_BREAKING_7001_29OCT_US_CONTROL_JPR_big.txt"), le);
    await utimes(join(day("29_OCTOBER_2026"), "BTN_RJ_BREAKING_7001_29OCT_US_CONTROL_JPR_big.txt"), new Date(clock), new Date(clock));
    await put("29_OCTOBER_2026", "BTN_RJ_BREAKING_7002_29OCT_US_CONTROL_big.txt", "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0001\u0000");
    expect(await settle(ingest)).toBe(2);

    const all = await h.db.select().from(stories);
    expect(all.find((s) => s.sourceCharset === "utf-16le")).toMatchObject({ status: "composed", headline: expect.stringContaining("सड़क हादसे") });
    const bad = all.find((s) => s.status === "failed")!;
    expect(bad.lastError).toMatch(/binary data/);
    // Rejected: no draft, so nothing for the queue
    const drafts = await h.db.select().from(postDrafts);
    expect(drafts.map((d) => d.storyId)).not.toContain(bad.id);
    expect(drafts).toHaveLength(1);
  }, 60_000);

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
    // Every story carries our reporter now (owner, 20 Nov 2026), a crime story too, so the unknown name is raised
    // for the desk; it is still stored, which is what lets an editor's own edit teach it.
    expect((draft!.handlePick as { warnings: string[] }).warnings.join(" ")).toMatch(/reporter list/);
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

  it("P5: a broken party-handles.json turns the reporter prior and beats off, says so loudly, and the draft keeps its normal tags", async () => {
    // Nirmal (file-name token NIRMAL): a measured prior (@RajGovOfficial) and a desk-declared tourism beat
    // (@KumariDiya on "पर्यटन"). The same copy, filed twice: once with every directory file good, once with a
    // half-saved party file.
    const copy = "पर्यटन विभाग की नई योजना पर बैठक\nप्रदेश में पर्यटकों की संख्या बढ़ाने पर चर्चा\n";
    const draftFor = async (name: string, d: ReturnType<typeof phaseOneData>, lg: pino.Logger) => {
      const ingest = ingestFor();
      expect(await settle(ingest)).toBe(0);
      await put("29_OCTOBER_2026", name, `${name.replace(/\.txt$/, "")}\n\n${copy}`);
      await ingest.scan();
      clock += 3000;
      expect(await ingest.scan()).toBe(1);
      while (await convertNext(h.db, store, lg, d));
      while (await composeNext(h.db, new Dictionaries(h.db, orgId), lg, { cardOnDemand: true, data: d, exploreRate: 0 }));
      const [story] = await h.db.select().from(stories).where(eq(stories.status, "composed"));
      const [draft] = await h.db.select().from(postDrafts).where(eq(postDrafts.storyId, story!.id));
      return draft!;
    };
    const pick = (dr: typeof postDrafts.$inferSelect) => dr.handlePick as { suggested: { handle: string; reason: string }[]; warnings: string[]; reporterToken: string | null };

    const good = await draftFor("BTN_RJ_BREAKING_7001_29OCT_US_CONTROL_NIRMAL_big.txt", data, log);
    expect(pick(good).reporterToken).toBe("NIRMAL");
    const offered = pick(good).suggested.filter((s) => s.reason === "prior" || s.reason === "beat").map((s) => `${s.handle} (${s.reason})`);
    expect(offered).toEqual(expect.arrayContaining(["@RajGovOfficial (prior)", "@KumariDiya (beat)"]));

    await h.db.execute(sql`TRUNCATE published_posts, post_drafts, stories, ingested_files, kv CASCADE`);
    // The party file loads, then is half-saved: its loader keeps the last good copy for the normal tags
    const parties = join(dir, "party-handles.json");
    await copyFile(new URL("../config/party-handles.json", import.meta.url), parties);
    const lines: { level: number; msg?: string; files?: { file: string }[] }[] = [];
    const capture = pino({ level: "error" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const broken = phaseOneData(capture, undefined, { PARTY_HANDLES_FILE: parties });
    await broken.parties.get();
    await writeFile(parties, '{ "version": 1, "entries": [ { "handle": "@INCRaj');
    await utimes(parties, new Date(), new Date(Date.now() + 5_000));
    (broken.parties as unknown as { checkedAt: number }).checkedAt = 0;
    const bad = await draftFor("BTN_RJ_BREAKING_7002_29OCT_US_CONTROL_NIRMAL_big.txt", broken, capture);

    // No prior and no beat suggestion this run
    expect(pick(bad).suggested.filter((s) => s.reason === "prior" || s.reason === "beat")).toEqual([]);
    expect(pick(bad).warnings).toContain("the reporter prior and declared beats are off: the parties directory file did not load");
    // The error, naming the file
    expect(lines.some((l) => /reporter prior and declared beats are OFF: the directory file parties \(/.test(l.msg ?? "") && l.files?.[0]?.file === "parties")).toBe(true);
    // Drafting did not stop, and the post is the one the good run made: the same text, tags and handles
    expect(bad).toMatchObject({ status: "ready", bodyText: good.bodyText, hashtags: good.hashtags, mentions: good.mentions, hashtagSuggestions: good.hashtagSuggestions });
    expect(pick(bad).suggested).toEqual(pick(good).suggested.filter((s) => s.reason !== "prior" && s.reason !== "beat"));
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

  it("re-saved as junk or with no text: the earlier unposted draft leaves the queue, to Failed with the reason (M1)", async () => {
    const ingest = ingestFor();
    await settle(ingest);
    const name = "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt";
    await put("29_OCTOBER_2026", name, fixture(name));
    expect(await settle(ingest)).toBe(1);
    const [first] = await h.db.select().from(postDrafts);
    expect(first).toMatchObject({ status: "ready" });

    // Saved again as binary junk
    clock += 60_000;
    await put("29_OCTOBER_2026", name, "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0001\u0000");
    expect(await settle(ingest)).toBe(1);
    const [gone] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, first!.id));
    expect(gone).toMatchObject({ status: "failed", claimedBy: null, version: first!.version + 1 });
    expect(gone!.renderError).toMatch(/saved again and can't be used: .*binary data/);
    expect((await h.db.select().from(stories).where(eq(stories.id, first!.storyId)))[0]).toMatchObject({ status: "failed" });

    // A good save after that: the story is read again and composed; still one draft for it, nothing doubles up
    clock += 60_000;
    await put("29_OCTOBER_2026", name, `${name}\n\nकोटा में हिस्ट्रीशीटर के घर में तोड़फोड़, दो गिरफ्तार\nपुलिस ने दो आरोपियों को पकड़ा\n`);
    expect(await settle(ingest)).toBe(1);
    const back = await h.db.select().from(postDrafts).where(eq(postDrafts.storyId, first!.storyId));
    expect(back).toHaveLength(1);
    // ...and the withdrawn draft is back in the queue with the new text
    expect(back[0]).toMatchObject({ id: first!.id, status: "ready", renderError: null });
    expect(back[0]!.bodyText).toContain("दो गिरफ्तार");
    expect((await h.db.select().from(stories).where(eq(stories.id, first!.storyId)))[0]).toMatchObject({ status: "composed" });

    // A posted draft is never touched by a bad re-save
    const other = "BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt";
    await put("29_OCTOBER_2026", other, fixture(other));
    await settle(ingest);
    const [posted] = await h.db.select().from(postDrafts).innerJoin(stories, eq(stories.id, postDrafts.storyId)).where(eq(stories.slug, (await h.db.select().from(stories)).find((s) => s.district === "Dausa")!.slug));
    await h.db.update(postDrafts).set({ status: "published" }).where(eq(postDrafts.id, posted!.post_drafts.id));
    clock += 60_000;
    await put("29_OCTOBER_2026", other, "");
    await settle(ingest);
    expect((await h.db.select().from(postDrafts).where(eq(postDrafts.id, posted!.post_drafts.id)))[0]).toMatchObject({ status: "published" });
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
