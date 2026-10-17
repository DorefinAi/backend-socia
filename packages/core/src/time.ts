// Clock rules shared by the API and the workers.

export const UNDO_SECONDS = 10;
export const LEASE_SECONDS = 5 * 60;
export const MAX_PUBLISH_ATTEMPTS = 5;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Daily caps reset at midnight in India, whatever the server's time zone. */
export function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const midnightIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return new Date(midnightIst - IST_OFFSET_MS);
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
