// X Videos: how the video share is laid out, and what a file's name says. Pure functions, no I/O.
//
// The share (\\10.1.1.20\fin_data\EXPORT FOR YOUTUBE) holds one folder per year, one per month and one per day, then
// whatever folders the desk makes inside a day (shift folders, desk folders, none), which change from day to day:
//
//   2026\NOVEMBER 2026\24-11-2026\Convert 3 pm to-----------\x...done......<title>  Didwana News .mp4
//
// The month folder's case is not fixed ("August 2026", "SEPTEMBER 2026"). A file the desk picked for X starts with an
// x and dots ("x...", "X..", "x....JO.mp4"); once posted, "done" follows ("x......done......", also typed "dpone").
// Names are not a clip's identity: the desk renames x → x…done, so a file is known by its size and modified time.

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"] as const;

/** File types the share holds video in. Every one is listed on the desk; the x mark is shown, not used as a filter. */
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

/** The share clears files after 3-4 days: month folders are scanned while one of their days is this recent */
export const XV_KEEP_DAYS = 5;

export type XvMonth = Pick<XvDay, "year" | "month">;

/**
 * The month folders the watcher scans: this month (IST), plus last month during the first days of a new one, while its
 * last day folders may still hold files. Newest first.
 */
export function xvScanMonths(now: Date): XvMonth[] {
  const out: XvMonth[] = [];
  for (const at of [now, new Date(now.getTime() - XV_KEEP_DAYS * 24 * 3600_000)]) {
    const { year, month } = xvDayFolders(at);
    if (!out.some((m) => m.month === month)) out.push({ year, month });
  }
  return out;
}

/** "2026-11-27": the desk's day (IST) as a date string */
export function xvToday(now: Date): string {
  const day = xvDayDate(xvDayFolders(now).day);
  if (!day) throw new Error(`xvToday: not a date (${String(now)})`);
  return day;
}

/** The month folder a day ("2026-11-27") belongs to */
export function xvMonthOf(day: string): XvMonth {
  const { year, month } = xvDayFolders(new Date(`${day}T06:30:00Z`));
  return { year, month };
}

/** A day folder's name ("27-11-2026", also "7-11-2026" or "27.11.2026") as "2026-11-27", or null when it is not a date */
export function xvDayDate(folderName: string): string | null {
  const m = /^(\d{1,2})[-.](\d{1,2})[-.](\d{4})$/.exec(folderName.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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

/** The name without marks and extension, its spaces as typed (two or more spaces carry meaning: see xvHeading) */
function unmarked(fileName: string): { picked: boolean; done: boolean; rest: string } {
  const ext = XV_VIDEO_EXTENSIONS.find((e) => fileName.toLowerCase().endsWith(e));
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const picked = X_MARK.exec(base);
  const done = picked ? DONE_MARK.exec(base) : null;
  let rest = done ? base.slice(done[0].length) : picked ? base.slice(picked[0].length) : base;
  const tail = picked && !done ? DONE_TAIL.exec(rest) : null;
  if (tail) rest = rest.slice(0, tail.index);
  return { picked: picked !== null, done: done !== null || tail !== null, rest: rest.replace(/^[.\s,_-]+/, "").replace(/[.\s,_-]+$/, "") };
}

export function xvMarks(fileName: string): XvMarks {
  const { picked, done, rest } = unmarked(fileName);
  return { picked, done, title: rest.replace(/\s+/g, " ").trim() };
}

/** A name is a heading with at least this many words ... */
export const XV_HEADING_MIN_WORDS = 5;
/** ... and at least this many Devanagari letters (vowel signs not counted): "KOTAA", "JDR Hadsa", "cs v srinivas" are not */
export const XV_HEADING_MIN_HINDI = 8;
const HINDI_LETTER = /(?=\p{Script=Devanagari})\p{L}/gu;
/** Stands in for a typed " | " while the name is split (a file name cannot hold it) */
const SEPARATOR = "\u0000";

/**
 * The posted title the desk wrote as the file's name, or null when the name is only a word or two (then the screen read
 * finds the headline). Windows does not allow "|" in a name, so the desk types two or more spaces for " | ":
 * "SI भर्ती … गिरफ्तार  Special Operations Group   Jaipur News" → "SI भर्ती … गिरफ्तार | Special Operations Group | Jaipur News".
 * Measured 27 Nov 2026: all 29 videos posted on X that day had their title as a file name on the share.
 */
export function xvHeading(fileName: string): string | null {
  const parts = unmarked(fileName)
    // Only two or more plain spaces typed by the desk stand for " | ". A name pasted from the web or a chat app can hold
    // no-break or zero-width spaces: a run with one of them in it is a single space.
    .rest.replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, (run) => (/^ {2,}$/.test(run) ? SEPARATOR : " "))
    .split(SEPARATOR)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const heading = parts.join(" | ");
  const words = heading.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const hindi = heading.match(HINDI_LETTER)?.length ?? 0;
  return words >= XV_HEADING_MIN_WORDS && hindi >= XV_HEADING_MIN_HINDI ? heading : null;
}

/**
 * A clip's identity inside its day folder: size and modified time survive the desk's renames. The same video copied
 * into two day folders is one clip per day: each day shows what its folder holds.
 */
export function xvFingerprint(size: number, mtime: Date): string {
  return `${size}:${mtime.getTime()}`;
}

/** Path parts under the share root, as found ("2026", "NOVEMBER 2026", "24-11-2026", "Convert 3 pm to-----------") */
export type XvFolder = readonly string[];
