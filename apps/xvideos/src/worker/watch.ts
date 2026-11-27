// The watch role. It walks:
//   - today's day folder (IST) every `todayMs` (XVIDEOS_SCAN_SECONDS, 30 s),
//   - every day folder of the month every `monthMs` (XVIDEOS_MONTH_SCAN_SECONDS, 10 min); also last month's while any
//     of its clips is still on the desk, so a clip cleared after the month ended goes too,
//   - a day the desk asked for with Refresh, at once and once more `followUpMs` later.
// Every video at any depth is taken, x-marked or not. A file is recorded once two walks of its day in a row see the
// same size and modified time (the copy onto the share has finished); until then it is only remembered. A day folder
// walked completely takes off the desk the clips that left it (`gone`); a month listed in full takes off the clips of
// its deleted day folders; a deleted month folder takes off all of its clips. A file not on the share is gone for good.

import type { Db } from "@socia/db";
import type { Logger } from "pino";
import { xvLiveMonths, xvMarkGone, xvMarkGoneDays, xvRecordScan, xvTakeScanRequests, type XvSeenFile } from "../db/clips";
import { xvFingerprint, xvHeading, xvMarks, xvMonthOf, xvScanMonths, xvToday, type XvMonth } from "../share/rules";
import { XvShareUnreachable, type XvShareReader } from "./share";

/** After the share fails, the error is logged again at most this often while it stays down */
const OUTAGE_LOG_MS = 60 * 60_000;

export interface XvWatchTiming {
  todayMs: number;
  monthMs: number;
  /** A Refresh walks the day again this long after, so the files it found settle */
  followUpMs: number;
  /** A file is settled (its copy onto the share finished) once its size and time stayed the same this long */
  settleMs: number;
}

export const XV_WATCH_TIMING: XvWatchTiming = { todayMs: 30_000, monthMs: 10 * 60_000, followUpMs: 10_000, settleMs: 10_000 };

/** What a walk saw of one file: its fingerprint, and since when it has had it */
interface Seen {
  fp: string;
  since: number;
}

/** A month folder to list: its names, and its parts as the clips in the database have them (to mark them gone) */
type MonthToList = XvMonth & { stored: [string, string] | null };

export class XvWatcher {
  /** day folder path → (file path → what that day's last walk saw): a file is settled when a later walk, settleMs on, sees the same */
  private last = new Map<string, Map<string, Seen>>();
  /** Day folder paths walked during the current tick (a whole-month walk forgets the others) */
  private readonly seenKeys = new Set<string>();
  private todayAt = 0;
  private monthAt = 0;
  /** Whole-month walks done: the first two ticks both walk everything, so the month settles at start-up */
  private monthScans = 0;
  /** day → when to walk it again after a Refresh */
  private followUps = new Map<string, number>();
  private outageSince: number | null = null;
  private outageLoggedAt = 0;

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly share: XvShareReader,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly timing: XvWatchTiming = XV_WATCH_TIMING,
  ) {}

  /** One pass: walks whatever is due. Returns false (wait the loop's short idle) every time. */
  async tick(): Promise<boolean> {
    const now = this.now();
    const at = now.getTime();
    const today = xvToday(now);
    const requested = await xvTakeScanRequests(this.db, this.orgId);
    // At start-up the month is walked twice, settleMs apart, so every file already there settles
    const wholeMonth = (this.monthScans < 2 && at - this.monthAt >= this.timing.settleMs) || at - this.monthAt >= this.timing.monthMs;
    const due = new Set(requested);
    if (at - this.todayAt >= this.timing.todayMs) due.add(today);
    const followUpsDue = [...this.followUps].filter(([, when]) => when <= at).map(([day]) => day);
    for (const day of followUpsDue) due.add(day);
    if (!wholeMonth && !due.size) return false;

    try {
      for (const month of await this.monthsToList(now, wholeMonth, due)) {
        const listing = await this.share.listMonth(month);
        if (!listing.monthFolder) {
          // The month folder is gone from the share: so is every clip still listed under it
          if (month.stored) await this.markGoneDays(month.stored, []);
          continue;
        }
        for (const d of listing.days) {
          if (!wholeMonth && !due.has(d.day)) continue;
          await this.walkDay(d.folder, d.day, at);
        }
        await this.markGoneDays(listing.monthFolder, listing.days.map((d) => d.name));
      }
      if (wholeMonth) {
        this.monthAt = at;
        this.monthScans++;
        // Day folders that left the share are forgotten
        for (const key of this.last.keys()) if (!this.seenKeys.has(key)) this.last.delete(key);
      }
      if (due.has(today) || wholeMonth) this.todayAt = at;
      // A follow-up is tried once, whether or not its day folder was there (a Refresh on a day with no folder yet, or a
      // date the share never had, must not be asked for again on every pass); a new Refresh gets its one follow-up
      for (const day of followUpsDue) this.followUps.delete(day);
      for (const day of requested) this.followUps.set(day, at + this.timing.followUpMs);
      if (this.outageSince !== null) {
        this.log.info({ downForS: Math.round((Date.now() - this.outageSince) / 1000) }, "video share is back");
        this.outageSince = null;
      }
    } catch (err) {
      // The Refreshes of this pass were taken from the database: retry them (and the follow-ups that were due) at the
      // pace of today's walk, whatever went wrong
      for (const day of [...requested, ...followUpsDue]) this.followUps.set(day, at + this.timing.todayMs);
      if (!(err instanceof XvShareUnreachable)) throw err;
      const errAt = Date.now();
      if (this.outageSince === null) this.outageSince = errAt;
      if (errAt - this.outageLoggedAt >= OUTAGE_LOG_MS) {
        this.outageLoggedAt = errAt;
        this.log.error({ code: err.code }, "video share unreachable; clips already found stay on the desk");
      }
      // Keep what the last good walks saw, so a file is not counted as new again after the outage
    } finally {
      this.seenKeys.clear();
    }
    return false;
  }

  /** This month (and last month in a new month's first days); on a whole-month walk also every month the desk still has clips in */
  private async monthsToList(now: Date, wholeMonth: boolean, due: Set<string>): Promise<MonthToList[]> {
    const out: MonthToList[] = xvScanMonths(now).map((m) => ({ ...m, stored: null }));
    const add = (m: XvMonth, stored: [string, string] | null) => {
      const had = out.find((o) => o.year === m.year && o.month.toUpperCase() === m.month.toUpperCase());
      if (!had) out.push({ ...m, stored });
      else if (stored && !had.stored) had.stored = stored;
    };
    for (const day of due) add(xvMonthOf(day), null);
    if (wholeMonth) for (const [year, month] of await xvLiveMonths(this.db, this.orgId)) add({ year, month }, [year, month]);
    return out;
  }

  private async markGoneDays(monthFolder: readonly string[], dayNames: string[]): Promise<void> {
    const gone = await xvMarkGoneDays(this.db, this.orgId, monthFolder, dayNames);
    if (gone) this.log.info({ month: monthFolder[1], gone }, "x videos: day folders left the share");
  }

  private async walkDay(dayFolder: [string, string, string], day: string, at: number): Promise<void> {
    const key = dayFolder.join("/");
    this.seenKeys.add(key);
    const listing = await this.share.listDay(dayFolder);
    const before = this.last.get(key) ?? new Map<string, Seen>();
    const current = new Map<string, Seen>();
    const settled: XvSeenFile[] = [];
    for (const f of listing.files) {
      const path = this.share.pathOf(f.folder, f.fileName);
      const fp = xvFingerprint(f.size, f.mtime);
      const had = before.get(path);
      const seen = had?.fp === fp ? had : { fp, since: at };
      current.set(path, seen);
      if (at - seen.since < this.timing.settleMs) continue;
      settled.push({ folder: f.folder, fileName: f.fileName, size: f.size, mtime: f.mtime, fingerprint: fp, day, heading: xvHeading(f.fileName), ...xvMarks(f.fileName) });
    }
    // A listing cut short keeps the files it missed in mind, so they still settle on the next full listing
    this.last.set(key, listing.complete ? current : new Map([...before, ...current]));
    const { inserted, queued } = await xvRecordScan(this.db, this.orgId, settled);
    // Only on a complete listing, and only for files the share still shows (settled or not)
    const gone = listing.complete ? await xvMarkGone(this.db, this.orgId, dayFolder, listing.files.map((f) => xvFingerprint(f.size, f.mtime))) : 0;
    if (inserted || queued || gone) this.log.info({ day, inserted, queued, gone, files: listing.files.length }, "x videos scan");
    if (!listing.complete) this.log.warn({ day }, "x videos scan incomplete: some folders or files could not be read or were renamed; nothing marked gone");
  }
}
