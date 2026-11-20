// The phase-1 data files in apps/worker/config: the places file, the four directory files (district-, subject-, party-
// and reporter-handles.json), beat-handles.json, hashtag-normalise.json and campaigns.json. Edited without a code
// change and read again when they change: checked once a minute by the reload loop (reloadDataFiles) and on a story's
// read; a file marked broken is read again on every check whatever its timestamp (R1), and the reporters and beats
// files again whenever a directory file they are checked against changes or recovers (R5, S5). A broken edit keeps
// the last good copy and logs why — when the error changes, and once an hour while it stays (R7) — so a typo never
// stops the desk. Whether each file is readable goes to /ingest/status, from the pipeline's process only.

import {
  DataFileRejected, EMPTY_BEAT_RULES, EMPTY_HANDLE_RULES, EMPTY_NORMALISER, EMPTY_PARTY_RULES, EMPTY_REPORTER_RULES, EMPTY_SUBJECT_RULES, EMPTY_SUGGEST_RULES, PlaceBook,
  isPriorHandleType, mergeHandleTypes, parseBeatHandles, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules,
  type BeatRules, type HandleRules, type HandleType, type PartyRules, type ReporterRules, type SubjectRules, type SuggestRules, type TagNormaliser,
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

/** While a file stays broken, its error is logged again (as a reminder) this often; a new error at once (R7) */
export const BROKEN_REMINDER_MS = 60 * 60_000;

export class JsonDataFile<T> {
  private cached: { value: T; version: string } | null = null;
  private checkedAt = 0;
  private mtimeMs: number | null = null;
  private lastOk: boolean | null = null;
  private lastMessage: string | null = null;
  /** Successful parses so far: every one gets a version label of its own (S6), whatever the file's mtime */
  private parses = 0;
  /** The read under way, shared by every caller that arrives meanwhile (S4): one parse, one "back on" */
  private inflight: Promise<{ value: T; version: string }> | null = null;
  /** The dependencies' stamp the held copy was parsed against */
  private depKey: string | null = null;
  /** The error last logged and when (R7: logged when it changes, and once an hour while it stays) */
  private errorKey: string | null = null;
  private errorLoggedAt = 0;

  constructor(
    readonly name: DataFileStatus["file"],
    readonly path: string,
    /** Parses the JSON; reports skipped entries through `problem` */
    private readonly parse: (json: unknown, problem: (message: string) => void) => T,
    private readonly log: Logger,
    /** Used (and cached like a real read) when there has never been a good read; without it the file is required */
    private readonly fallback?: T,
    private readonly onStatus?: OnDataStatus,
    /**
     * The files the parse is checked against (R5 / R8 / S1 / S5, 15 Nov 2026): the reporters and beats files are
     * checked against the directory files' handles and types, using ONLY the copies those files' own loaders hold.
     * Every read of this file first brings them up to date (their own get(): a broken one is retried by its own loader
     * and logged by it, never read from disk by this one). When their stamps changed — a directory file changed or
     * recovered — this file is parsed again at once, whatever its own timestamp, so a beat handle dropped for its type
     * comes back as soon as the type is fixed, in the same story or reload tick, without a restart.
     */
    private readonly deps?: readonly { stamp(): string; get(): Promise<unknown> }[],
  ) {}

  /** This copy's identity for a dependant's `deps`: its version and whether it loaded */
  stamp(): string {
    return `${this.cached?.version ?? "-"}/${String(this.lastOk)}`;
  }

  /** get(), skipping the once-a-minute wait: the file is checked on disk now (R3: the nightly run's re-check) */
  async refresh(): Promise<{ value: T; version: string }> {
    // A read already under way may have been the quick one: let it finish, then check the disk
    if (this.inflight) await this.inflight.catch(() => undefined);
    this.checkedAt = 0;
    return this.get();
  }

  /** R7: an error is logged when it differs from the last one, and as a reminder once an hour while it stays */
  private logFailure(key: string, fields: Record<string, unknown>, message: string, tmpl: string): void {
    const now = Date.now();
    const same = key === this.errorKey;
    if (same && now - this.errorLoggedAt < BROKEN_REMINDER_MS) return;
    this.errorKey = key;
    this.errorLoggedAt = now;
    // fields.tmpl: the message without its filled-in values, so Sentry groups repeats (ops-status-contract §6)
    this.log.error({ ...fields, file: this.name, path: this.path, tmpl: same ? `${tmpl} (still broken)` : tmpl }, same ? `${message} (still broken)` : message);
  }

  /** The value last loaded (a good read or the fallback), without reading the file; null before the first get() */
  current(): T | null {
    return this.cached?.value ?? null;
  }

  /** The value last read from the FILE (never the fallback), without reading it; null when there is none yet */
  loaded(): T | null {
    return this.cached && this.cached.version !== FALLBACK_VERSION ? this.cached.value : null;
  }

  /**
   * Whether the file LOADED at its last read (P5, 15 Nov 2026): true only when that read passed and its copy is the
   * one held. False while the file is rejected, unreadable or missing — even with a last good copy still in use — and
   * before the first read. Entries skipped one by one (O2) do not count: the file itself loaded.
   */
  ok(): boolean {
    return this.lastOk === true && this.loaded() !== null;
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

  /** The file's copy, read again when it is due (once a minute, at once when broken or a dependency changed) */
  get(): Promise<{ value: T; version: string }> {
    // S4: callers that arrive while a read is under way share it, so it parses (and says "back on") once
    if (this.inflight) return this.inflight;
    const read = this.read().finally(() => {
      if (this.inflight === read) this.inflight = null;
    });
    this.inflight = read;
    return read;
  }

  private async read(): Promise<{ value: T; version: string }> {
    // S5: the dependencies first, so their stamps below are the ones this read is checked against
    if (this.deps) await Promise.all(this.deps.map((d) => d.get().catch(() => undefined)));
    const now = Date.now();
    const depKey = this.deps ? this.deps.map((d) => d.stamp()).join("|") : null;
    // A dependency changed since this copy was parsed: check it now, not after the minute (R5)
    const depsChanged = this.cached !== null && this.lastOk !== null && depKey !== this.depKey;
    if (!depsChanged && now - this.checkedAt < RECHECK_MS && this.cached) return this.cached;
    this.checkedAt = now;
    try {
      const { mtimeMs } = await stat(this.path);
      // R1 (15 Nov 2026): while the file is marked broken it is read again on every tick WHATEVER its timestamp — a
      // file restored with its old mtime (a Windows copy, a backup) or one that failed on a passing EBUSY recovers
      const broken = this.lastOk === false;
      if (broken || depsChanged || mtimeMs !== this.mtimeMs || !this.cached) {
        this.depKey = depKey;
        const problems: string[] = [];
        const value = this.parse(JSON.parse(await readFile(this.path, "utf8")), (m) => problems.push(m));
        // S6: every successful parse gets a version label of its own (mtime.parse-number), so whatever is cached by
        // version is rebuilt, and a label never repeats — not for a restored old mtime, not for a re-check
        this.parses += 1;
        this.cached = { value, version: `${Math.round(mtimeMs)}.${this.parses}` };
        this.mtimeMs = mtimeMs;
        if (problems.length) this.log.warn({ file: this.name, problems }, "data file entries skipped");
        this.log.info({ file: this.name, path: this.path }, "data file loaded");
        if (broken) this.log.info({ file: this.name, path: this.path, tmpl: "back on: {file}" }, `back on: ${this.name}`);
        this.errorKey = null;
        await this.report(true, undefined, problems.length);
      }
    } catch (err) {
      const keeping = this.cached ? "using the last good copy" : this.fallback !== undefined ? "using none" : "breaking stories wait for it";
      if (err instanceof DataFileRejected) {
        // A file that fails its checks is refused WHOLE, loudly (b6 fix brief P5): every problem in the log and
        // in /ingest/status, never a quiet skip of the bad entry. Logged when the problems change, and hourly (R7).
        this.logFailure(`rejected:${JSON.stringify(err.problems)}`, { problems: err.problems }, `data file rejected; ${keeping}`, "data file rejected; {keeping}");
        await this.report(false, `The ${this.name} file was rejected (${err.problems.length} problem${err.problems.length === 1 ? "" : "s"}: ${err.problems.slice(0, 3).join("; ")}${err.problems.length > 3 ? "; ..." : ""}); ${keeping}. Fix the file; nothing in it is used until it passes.`);
      } else {
        const e = err as { code?: unknown; message?: unknown };
        this.logFailure(`unreadable:${String(e?.code ?? "")}:${String(e?.message ?? err)}`, { err }, `data file could not be read; ${keeping}`, "data file could not be read; {keeping}");
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
  /** Each directory handle's handle_type (R2): a reporter's prior keeps institution handles only */
  types: Map<string, HandleType>;
  /** Every source was read from its file: false when one could not be (it then adds nothing) */
  complete: boolean;
}

/**
 * What a reporter's prior or a declared beat may offer (a handle is never invented) and must never offer (police,
 * collectors, the CM and state government), from the copies the directory files' OWN loaders hold — never a read of
 * the disk here (S1, 15 Nov 2026). The checked file's loader brings them up to date first (JsonDataFile `deps`). A
 * file with no loaded copy adds nothing and makes the result incomplete, silently: its own loader retries it on every
 * reload tick and logs it (R7: when the error changes, and once an hour), so this check adds no second line a minute.
 */
function directoryInfo(files: DirectorySources): DirectoryInfo {
  let complete = true;
  const read = <T>(f: JsonDataFile<T>): T | null => {
    const cur = f.loaded();
    if (!cur) complete = false;
    return cur;
  };
  const lc = (hs: Iterable<string> | undefined) => [...(hs ?? [])].map((h) => h.replace(/^@/, "").toLowerCase());
  const handles = read(files.handles);
  const subjects = read(files.subjects);
  const parties = read(files.parties);
  const reporters = files.reporters ? read(files.reporters) : null;
  return {
    directory: new Set([...lc(handles?.all), ...lc(subjects?.handles), ...lc(parties?.handles), ...lc(reporters?.handles)]),
    bound: new Set(lc(handles?.bound)),
    stateHandles: new Set([...lc(handles?.state.government), ...lc(handles?.state.cm), ...(subjects?.offices ?? []).flatMap((o) => lc(o.handles))]),
    types: mergeHandleTypes(handles?.types, subjects?.types, parties?.types, reporters?.types),
    complete,
  };
}

/** The four directory files: every handle's handle_type comes from them together (mergeHandleTypes) */
export type DirectoryFiles = Pick<PhaseOneData, "handles" | "subjects" | "parties" | "reporters">;

const directoryFiles = (data: DirectoryFiles) => [data.handles, data.subjects, data.parties, data.reporters] as const;

/**
 * The directory files that did NOT load at their last read (P5, 15 Nov 2026): rejected, unreadable, missing, or never
 * read. Any one of them turns the reporter prior and the declared beats OFF for the story being composed: a handle's
 * type is the most restrictive of the four files' (mergeHandleTypes), so a missing file could make a district or
 * police account look like an institution — and a type is never guessed from the files that did load. Normal tagging
 * is not touched: it keeps running on each file's last good copy (JsonDataFile.get).
 */
export function brokenDirectoryFiles(data: DirectoryFiles): { file: DataFileStatus["file"]; path: string }[] {
  return directoryFiles(data).filter((f) => !f.ok()).map((f) => ({ file: f.name, path: f.path }));
}

/** The directory files and the beats file, in the order each must be read: every file after the ones it is checked against */
export type CheckedFiles = DirectoryFiles & Pick<PhaseOneData, "beats">;
const inLoadOrder = (data: CheckedFiles) => [data.handles, data.subjects, data.parties, data.reporters, data.beats] as const;

/**
 * Reads the directory files and the beats file ONCE, in order (small item, 15 Nov 2026): each is parsed a single time
 * and logged a single time, and the reporters and beats checks find the directory already in memory instead of
 * reading it from disk again. A file that cannot be read is logged by its own loader and keeps its fallback.
 */
export async function loadDataFiles(data: CheckedFiles): Promise<void> {
  for (const f of inLoadOrder(data)) await f.get().catch(() => undefined);
}

/**
 * The data files of a worker process. At startup only the directory files and the beats file are read (in order,
 * once each: loadDataFiles); the places, normalise and campaigns files are read by the first reload tick, or the first
 * breaking story, whichever comes first — also once. The pipeline composes from them and the maintenance role's
 * nightly reporter features build their prior candidates from them. Null when the process has neither role. The
 * data-file status (/ingest/status) is recorded by the pipeline only, so two processes never both report it.
 */
export async function startDataFiles(opts: { pipeline: boolean; maintenance: boolean; log: Logger; onStatus?: OnDataStatus; env?: NodeJS.ProcessEnv }): Promise<PhaseOneData | null> {
  if (!opts.pipeline && !opts.maintenance) return null;
  const data = phaseOneData(opts.log, opts.pipeline ? opts.onStatus : undefined, opts.env);
  await loadDataFiles(data);
  return data;
}

/**
 * One tick of the data files' reload loop (S3, 15 Nov 2026): every 60 s, in whichever process loads the files, each
 * one is checked again the way a story would check it (JsonDataFile.get: re-parsed when changed, every tick while
 * broken: R1), so a fix shows in /ingest/status — and "back on" is logged — without waiting for a story or the nightly.
 * A changed directory file makes the reporters and beats files re-check in the same tick (S5). `all` adds the files
 * only the pipeline reads (places, normalise, campaigns). Never throws: a file that cannot be read is its own
 * loader's to log (R7).
 */
export async function reloadDataFiles(data: PhaseOneData, all: boolean): Promise<void> {
  for (const f of inLoadOrder(data)) await f.get().catch(() => undefined);
  if (all) for (const f of [data.places, data.normalise, data.campaigns]) await f.get().catch(() => undefined);
}

/** The nightly prior candidates cannot be built today: the snapshot run fails and is tried again in an hour (R4) */
export class PriorCandidatesUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriorCandidatesUnavailable";
  }
}

/**
 * The directory's INSTITUTION handles (R2, P3, D2), lower-cased without the @: the only handles the nightly reporter
 * features list as prior candidates. Owner decisions of 15 Nov 2026:
 *   R3  first the four directory files and the beats file are checked on disk again (JsonDataFile.refresh: re-parsed
 *       when changed or broken), so the nightly never works from copies older than the files;
 *   R2  while ANY directory file is broken it builds no candidates at all — the composer's rule (priorGate), never
 *       candidates from a last good copy;
 *   R4  that, or an empty list, THROWS: the run is a failure, retried every hour until it succeeds that day, and no
 *       snapshot is written meanwhile (the previous day's stays the latest).
 */
export async function nightlyInstitutions(data: CheckedFiles): Promise<Set<string>> {
  for (const f of inLoadOrder(data)) await f.refresh().catch(() => undefined);
  const broken = brokenDirectoryFiles(data);
  if (broken.length) {
    throw new PriorCandidatesUnavailable(`the ${broken.map((b) => b.file).join(", ")} directory file${broken.length === 1 ? "" : "s"} did not load (${broken.map((b) => b.path).join(", ")}): no prior candidates are built and no snapshot is written until ${broken.length === 1 ? "it loads" : "they load"}`);
  }
  const types = mergeHandleTypes(data.handles.loaded()?.types, data.subjects.loaded()?.types, data.parties.loaded()?.types, data.reporters.loaded()?.types);
  const out = new Set([...types].filter(([, t]) => isPriorHandleType(t)).map(([h]) => h));
  if (!out.size) throw new PriorCandidatesUnavailable("the directory files hold no institution handle: no prior candidates are built and no snapshot is written");
  return out;
}

export function phaseOneData(log: Logger, onStatus?: OnDataStatus, env = process.env): PhaseOneData {
  const placesPath = env.PLACES_FILE ?? PLACES_FILE;
  const places = new JsonDataFile("places", placesPath, (j, problem) => new PlaceBook(parsePlacesData(j, problem)), log, undefined, onStatus);
  // No handles file: posts go out without handles rather than wait
  // An entry without a valid handle_type is rejected alone and reported (R2); the rest of the file loads
  const handles = new JsonDataFile("handles", env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j, problem) => parseHandleRules(j, problem), log, EMPTY_HANDLE_RULES, onStatus);
  // No subjects file (or a broken one at start): no subject handles
  const subjects = new JsonDataFile("subjects", env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE, (j, problem) => parseSubjectHandles(j, problem), log, EMPTY_SUBJECT_RULES, onStatus);
  // No reporters file: posts go out without a byline rather than wait
  // No party file: political posts go out with the leader and the reporter, no party handle
  const parties = new JsonDataFile("parties", env.PARTY_HANDLES_FILE ?? PARTY_HANDLES_FILE, (j, problem) => parsePartyHandles(j, problem), log, EMPTY_PARTY_RULES, onStatus);
  // No reporters file: posts go out without a byline rather than wait. A prior naming a police or collector handle,
  // or one in no directory file, rejects the file; when a directory file cannot be read the directory part of that
  // check waits for the composer (which drops any handle outside the directory) rather than take every byline down
  const reporters = new JsonDataFile("reporters", env.REPORTER_HANDLES_FILE ?? REPORTER_HANDLES_FILE, (j, problem) => {
    const d = directoryInfo({ handles, subjects, parties });
    if (!d.complete) problem("a directory file has no loaded copy, so the prior's handles were checked against police and collectors only");
    // A prior handle that is not an institution is dropped from the prior and reported (R2); the entry still loads
    return parseReporterHandles(j, problem, d.complete ? { directory: d.directory, bound: d.bound, types: d.types } : { bound: d.bound });
    // Parsed again whenever a directory file changes or recovers: its prior is re-checked against the new types (R5)
  }, log, EMPTY_REPORTER_RULES, onStatus, [handles, subjects, parties]);
  return {
    places,
    handles,
    subjects,
    reporters,
    parties,
    // No beats file (or one naming a handle in no directory file): no declared-beat suggestions
    // P6 / D1: a beat handle whose type is not exactly "institution" or "person" (a police or collector account
    // included) is left out alone, with a warning; the rest loads. The composer applies the same allow-list to every
    // beat it offers, warns when it skips one, and offers none while a directory file is broken (P5). R5 / R8: parsed
    // again whenever a directory file changes or recovers, so a handle dropped for its type comes back once the type
    // is fixed, and a beats file refused while the directory was unreadable is read again — no restart needed.
    beats: new JsonDataFile("beats", env.BEAT_HANDLES_FILE ?? BEAT_HANDLES_FILE, (j, problem) => {
      const d = directoryInfo({ handles, subjects, parties, reporters });
      return parseBeatHandles(j, d.directory, { bound: d.bound, stateHandles: d.stateHandles, types: d.types, reporters: reporters.loaded() ?? undefined, problem });
    }, log, EMPTY_BEAT_RULES, onStatus, [handles, subjects, parties, reporters]),
    // No normalise file: typos stay as the desk typed them (still flagged near the brand tags)
    normalise: new JsonDataFile("normalise", env.HASHTAG_NORMALISE_FILE ?? HASHTAG_NORMALISE_FILE, (j, problem) => parseHashtagNormalise(j, problem, placeTags(places, placesPath)), log, EMPTY_NORMALISER, onStatus),
    // No campaigns file: no campaign or keyword tags offered
    campaigns: new JsonDataFile("campaigns", env.CAMPAIGNS_FILE ?? CAMPAIGNS_FILE, (j, problem) => parseSuggestRules(j, problem), log, EMPTY_SUGGEST_RULES, onStatus),
  };
}
