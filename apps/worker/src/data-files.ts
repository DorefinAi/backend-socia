// The phase-1 data files (config/rajasthan-places.json, config/district-handles.json, config/subject-handles.json):
// edited without a code
// change and read again when they change (checked at most once a minute). A broken edit keeps the last good
// copy and logs why, so a typo never stops the desk. Whether each file is readable goes to /ingest/status.

import {
  DataFileRejected, EMPTY_BEAT_RULES, EMPTY_HANDLE_RULES, EMPTY_NORMALISER, EMPTY_PARTY_RULES, EMPTY_REPORTER_RULES, EMPTY_SUBJECT_RULES, EMPTY_SUGGEST_RULES, PlaceBook,
  parseBeatHandles, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules,
  type BeatRules, type HandleRules, type PartyRules, type ReporterRules, type SubjectRules, type SuggestRules, type TagNormaliser,
} from "@socia/core";
import type { DataFileStatus } from "@socia/db";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const RECHECK_MS = 60_000;

export const PLACES_FILE = fileURLToPath(new URL("../config/rajasthan-places.json", import.meta.url));
export const DISTRICT_HANDLES_FILE = fileURLToPath(new URL("../config/district-handles.json", import.meta.url));
export const SUBJECT_HANDLES_FILE = fileURLToPath(new URL("../config/subject-handles.json", import.meta.url));
export const REPORTER_HANDLES_FILE = fileURLToPath(new URL("../config/reporter-handles.json", import.meta.url));
export const PARTY_HANDLES_FILE = fileURLToPath(new URL("../config/party-handles.json", import.meta.url));
export const HASHTAG_NORMALISE_FILE = fileURLToPath(new URL("../config/hashtag-normalise.json", import.meta.url));
export const CAMPAIGNS_FILE = fileURLToPath(new URL("../config/campaigns.json", import.meta.url));
export const BEAT_HANDLES_FILE = fileURLToPath(new URL("../config/beat-handles.json", import.meta.url));

/** A data file the pipeline needs is not readable: retry later, do not fail the story */
export class DataUnavailable extends Error {
  constructor(readonly file: DataFileStatus["file"], cause: unknown) {
    super(`The ${file} data file cannot be read: ${(cause as Error)?.message ?? cause}`);
    this.name = "DataUnavailable";
  }
}

/** The version a fallback value carries: never a file's (a file's is its mtime) */
const FALLBACK_VERSION = "0";

export type OnDataStatus = (status: DataFileStatus) => void | Promise<void>;

export class JsonDataFile<T> {
  private cached: { value: T; version: string } | null = null;
  private checkedAt = 0;
  private mtimeMs: number | null = null;
  private lastOk: boolean | null = null;
  private lastMessage: string | null = null;
  /** The mtime of a version that failed its checks: not parsed or reported again until the file changes */
  private rejectedMtime: number | null = null;

  constructor(
    private readonly name: DataFileStatus["file"],
    private readonly path: string,
    /** Parses the JSON; reports skipped entries through `problem` */
    private readonly parse: (json: unknown, problem: (message: string) => void) => T,
    private readonly log: Logger,
    /** Used (and cached like a real read) when there has never been a good read; without it the file is required */
    private readonly fallback?: T,
    private readonly onStatus?: OnDataStatus,
  ) {}

  /** The value last loaded (a good read or the fallback), without reading the file; null before the first get() */
  current(): T | null {
    return this.cached?.value ?? null;
  }

  /** The value last read from the FILE (never the fallback), without reading it; null when there is none yet */
  loaded(): T | null {
    return this.cached && this.cached.version !== FALLBACK_VERSION ? this.cached.value : null;
  }

  private async report(ok: boolean, message?: string, skipped?: number): Promise<void> {
    if (this.lastOk === ok && ok) return;
    // The same failure once, not once a minute
    if (!ok && this.lastOk === false && this.lastMessage === (message ?? null)) return;
    this.lastOk = ok;
    this.lastMessage = message ?? null;
    await Promise.resolve(this.onStatus?.({ file: this.name, ok, at: new Date().toISOString(), ...(message && { message }), ...(skipped && { skipped }) })).catch((err) =>
      this.log.error({ err }, "could not record the data file status"),
    );
  }

  async get(): Promise<{ value: T; version: string }> {
    const now = Date.now();
    if (now - this.checkedAt < RECHECK_MS && this.cached) return this.cached;
    this.checkedAt = now;
    let seen: number | null = null;
    try {
      const { mtimeMs } = await stat(this.path);
      seen = mtimeMs;
      // The version that was rejected, unchanged: keep what we have, say nothing new
      if (mtimeMs === this.rejectedMtime && this.cached) return this.cached;
      if (mtimeMs !== this.mtimeMs || !this.cached) {
        const problems: string[] = [];
        const value = this.parse(JSON.parse(await readFile(this.path, "utf8")), (m) => problems.push(m));
        this.cached = { value, version: String(Math.round(mtimeMs)) };
        this.mtimeMs = mtimeMs;
        this.rejectedMtime = null;
        if (problems.length) this.log.warn({ file: this.name, problems }, "data file entries skipped");
        this.log.info({ file: this.name, path: this.path }, "data file loaded");
        await this.report(true, undefined, problems.length);
      }
    } catch (err) {
      const keeping = this.cached ? "using the last good copy" : this.fallback !== undefined ? "using none" : "breaking stories wait for it";
      if (err instanceof DataFileRejected) {
        // A file that fails its checks is refused WHOLE, loudly (b6 fix brief P5): every problem in the log and
        // in /ingest/status, never a quiet skip of the bad entry. Once per version of the file.
        this.rejectedMtime = seen;
        this.log.error({ file: this.name, path: this.path, problems: err.problems }, `data file rejected; ${keeping}`);
        await this.report(false, `The ${this.name} file was rejected (${err.problems.length} problem${err.problems.length === 1 ? "" : "s"}: ${err.problems.slice(0, 3).join("; ")}${err.problems.length > 3 ? "; ..." : ""}); ${keeping}. Fix the file; nothing in it is used until it passes.`);
      } else {
        this.log.error({ err, file: this.name, path: this.path }, `data file could not be read; ${keeping}`);
        await this.report(false, `The ${this.name} file could not be read; ${keeping}.`);
      }
      if (!this.cached && this.fallback !== undefined) this.cached = { value: this.fallback, version: FALLBACK_VERSION };
      if (!this.cached) {
        // Try again on the next story rather than after a minute: the desk is waiting
        this.checkedAt = 0;
        throw new DataUnavailable(this.name, err);
      }
    }
    return this.cached;
  }
}

/**
 * The district tags of the places file, as known-good hashtag-normalise targets ("Sawaimadhopur" → "SawaiMadhopur").
 * The places file already loaded when there is one, else read here; none when it cannot be read (then a district
 * target has to be in the normalise file's own "known" list).
 */
function placeTags(places: JsonDataFile<PlaceBook>, path: string): string[] {
  const book = places.current() ?? (() => {
    try {
      return new PlaceBook(parsePlacesData(JSON.parse(readFileSync(path, "utf8"))));
    } catch {
      return null;
    }
  })();
  return book ? book.districts.map((d) => d.tag) : [];
}

export interface PhaseOneData {
  places: JsonDataFile<PlaceBook>;
  handles: JsonDataFile<HandleRules>;
  /** The people and organisations stories are about, and their handles */
  subjects: JsonDataFile<SubjectRules>;
  /** 1st India's own reporters, keyed on the token in the breaking file name */
  reporters: JsonDataFile<ReporterRules>;
  /** State and national party handles, tagged on campaign and party-activity copy */
  parties: JsonDataFile<PartyRules>;
  /** The desk's hashtag typos and their canonical spelling */
  normalise: JsonDataFile<TagNormaliser>;
  /** Campaign and keyword tags offered to the desk */
  campaigns: JsonDataFile<SuggestRules>;
  /** Desk-declared reporter beats and the handles each offers when its keywords match (reporter-prior brief §3.3) */
  beats: JsonDataFile<BeatRules>;
}

interface DirectorySources {
  handles: JsonDataFile<HandleRules>;
  subjects: JsonDataFile<SubjectRules>;
  parties: JsonDataFile<PartyRules>;
  /** Absent when the reporters file itself is being checked: it adds its own handles */
  reporters?: JsonDataFile<ReporterRules>;
}

interface DirectoryInfo {
  /** Every handle the directory files carry, lower-cased without the @ */
  directory: Set<string>;
  /** Every police and collector handle, verified or not (HandleRules.bound) */
  bound: Set<string>;
  /** The CM's office-alias handles and the state government's: no beat may carry them */
  stateHandles: Set<string>;
  /** Every source was read from its file: false when one could not be (it then adds nothing) */
  complete: boolean;
}

/**
 * What a reporter's prior or a declared beat may offer (a handle is never invented) and must never offer (police,
 * collectors, the CM and state government). The copies already loaded from file when there are; else each file is
 * read here ONCE for this check (they are re-read only when the checked file itself changes). A file that cannot
 * be read adds nothing and is logged.
 */
function directoryInfo(files: DirectorySources, env: NodeJS.ProcessEnv, log: Logger): DirectoryInfo {
  let complete = true;
  const read = <T>(f: JsonDataFile<T>, name: string, path: string, parse: (j: unknown) => T): T | null => {
    const cur = f.loaded();
    if (cur) return cur;
    try {
      return parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      complete = false;
      log.warn({ err, file: name, path }, "directory file could not be read for the reporter-prior checks; its handles count as unknown");
      return null;
    }
  };
  const lc = (hs: Iterable<string> | undefined) => [...(hs ?? [])].map((h) => h.replace(/^@/, "").toLowerCase());
  const handles = read(files.handles, "handles", env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j) => parseHandleRules(j));
  const subjects = read(files.subjects, "subjects", env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE, (j) => parseSubjectHandles(j));
  const parties = read(files.parties, "parties", env.PARTY_HANDLES_FILE ?? PARTY_HANDLES_FILE, (j) => parsePartyHandles(j));
  const reporters = files.reporters ? read(files.reporters, "reporters", env.REPORTER_HANDLES_FILE ?? REPORTER_HANDLES_FILE, (j) => parseReporterHandles(j)) : null;
  return {
    directory: new Set([...lc(handles?.all), ...lc(subjects?.handles), ...lc(parties?.handles), ...lc(reporters?.handles)]),
    bound: new Set(lc(handles?.bound)),
    stateHandles: new Set([...lc(handles?.state.government), ...lc(handles?.state.cm), ...(subjects?.offices ?? []).flatMap((o) => lc(o.handles))]),
    complete,
  };
}

export function phaseOneData(log: Logger, onStatus?: OnDataStatus, env = process.env): PhaseOneData {
  const placesPath = env.PLACES_FILE ?? PLACES_FILE;
  const places = new JsonDataFile("places", placesPath, (j, problem) => new PlaceBook(parsePlacesData(j, problem)), log, undefined, onStatus);
  // No handles file: posts go out without handles rather than wait
  const handles = new JsonDataFile("handles", env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j) => parseHandleRules(j), log, EMPTY_HANDLE_RULES, onStatus);
  // No subjects file (or a broken one at start): no subject handles
  const subjects = new JsonDataFile("subjects", env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE, (j, problem) => parseSubjectHandles(j, problem), log, EMPTY_SUBJECT_RULES, onStatus);
  // No reporters file: posts go out without a byline rather than wait
  // No party file: political posts go out with the leader and the reporter, no party handle
  const parties = new JsonDataFile("parties", env.PARTY_HANDLES_FILE ?? PARTY_HANDLES_FILE, (j, problem) => parsePartyHandles(j, problem), log, EMPTY_PARTY_RULES, onStatus);
  // No reporters file: posts go out without a byline rather than wait. A prior naming a police or collector handle,
  // or one in no directory file, rejects the file; when a directory file cannot be read the directory part of that
  // check waits for the composer (which drops any handle outside the directory) rather than take every byline down
  const reporters = new JsonDataFile("reporters", env.REPORTER_HANDLES_FILE ?? REPORTER_HANDLES_FILE, (j, problem) => {
    const d = directoryInfo({ handles, subjects, parties }, env, log);
    if (!d.complete) problem("a directory file could not be read, so the prior's handles were checked against police and collectors only");
    return parseReporterHandles(j, problem, d.complete ? { directory: d.directory, bound: d.bound } : { bound: d.bound });
  }, log, EMPTY_REPORTER_RULES, onStatus);
  return {
    places,
    handles,
    subjects,
    reporters,
    parties,
    // No beats file (or one naming a handle in no directory file): no declared-beat suggestions
    beats: new JsonDataFile("beats", env.BEAT_HANDLES_FILE ?? BEAT_HANDLES_FILE, (j, problem) => {
      const d = directoryInfo({ handles, subjects, parties, reporters }, env, log);
      return parseBeatHandles(j, d.directory, { bound: d.bound, stateHandles: d.stateHandles, reporters: reporters.loaded() ?? undefined, problem });
    }, log, EMPTY_BEAT_RULES, onStatus),
    // No normalise file: typos stay as the desk typed them (still flagged near the brand tags)
    normalise: new JsonDataFile("normalise", env.HASHTAG_NORMALISE_FILE ?? HASHTAG_NORMALISE_FILE, (j, problem) => parseHashtagNormalise(j, problem, placeTags(places, placesPath)), log, EMPTY_NORMALISER, onStatus),
    // No campaigns file: no campaign or keyword tags offered
    campaigns: new JsonDataFile("campaigns", env.CAMPAIGNS_FILE ?? CAMPAIGNS_FILE, (j, problem) => parseSuggestRules(j, problem), log, EMPTY_SUGGEST_RULES, onStatus),
  };
}
