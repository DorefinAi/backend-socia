// X Videos: how the video share is laid out, and what a file's name says. Pure functions, no I/O.
//
// The share (\\10.1.1.20\fin_data\EXPORT FOR YOUTUBE) holds one folder per year, one per month and one per day, then the
// desk's own shift folders, which change from day to day:
//
//   2026\NOVEMBER 2026\24-11-2026\Convert 3 pm to-----------\x...done......<title>  Didwana News .mp4
//
// The month folder's case is not fixed ("August 2026", "SEPTEMBER 2026"). A file the desk picked for X starts with an
// x and dots ("x...", "X..", "x....JO.mp4"); once posted, "done" follows ("x......done......", also typed "dpone").
// Names are not a clip's identity: the desk renames x → x…done, so a file is known by its size and modified time.

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"] as const;

/** File types the share holds video in. Only x-marked ones are read; the rest are listed and left alone. */
export const XV_VIDEO_EXTENSIONS = [".mp4", ".mkv", ".mpg", ".mov", ".m4v"] as const;

/** Picked for X: an x, then at least one dot, space, comma, dash or underscore ("x...", "X..BARA.mp4") */
const X_MARK = /^x[.\s,_-]+/i;
/**
 * Posted, right after the x mark: "done" (also "Done", the typo "dpone"), then marks, Hindi or the end, never more Latin
 * letters ("x..doneकांग्रेस…", "x......done......", but not "x...donkey fair")
 */
const DONE_MARK = /^x[.\s,_-]+d[a-z]{0,2}one(?![a-z])/i;
/** Posted, at the end of the name instead: "X......GEHLOT...done" */
const DONE_TAIL = /[.\s,_-]+d[a-z]{0,2}one[.\s,_-]*$/i;

export interface XvDay {
  /** "NOVEMBER 2026" (as the desk names it; the share's own folder may differ in case) */
  month: string;
  /** "24-11-2026" */
  day: string;
  /** "2026" */
  year: string;
}

/** The share's year, month and day folder names for a date, in IST (the desk's day) */
export function xvDayFolders(at: Date): XvDay {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { year: String(y), month: `${MONTHS[m]} ${y}`, day: `${pad(d)}-${pad(m + 1)}-${y}` };
}

/** Today's and yesterday's day folders (IST), newest first: what the watcher scans */
export function xvScanDays(now: Date): XvDay[] {
  return [xvDayFolders(now), xvDayFolders(new Date(now.getTime() - 24 * 3600_000))];
}

/** The share's folder for `name` among `entries`, matched without case ("August 2026" for "AUGUST 2026"), or null */
export function xvMatchFolder(entries: readonly string[], name: string): string | null {
  const want = name.trim().toUpperCase();
  return entries.find((e) => e.trim().toUpperCase() === want) ?? null;
}

export function xvIsVideo(name: string): boolean {
  const lower = name.toLowerCase();
  return XV_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface XvMarks {
  /** The desk picked it for X */
  picked: boolean;
  /** The desk marked it posted */
  done: boolean;
  /**
   * The name without the marks and the extension, trimmed: often the title the desk wrote ("42 करोड़ के फर्जी GST
   * घोटाले का खुलासा…  Didwana News"), often only a word ("JO", "kota")
   */
  title: string;
}

export function xvMarks(fileName: string): XvMarks {
  const ext = XV_VIDEO_EXTENSIONS.find((e) => fileName.toLowerCase().endsWith(e));
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const picked = X_MARK.exec(base);
  const done = picked ? DONE_MARK.exec(base) : null;
  let rest = done ? base.slice(done[0].length) : picked ? base.slice(picked[0].length) : base;
  const tail = picked && !done ? DONE_TAIL.exec(rest) : null;
  if (tail) rest = rest.slice(0, tail.index);
  return {
    picked: picked !== null,
    done: done !== null || tail !== null,
    title: rest.replace(/^[.\s,_-]+/, "").replace(/\s+/g, " ").trim(),
  };
}

/** A clip's identity on the share: size and modified time survive the desk's renames */
export function xvFingerprint(size: number, mtime: Date): string {
  return `${size}:${mtime.getTime()}`;
}

/** Path parts under the share root, as found ("2026", "NOVEMBER 2026", "24-11-2026", "Convert 3 pm to-----------") */
export type XvFolder = readonly string[];
