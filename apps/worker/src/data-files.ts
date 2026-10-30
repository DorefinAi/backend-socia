// The phase-1 data files (config/rajasthan-places.json, config/district-handles.json): edited without a code
// change and read again when they change (checked at most once a minute). A broken edit keeps the last good
// copy and logs why, so a typo never stops the desk. Whether each file is readable goes to /ingest/status.

import { EMPTY_HANDLE_RULES, PlaceBook, parseHandleRules, parsePlacesData, type HandleRules } from "@socia/core";
import type { DataFileStatus } from "@socia/db";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";

const RECHECK_MS = 60_000;

export const PLACES_FILE = fileURLToPath(new URL("../config/rajasthan-places.json", import.meta.url));
export const DISTRICT_HANDLES_FILE = fileURLToPath(new URL("../config/district-handles.json", import.meta.url));

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
}

export function phaseOneData(log: Logger, onStatus?: OnDataStatus, env = process.env): PhaseOneData {
  return {
    places: new JsonDataFile("places", env.PLACES_FILE ?? PLACES_FILE, (j, problem) => new PlaceBook(parsePlacesData(j, problem)), log, undefined, onStatus),
    // No handles file: posts go out without handles rather than wait
    handles: new JsonDataFile("handles", env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j) => parseHandleRules(j), log, EMPTY_HANDLE_RULES, onStatus),
  };
}
