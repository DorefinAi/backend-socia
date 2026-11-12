// The phase-1 data files (config/rajasthan-places.json, config/district-handles.json, config/subject-handles.json):
// edited without a code
// change and read again when they change (checked at most once a minute). A broken edit keeps the last good
// copy and logs why, so a typo never stops the desk. Whether each file is readable goes to /ingest/status.

import {
  EMPTY_HANDLE_RULES, EMPTY_NORMALISER, EMPTY_PARTY_RULES, EMPTY_REPORTER_RULES, EMPTY_SUBJECT_RULES, EMPTY_SUGGEST_RULES, PlaceBook,
  parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules,
  type HandleRules, type PartyRules, type ReporterRules, type SubjectRules, type SuggestRules, type TagNormaliser,
} from "@socia/core";
import type { DataFileStatus } from "@socia/db";
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

/** A data file the pipeline needs is not readable: retry later, do not fail the story */
export class DataUnavailable extends Error {
  constructor(readonly file: DataFileStatus["file"], cause: unknown) {
    super(`The ${file} data file cannot be read: ${(cause as Error)?.message ?? cause}`);
    this.name = "DataUnavailable";
  }
}

export type OnDataStatus = (status: DataFileStatus) => void | Promise<void>;

export class JsonDataFile<T> {
  private cached: { value: T; version: string } | null = null;
  private checkedAt = 0;
  private mtimeMs: number | null = null;
  private lastOk: boolean | null = null;

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

  private async report(ok: boolean, message?: string, skipped?: number): Promise<void> {
    if (this.lastOk === ok && ok) return;
    this.lastOk = ok;
    await Promise.resolve(this.onStatus?.({ file: this.name, ok, at: new Date().toISOString(), ...(message && { message }), ...(skipped && { skipped }) })).catch((err) =>
      this.log.error({ err }, "could not record the data file status"),
    );
  }

  async get(): Promise<{ value: T; version: string }> {
    const now = Date.now();
    if (now - this.checkedAt < RECHECK_MS && this.cached) return this.cached;
    this.checkedAt = now;
    try {
      const { mtimeMs } = await stat(this.path);
      if (mtimeMs !== this.mtimeMs || !this.cached) {
        const problems: string[] = [];
        const value = this.parse(JSON.parse(await readFile(this.path, "utf8")), (m) => problems.push(m));
        this.cached = { value, version: String(Math.round(mtimeMs)) };
        this.mtimeMs = mtimeMs;
        if (problems.length) this.log.warn({ file: this.name, problems }, "data file entries skipped");
        this.log.info({ file: this.name, path: this.path }, "data file loaded");
        await this.report(true, undefined, problems.length);
      }
    } catch (err) {
      this.log.error({ err, file: this.name, path: this.path }, "data file could not be read; keeping the last good copy");
      await this.report(false, `The ${this.name} file could not be read; ${this.cached ? "using the last good copy" : this.fallback !== undefined ? "using none" : "breaking stories wait for it"}.`);
      if (!this.cached && this.fallback !== undefined) this.cached = { value: this.fallback, version: "0" };
      if (!this.cached) {
        // Try again on the next story rather than after a minute: the desk is waiting
        this.checkedAt = 0;
        throw new DataUnavailable(this.name, err);
      }
    }
    return this.cached;
  }
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
}

export function phaseOneData(log: Logger, onStatus?: OnDataStatus, env = process.env): PhaseOneData {
  return {
    places: new JsonDataFile("places", env.PLACES_FILE ?? PLACES_FILE, (j, problem) => new PlaceBook(parsePlacesData(j, problem)), log, undefined, onStatus),
    // No handles file: posts go out without handles rather than wait
    handles: new JsonDataFile("handles", env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j) => parseHandleRules(j), log, EMPTY_HANDLE_RULES, onStatus),
    // No subjects file (or a broken one at start): no subject handles
    subjects: new JsonDataFile("subjects", env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE, (j, problem) => parseSubjectHandles(j, problem), log, EMPTY_SUBJECT_RULES, onStatus),
    // No reporters file: posts go out without a byline rather than wait
    reporters: new JsonDataFile("reporters", env.REPORTER_HANDLES_FILE ?? REPORTER_HANDLES_FILE, (j, problem) => parseReporterHandles(j, problem), log, EMPTY_REPORTER_RULES, onStatus),
    // No party file: political posts go out with the leader and the reporter, no party handle
    parties: new JsonDataFile("parties", env.PARTY_HANDLES_FILE ?? PARTY_HANDLES_FILE, (j, problem) => parsePartyHandles(j, problem), log, EMPTY_PARTY_RULES, onStatus),
    // No normalise file: typos stay as the desk typed them (still flagged near the brand tags)
    normalise: new JsonDataFile("normalise", env.HASHTAG_NORMALISE_FILE ?? HASHTAG_NORMALISE_FILE, (j, problem) => parseHashtagNormalise(j, problem), log, EMPTY_NORMALISER, onStatus),
    // No campaigns file: no campaign or keyword tags offered
    campaigns: new JsonDataFile("campaigns", env.CAMPAIGNS_FILE ?? CAMPAIGNS_FILE, (j, problem) => parseSuggestRules(j, problem), log, EMPTY_SUGGEST_RULES, onStatus),
  };
}
