// Reads the video share, never writes it: lists a day folder and the desk's shift folders under it, and stats the
// video files. Every call has a timeout (an SMB hang can last minutes); a listing cut short says so, so the caller
// never takes clips off the desk on a partial scan.

import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { xvIsVideo, xvMatchFolder, type XvDay } from "../share/rules";

/** A share call slower than this counts as the share being down */
export const XV_SHARE_TIMEOUT_MS = 20_000;
/** Shift folders nest at most this deep under the day folder ("Convert 3 pm to\New folder") */
const MAX_DEPTH = 3;
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
  /** Folder parts under the share root: year, month (as on the share), day, shift folders */
  folder: string[];
  fileName: string;
  size: number;
  mtime: Date;
}

export interface XvDayListing {
  /** The day folder's parts, or null when the share has no folder for that day yet */
  dayFolder: string[] | null;
  files: XvFoundFile[];
  /** Every folder under the day was listed and every file stated: safe to mark the missing ones gone */
  complete: boolean;
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

  /** The video files of one day. Throws XvShareUnreachable when the root cannot be read at all. */
  async listDay(day: XvDay): Promise<XvDayListing> {
    let dayFolder: string[];
    try {
      const year = await this.child([], day.year);
      const month = year && (await this.child([year], day.month));
      const dayName = month && (await this.child([year, month], day.day));
      if (!year || !month || !dayName) return { dayFolder: null, files: [], complete: true };
      dayFolder = [year, month, dayName];
    } catch (err) {
      throw new XvShareUnreachable(codeOf(err));
    }

    const found: { folder: string[]; name: string }[] = [];
    let complete = true;
    const walk = async (parts: string[], depth: number): Promise<void> => {
      let entries;
      try {
        entries = await this.readdir(parts);
      } catch (err) {
        // A shift folder removed mid-scan is simply not there; anything else leaves the listing incomplete
        if (!isMissing(err)) complete = false;
        return;
      }
      for (const e of entries) {
        if (e.isFile() && xvIsVideo(e.name)) found.push({ folder: parts, name: e.name });
        else if (e.isDirectory() && depth < MAX_DEPTH) await walk([...parts, e.name], depth + 1);
      }
    };
    await walk(dayFolder, 0);

    const files: XvFoundFile[] = [];
    for (let i = 0; i < found.length; i += STAT_CONCURRENCY) {
      const batch = found.slice(i, i + STAT_CONCURRENCY);
      const stats = await Promise.allSettled(batch.map((f) => withTimeout(this.fs.stat(join(this.root, ...f.folder, f.name)), this.timeoutMs)));
      stats.forEach((s, j) => {
        const f = batch[j]!;
        if (s.status === "fulfilled") files.push({ folder: f.folder, fileName: f.name, size: s.value.size, mtime: s.value.mtime });
        else if (!isMissing(s.reason)) complete = false;
      });
    }
    return { dayFolder, files, complete };
  }

  /** The file's full path on the share */
  pathOf(folder: readonly string[], fileName: string): string {
    return join(this.root, ...folder, fileName);
  }
}
