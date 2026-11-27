// Reads the video share, never writes it: lists a month's day folders, walks a day folder and every folder under it,
// and stats the video files. Every call has a timeout (an SMB hang can last minutes); a listing cut short says so, so
// the caller never takes clips off the desk on a partial scan.

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { xvDayDate, xvIsVideo, xvMatchFolder, type XvMonth } from "../share/rules";

/** A share call slower than this counts as the share being down */
export const XV_SHARE_TIMEOUT_MS = 20_000;
/**
 * Folders under a day folder are walked this deep. The desk's own folders follow no pattern ("Convert 3 pm to\New
 * folder\…"); the limit only stops a folder loop.
 */
const MAX_DEPTH = 8;
/** Stats at once: low enough that a hung share cannot fill Node's thread pool (UV_THREADPOOL_SIZE=16) */
const STAT_CONCURRENCY = 8;

export interface XvShareFs {
  readdir: (path: string) => Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>;
  stat: (path: string) => Promise<{ size: number; mtime: Date }>;
}

const realFs: XvShareFs = {
  readdir: (path) => fsp.readdir(path, { withFileTypes: true }),
  stat: (path) => fsp.stat(path),
};

export interface XvFoundFile {
  /** Folder parts under the share root: year, month (as on the share), day, the folders inside the day */
  folder: string[];
  fileName: string;
  size: number;
  mtime: Date;
}

export interface XvDayListing {
  files: XvFoundFile[];
  /** Every folder under the day was listed and every file stated: safe to mark the missing ones gone */
  complete: boolean;
}

export interface XvMonthListing {
  /** The month folder's parts as on the share (["2026", "November 2026"]), or null when the share has none yet */
  monthFolder: string[] | null;
  /** Its day folders, newest first: the date ("2026-11-27"), the folder's name and its parts; non-date folders are left out */
  days: { folder: [string, string, string]; name: string; day: string }[];
}

export class XvShareUnreachable extends Error {
  constructor(readonly code: string) {
    super(`The video share cannot be read (${code}).`);
    this.name = "XvShareUnreachable";
  }
}

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
const isMissing = (err: unknown) => ["ENOENT", "ENOTDIR"].includes(codeOf(err));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("share timeout"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class XvShareReader {
  constructor(
    readonly root: string,
    private readonly fs: XvShareFs = realFs,
    private readonly timeoutMs = XV_SHARE_TIMEOUT_MS,
  ) {}

  private async readdir(parts: readonly string[]) {
    return withTimeout(this.fs.readdir(join(this.root, ...parts)), this.timeoutMs);
  }

  /** The share's own name for a child folder of `parts` (month folders differ in case), or null */
  private async child(parts: readonly string[], name: string): Promise<string | null> {
    const entries = await this.readdir(parts);
    return xvMatchFolder(entries.filter((e) => e.isDirectory()).map((e) => e.name), name);
  }

  /** A month's day folders. Throws XvShareUnreachable when the share cannot be read. */
  async listMonth(month: XvMonth): Promise<XvMonthListing> {
    try {
      const year = await this.child([], month.year);
      const name = year && (await this.child([year], month.month));
      if (!year || !name) return { monthFolder: null, days: [] };
      const days = (await this.readdir([year, name]))
        .filter((e) => e.isDirectory())
        .flatMap((e) => {
          const day = xvDayDate(e.name);
          return day ? [{ folder: [year, name, e.name] as [string, string, string], name: e.name, day }] : [];
        })
        .sort((a, b) => b.day.localeCompare(a.day));
      return { monthFolder: [year, name], days };
    } catch (err) {
      throw new XvShareUnreachable(codeOf(err));
    }
  }

  /**
   * The video files of one day folder, at any depth under it. A day folder deleted from the share lists as empty and
   * complete (its clips are gone). Throws XvShareUnreachable when the day folder cannot be read, so a hung share
   * stops the scan at the first folder instead of waiting out every day of the month.
   */
  async listDay(dayFolder: readonly string[]): Promise<XvDayListing> {
    const found: { folder: string[]; name: string }[] = [];
    let complete = true;
    const walk = async (parts: string[], depth: number): Promise<void> => {
      let entries;
      try {
        entries = await this.readdir(parts);
      } catch (err) {
        if (depth === 0) {
          if (isMissing(err)) return;
          throw new XvShareUnreachable(codeOf(err));
        }
        // A folder inside the day that cannot be read, or was renamed mid-scan: nothing may be marked gone this time
        complete = false;
        return;
      }
      for (const e of entries) {
        if (e.isFile() && xvIsVideo(e.name)) found.push({ folder: parts, name: e.name });
        else if (e.isDirectory() && depth < MAX_DEPTH) await walk([...parts, e.name], depth + 1);
      }
    };
    await walk([...dayFolder], 0);

    const files: XvFoundFile[] = [];
    for (let i = 0; i < found.length; i += STAT_CONCURRENCY) {
      const batch = found.slice(i, i + STAT_CONCURRENCY);
      const stats = await Promise.allSettled(batch.map((f) => withTimeout(this.fs.stat(join(this.root, ...f.folder, f.name)), this.timeoutMs)));
      stats.forEach((s, j) => {
        const f = batch[j]!;
        // A file listed but gone by its stat was most likely renamed (x → x…done) between the two calls: incomplete, so
        // the clip is not taken off the desk while the new name settles
        if (s.status === "fulfilled") files.push({ folder: f.folder, fileName: f.name, size: s.value.size, mtime: s.value.mtime });
        else complete = false;
      });
    }
    return { files, complete };
  }

  /** The file's full path on the share */
  pathOf(folder: readonly string[], fileName: string): string {
    return join(this.root, ...folder, fileName);
  }
}
