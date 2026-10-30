// The newsroom's breaking-files share, read only: \\10.1.1.19\controldata\BREAKING_TAZA_NEWS (UNC, read natively
// on the office PC). Today's and yesterday's day folders are listed; only BREAKING .txt files are returned.
// Nothing here writes, renames or deletes.
//
// Only ENOENT means "not there": a day folder not created yet (waiting, not an error) or a file deleted between
// listing and reading. Anything else from the share (EIO, ETIMEDOUT, a call that hangs past 20 s) is
// ShareUnreachable: the ingest loop reports it once per outage. Error messages carry no paths; the logs do.

import { daysToScan, dayFolderName, isBreakingFileName, matchDayFolder, matchMonthFolder, type IstDay } from "@socia/core";
import type { SourceHealth } from "@socia/db";
import type { FileSource, RemoteFile } from "@socia/providers";
import * as fsp from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Logger } from "pino";

/** Parallel stat calls: the share is SMB, one round trip each */
const STAT_CONCURRENCY = 16;
/** A share call slower than this counts as the share being down (an SMB hang can last minutes) */
export const SHARE_TIMEOUT_MS = 20_000;
/** A breaking item is a few KB; anything this big is not one (and is never read whole) */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The share cannot be read right now. `code` is the errno (EIO, ETIMEDOUT, ...), for admins and the logs. */
export class ShareUnreachable extends Error {
  constructor(readonly code: string) {
    super(`The breaking-news share cannot be read (${code}).`);
    this.name = "ShareUnreachable";
  }
}

/** The fs calls the source makes; tests pass slow or failing ones */
export interface ShareFs {
  readdir: (path: string) => Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>;
  stat: (path: string) => Promise<{ size: number; mtime: Date }>;
  readFileBounded: (path: string, max: number) => Promise<Buffer>;
}

const realFs: ShareFs = {
  readdir: (path) => fsp.readdir(path, { withFileTypes: true }),
  stat: (path) => fsp.stat(path),
  async readFileBounded(path, max) {
    const handle = await fsp.open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size > max) throw Object.assign(new Error("too big"), { code: "EFBIG" });
      const buf = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

const codeOf = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
const isMissing = (err: unknown) => codeOf(err) === "ENOENT" || codeOf(err) === "ENOTDIR";

export interface BreakingShareOptions {
  now?: () => Date;
  log?: Logger;
  fs?: ShareFs;
  timeoutMs?: number;
}

export class BreakingShareSource implements FileSource {
  private last: SourceHealth | null = null;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly fs: ShareFs;
  private readonly timeoutMs: number;
  /** Names already logged as skipped (not BREAKING, too big), per IST day, so each is logged once */
  private skipped = { day: "", names: new Set<string>() };

  constructor(root: string, private readonly opts: BreakingShareOptions = {}) {
    this.root = resolve(root);
    this.now = opts.now ?? (() => new Date());
    this.fs = opts.fs ?? realFs;
    this.timeoutMs = opts.timeoutMs ?? SHARE_TIMEOUT_MS;
  }

  /** What the last list() found (also after a failure) */
  health(): SourceHealth | null {
    return this.last;
  }

  /** One share call with a deadline; a hang or a non-ENOENT error is ShareUnreachable, ENOENT is passed on */
  private async call<T>(what: string, run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ShareUnreachable("ETIMEDOUT")), this.timeoutMs);
    });
    try {
      return await Promise.race([run(), deadline]);
    } catch (err) {
      if (err instanceof ShareUnreachable || isMissing(err) || codeOf(err) === "EFBIG") throw err;
      this.opts.log?.warn({ err, what }, "share call failed");
      throw new ShareUnreachable(codeOf(err));
    } finally {
      clearTimeout(timer);
    }
  }

  private async dirs(path: string): Promise<string[]> {
    return (await this.call(`readdir ${path}`, () => this.fs.readdir(path))).filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /** "OCTOBER_2026/30_OCTOBER_2026" for the day, or null while it does not exist */
  private async dayFolder(top: string[], day: IstDay): Promise<string | null> {
    const month = matchMonthFolder(top, day);
    if (!month) return null;
    let inside: string[];
    try {
      inside = await this.dirs(this.abs(month));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    const folder = matchDayFolder(inside, day);
    return folder ? `${month}/${folder}` : null;
  }

  private skipOnce(name: string, why: string): void {
    const day = dayFolderName(daysToScan(this.now()).today);
    if (this.skipped.day !== day) this.skipped = { day, names: new Set() };
    if (this.skipped.names.has(name)) return;
    this.skipped.names.add(name);
    this.opts.log?.debug({ name, why }, "share file skipped");
  }

  private async filesIn(folder: string): Promise<RemoteFile[]> {
    let entries: Awaited<ReturnType<ShareFs["readdir"]>>;
    try {
      entries = await this.call(`readdir ${folder}`, () => this.fs.readdir(this.abs(folder)));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const wanted = entries.filter((e) => {
      if (!e.isFile()) return false;
      if (isBreakingFileName(e.name)) return true;
      if (/\.txt$/i.test(e.name)) this.skipOnce(e.name, "not a breaking file");
      return false;
    });
    const out: RemoteFile[] = [];
    for (let i = 0; i < wanted.length; i += STAT_CONCURRENCY) {
      const batch = await Promise.all(
        wanted.slice(i, i + STAT_CONCURRENCY).map(async (e) => {
          const path = `${folder}/${e.name}`;
          try {
            const s = await this.call(`stat ${path}`, () => this.fs.stat(this.abs(path)));
            if (s.size > MAX_FILE_BYTES) {
              this.skipOnce(e.name, `over ${MAX_FILE_BYTES} bytes`);
              return null;
            }
            return { path, name: e.name, size: s.size, mtime: s.mtime };
          } catch (err) {
            // Deleted between readdir and stat: simply gone
            if (isMissing(err)) return null;
            throw err;
          }
        }),
      );
      for (const f of batch) if (f) out.push(f);
    }
    return out;
  }

  async list(): Promise<RemoteFile[]> {
    const at = this.now();
    const { today, yesterday } = daysToScan(at);
    const health: SourceHealth = {
      kind: "breaking", reachable: false, expectedFolder: dayFolderName(today), todayFolder: null, alsoScanning: null,
      filesToday: 0, lastFileAt: null, lastFileName: null, checkedAt: at.toISOString(), lastError: null,
    };
    try {
      const top = await this.dirs(this.root).catch((err) => {
        // The root itself missing is the share being unreachable, not a day folder not made yet
        throw isMissing(err) ? new ShareUnreachable(codeOf(err)) : err;
      });
      health.reachable = true;
      const files: RemoteFile[] = [];
      health.todayFolder = await this.dayFolder(top, today);
      if (health.todayFolder) {
        const todays = await this.filesIn(health.todayFolder);
        health.filesToday = todays.length;
        files.push(...todays);
      }
      health.alsoScanning = await this.dayFolder(top, yesterday);
      if (health.alsoScanning) files.push(...(await this.filesIn(health.alsoScanning)));

      const newest = files.reduce<RemoteFile | null>((a, f) => (!a || (f.mtime?.getTime() ?? 0) > (a.mtime?.getTime() ?? 0) ? f : a), null);
      health.lastFileAt = newest?.mtime?.toISOString() ?? null;
      health.lastFileName = newest?.name ?? null;
      this.last = health;
      return files;
    } catch (err) {
      const e = err instanceof ShareUnreachable ? err : new ShareUnreachable(codeOf(err));
      this.last = { ...health, reachable: false, lastError: { at: health.checkedAt, message: e.message, code: e.code } };
      this.opts.log?.debug({ err, root: this.root }, "share listing failed");
      throw e;
    }
  }

  /** An absolute path inside the root; anything that climbs out (a\..\b, C:x, \\other\share) is refused */
  private abs(path: string): string {
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep)) throw new Error("Not a path inside the share");
    return full;
  }

  async read(path: string): Promise<Buffer> {
    const full = this.abs(path);
    try {
      return await this.call(`read ${path}`, () => this.fs.readFileBounded(full, MAX_FILE_BYTES));
    } catch (err) {
      if (codeOf(err) === "EFBIG") throw new Error(`File is over ${MAX_FILE_BYTES} bytes; not read`);
      throw err;
    }
  }

  async close(): Promise<void> {}
}
