// The watch role: every XVIDEOS_SCAN_SECONDS, today's and yesterday's day folders (IST). A file is recorded once two
// scans in a row see the same size and modified time (the copy onto the share has finished); until then it is only
// remembered. A day folder listed completely also takes off the desk the clips that left it (`gone`).

import type { Db } from "@socia/db";
import { xvMarkGone, xvRecordScan, type XvSeenFile } from "../db/clips";
import { xvFingerprint, xvMarks, xvScanDays } from "../share/rules";
import type { Logger } from "pino";
import { XvShareUnreachable, type XvShareReader } from "./share";

/** After the share fails, the error is logged again at most this often while it stays down */
const OUTAGE_LOG_MS = 60 * 60_000;

export class XvWatcher {
  /** path → fingerprint at the last scan: a file is settled when this scan sees the same one */
  private last = new Map<string, string>();
  private outageSince: number | null = null;
  private outageLoggedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly share: XvShareReader,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** One scan. Returns false (wait the scan interval) every time: the next scan is what settles a file. */
  async tick(): Promise<boolean> {
    const current = new Map<string, string>();
    try {
      for (const day of xvScanDays(this.now())) {
        const listing = await this.share.listDay(day);
        if (!listing.dayFolder) continue;
        const settled: XvSeenFile[] = [];
        for (const f of listing.files) {
          const key = this.share.pathOf(f.folder, f.fileName);
          const fp = xvFingerprint(f.size, f.mtime);
          current.set(key, fp);
          if (this.last.get(key) !== fp) continue;
          settled.push({ folder: f.folder, fileName: f.fileName, size: f.size, mtime: f.mtime, fingerprint: fp, ...xvMarks(f.fileName) });
        }
        const { inserted, queued } = await xvRecordScan(this.db, this.orgId, settled);
        // Only on a complete listing, and only for files the share still shows (settled or not)
        const gone = listing.complete ? await xvMarkGone(this.db, this.orgId, listing.dayFolder, listing.files.map((f) => xvFingerprint(f.size, f.mtime))) : 0;
        if (inserted || queued || gone) this.log.info({ day: day.day, inserted, queued, gone, files: listing.files.length }, "x videos scan");
        if (!listing.complete) this.log.warn({ day: day.day }, "x videos scan incomplete: some folders or files could not be read; nothing marked gone");
      }
      if (this.outageSince !== null) {
        this.log.info({ downForS: Math.round((Date.now() - this.outageSince) / 1000) }, "video share is back");
        this.outageSince = null;
      }
      this.last = current;
    } catch (err) {
      if (!(err instanceof XvShareUnreachable)) throw err;
      const at = Date.now();
      if (this.outageSince === null) this.outageSince = at;
      if (at - this.outageLoggedAt >= OUTAGE_LOG_MS) {
        this.outageLoggedAt = at;
        this.log.error({ code: err.code }, "video share unreachable; clips already found stay on the desk");
      }
      // Keep what the last good scan saw, so a file is not counted as new again after the outage
    }
    return false;
  }
}
