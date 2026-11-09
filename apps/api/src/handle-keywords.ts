// What a handle the desk adds is checked against (core desk-handles.ts): the names it may get as keywords
// (Rajasthan's districts, always, and the verified, non-party English names of the worker's subject-handles.json)
// and every handle of the worker's two data files, verified or not, which never get keywords nor do their
// lookalikes. Same files and same SUBJECT_HANDLES_FILE / DISTRICT_HANDLES_FILE overrides as the worker. Each file is
// read again when it changes, checked at most once a minute; one that cannot be read keeps its last good copy.
// Until a file has been read once there is no list of its handles to compare with, so (failing safe) no handle
// gets keywords then.

import { deskHandleKeywords, districtKeywordCandidates, parseHandleRules, parseSubjectHandles, subjectKeywordCandidates, type KeywordCandidate, type KeywordsWithheld } from "@socia/core";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";

const RECHECK_MS = 60_000;
/** apps/api/src (dev, tests) and apps/api/dist (built) are both two levels under apps/ */
export const SUBJECT_HANDLES_FILE = fileURLToPath(new URL("../../worker/config/subject-handles.json", import.meta.url));
export const DISTRICT_HANDLES_FILE = fileURLToPath(new URL("../../worker/config/district-handles.json", import.meta.url));

class WatchedJson<T> {
  private value: T | null = null;
  private checkedAt = 0;
  private mtimeMs: number | null = null;

  constructor(private readonly path: string, private readonly parse: (json: unknown) => T, private readonly log: FastifyBaseLogger) {}

  async get(): Promise<T | null> {
    const now = Date.now();
    if (now - this.checkedAt < RECHECK_MS) return this.value;
    this.checkedAt = now;
    try {
      const { mtimeMs } = await stat(this.path);
      if (mtimeMs !== this.mtimeMs || this.value === null) {
        this.value = this.parse(JSON.parse(await readFile(this.path, "utf8")));
        this.mtimeMs = mtimeMs;
      }
    } catch (err) {
      this.log.warn({ err, path: this.path }, "handles data file unreadable; keeping the last good copy");
    }
    return this.value;
  }
}

export class DeskHandleChecks {
  private readonly districts = districtKeywordCandidates();
  private readonly subjects: WatchedJson<{ candidates: KeywordCandidate[]; handles: ReadonlySet<string> }>;
  private readonly officials: WatchedJson<ReadonlySet<string>>;

  constructor(log: FastifyBaseLogger, env = process.env) {
    this.subjects = new WatchedJson(
      env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE,
      (j) => ({ candidates: subjectKeywordCandidates(j), handles: parseSubjectHandles(j).handles ?? new Set<string>() }),
      log,
    );
    this.officials = new WatchedJson(env.DISTRICT_HANDLES_FILE ?? DISTRICT_HANDLES_FILE, (j) => parseHandleRules(j).all ?? new Set<string>(), log);
  }

  /** The keywords for a new desk handle; none (withheld "files_unavailable") until both files have been read */
  async keywords(handle: string): Promise<{ keywords: string[]; withheld: KeywordsWithheld | "files_unavailable" | null }> {
    const [subjects, officials] = await Promise.all([this.subjects.get(), this.officials.get()]);
    if (!subjects || !officials) return { keywords: [], withheld: "files_unavailable" };
    return deskHandleKeywords(handle, { candidates: [...this.districts, ...subjects.candidates], fileHandles: [...officials, ...subjects.handles] });
  }
}
