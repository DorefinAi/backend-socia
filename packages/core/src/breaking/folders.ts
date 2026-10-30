// The share's layout: <MONTH>_<YEAR>\<DD>_<MONTH>_<YEAR>\*.txt, folder names typed by hand
// (JANUARAY_2026, "MARCH 2026", 02SEPTEMBER_2026). Today's folder is found by loose rules, in India time.
// Older years sit in "2025\APRIL_2025\..." and are never opened.

export const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
] as const;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export interface IstDay {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

export function istDay(at: Date): IstDay {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
}

/** The days whose folders to read at `at`: today and yesterday, India time. */
export function daysToScan(at: Date): { today: IstDay; yesterday: IstDay } {
  // Yesterday's folder all day too: files land there late (a 28_OCTOBER file was saved at 06:54 on the 29th).
  // Reading it again costs one listing; the path and sha256 checks keep it from making a second story.
  return { today: istDay(at), yesterday: istDay(new Date(at.getTime() - 24 * 60 * 60 * 1000)) };
}

/** "30_OCTOBER_2026": how the desk names a day folder */
export function dayFolderName(d: IstDay): string {
  return `${String(d.day).padStart(2, "0")}_${MONTH_NAMES[d.month - 1]}_${d.year}`;
}

const prefix = (month: number) => MONTH_NAMES[month - 1]!.slice(0, 3);
const upper = (name: string) => name.normalize("NFC").toUpperCase().trim();

/**
 * The month folder for `d` among the share's top-level names: it starts with the month's first three
 * letters and contains the year (OCTOBER_2026, JANUARAY_2026, "MARCH 2026"). The exact spelling wins a tie.
 */
export function matchMonthFolder(names: string[], d: IstDay): string | null {
  const p = prefix(d.month);
  const year = String(d.year);
  const hits = names.filter((n) => {
    const u = upper(n);
    return u.startsWith(p) && u.includes(year);
  });
  const exact = `${MONTH_NAMES[d.month - 1]}_${year}`;
  return hits.find((n) => upper(n) === exact) ?? hits.sort()[0] ?? null;
}

/**
 * The day folder for `d` inside a month folder: it starts with the day number (with or without a leading
 * zero or underscore) and contains the month's three letters: 30_OCTOBER_2026, 02SEPTEMBER_2026, 2_SEPTEMBER_2026.
 */
export function matchDayFolder(names: string[], d: IstDay): string | null {
  const p = prefix(d.month);
  const day = new RegExp(`^_*0*${d.day}(?!\\d)`);
  const hits = names.filter((n) => {
    const u = upper(n);
    return day.test(u) && u.includes(p);
  });
  const exact = dayFolderName(d);
  return hits.find((n) => upper(n) === exact) ?? hits.sort()[0] ?? null;
}
