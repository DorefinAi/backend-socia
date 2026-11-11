// Clock rules shared by the API and the workers.

export const UNDO_SECONDS = 10;
/** "Copy & Posted" can be taken back this long after (the post on X itself is deleted by hand) */
export const COPY_UNDO_SECONDS = 5 * 60;
export const LEASE_SECONDS = 5 * 60;
export const MAX_PUBLISH_ATTEMPTS = 5;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Daily caps reset at midnight in India, whatever the server's time zone. */
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(midnightIst - IST_OFFSET_MS);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An India calendar day "YYYY-MM-DD" as [start, end): 00:00 IST to the next 00:00 IST (IST has no DST).
 * Null when the text is not that shape or not a real date (2026-02-30).
 */
export function istDayRange(day: string): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(0);
  utc.setUTCFullYear(y, mo - 1, d); // not Date.UTC, which maps years 0-99 to 1900+
  // 02-30 rolls over to 03-02; a real date reads back the same
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  const start = new Date(utc.getTime() - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Seconds before the next attempt: 15, 30, 60, 120, … capped at 10 minutes. */
export function backoffSeconds(attempt: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempt - 1), 600);
}

export type CapLevel = "ok" | "warn" | "danger" | "full";

/** The cap meter's colour: warn from 80%, danger from 95%, full at 100%. */
export function capLevel(used: number, cap: number): CapLevel {
  if (used >= cap) return "full";
  if (used >= cap * 0.95) return "danger";
  if (used >= cap * 0.8) return "warn";
  return "ok";
}
