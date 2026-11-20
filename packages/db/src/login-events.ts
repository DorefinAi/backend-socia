// Sign-in attempts (dev-docs/ops-status-contract.md §5): one login_event row per attempt, written by the API's
// login handlers right after the attempt. Recording never fails or delays a sign-in beyond one insert: an error is
// logged (no name, no address in the line) and the sign-in goes on. Kept LOGIN_EVENT_KEEP_DAYS, pruned hourly by the
// worker's housekeeping.

import { sql } from "drizzle-orm";
import type { Executor } from "./client";
import { loginEvent, type LoginResult } from "./schema";

export const LOGIN_EVENT_KEEP_DAYS = 90;
/** The desk's sign-in, as Sentry names it */
export const LOGIN_APP_DIGITAL_DESK = "digital-desk";
export const LOGIN_TEXT_MAX = 200;

export interface LoginAttempt {
  app?: string;
  /** As typed; trimmed and clipped here */
  username: string;
  userId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  result: LoginResult;
}

const clip = (s: string | null | undefined) => (typeof s === "string" && s ? s.replace(/\u0000/g, "").slice(0, LOGIN_TEXT_MAX) : null);

/** Records one attempt. Never throws: a failure goes to `log` (warn) and the caller carries on. */
export async function recordLoginEvent(db: Executor, a: LoginAttempt, log?: { warn: (obj: object, msg: string) => void }): Promise<void> {
  try {
    await db.insert(loginEvent).values({
      app: a.app ?? LOGIN_APP_DIGITAL_DESK,
      username: clip(a.username.trim()) ?? "",
      userId: a.userId ?? null,
      ip: clip(a.ip),
      userAgent: clip(a.userAgent),
      result: a.result,
    });
  } catch (err) {
    try {
      log?.warn({ err, result: a.result }, "could not record the sign-in attempt; the sign-in went on");
    } catch {
      // A broken logger must not fail the sign-in either
    }
  }
}

/** Retention (contract §5): attempts older than 90 days */
export async function pruneLoginEvents(db: Executor): Promise<number> {
  const res = await db.execute(sql`DELETE FROM login_event WHERE at < now() - make_interval(days => ${LOGIN_EVENT_KEEP_DAYS})`);
  return res.rowCount ?? 0;
}
