// Scheduled work: housekeeping every 30 s, the story search sweep every 10 s, reporter features once each IST day,
// handles nightly.

import {
  SEARCH_SWEEP_BATCH, SEARCH_SWEEP_RECENT_MINUTES, expireMediaWaits, getKv, handleDirectoryStaging, istDate, pruneLoginEvents, pruneOps, releaseExpiredClaims, reviveExpiredJobs, setKv, snapshotReporterFeatures, syncStorySearch, type Db,
} from "@socia/db";
import { WIKIDATA_QUERIES, fetchWikidataHandles } from "@socia/providers";
import { sql } from "drizzle-orm";
import type { DbHandle } from "@socia/db";
type Pool = DbHandle["pool"];
import type { Logger } from "pino";

export const OPS_PRUNE_EVERY_MS = 60 * 60_000;
let lastOpsPrune = 0;

export async function housekeeping(db: Db, log: Logger, now = Date.now()): Promise<boolean> {
  const released = await releaseExpiredClaims(db);
  const revived = await reviveExpiredJobs(db);
  const expired = await expireMediaWaits(db);
  if (released || revived || expired) log.info({ released, revived, expired }, "housekeeping");
  // Ops-log retention (dev-docs/ops-logs-contract.md §1), once an hour: lines after 14 days, heartbeats after 7.
  // A failure waits for the next hour and never holds up the work above.
  if (now - lastOpsPrune >= OPS_PRUNE_EVERY_MS) {
    lastOpsPrune = now;
    const pruned = await pruneOps(db).catch((err) => (log.warn({ err }, "could not prune the ops log"), null));
    if (pruned && (pruned.lines || pruned.heartbeats)) log.info(pruned, "ops log pruned");
    // Sign-in attempts after 90 days (dev-docs/ops-status-contract.md §5), on the same hourly turn, failing on its own
    const logins = await pruneLoginEvents(db).catch((err) => (log.warn({ err }, "could not prune the sign-in attempts"), 0));
    if (logins) log.info({ loginEvents: logins }, "sign-in attempts pruned");
  }
  return false;
}

/** How often the story search sweep looks for new or edited stories when the last batch was not full */
export const SEARCH_SWEEP_IDLE_MS = 10_000;

/** How often the sweep checks every story (not only the recently edited ones) */
export const SEARCH_SWEEP_FULL_EVERY_MS = 60 * 60_000;

/**
 * The story search sweep (GET /search/stories): builds the story_search rows of stories that have none or were
 * edited since (any stage that writes a story bumps stories.updated_at), SEARCH_SWEEP_BATCH at a time. A tick
 * looks only at stories edited in the last SEARCH_SWEEP_RECENT_MINUTES (stories_updated_idx); on worker start and
 * once an hour it checks every story, batch after batch until none is left (after migration 0025 this is the
 * backfill). tick() is true when the batch was full, so the loop goes again at once.
 */
export class StorySearchSweep {
  private fullDue = true;
  private lastFullAt = 0;

  constructor(private readonly db: Db, private readonly log: Logger) {}

  async tick(now = Date.now()): Promise<boolean> {
    const full = this.fullDue || now - this.lastFullAt >= SEARCH_SWEEP_FULL_EVERY_MS;
    const r = await syncStorySearch(this.db, { sinceMinutes: full ? undefined : SEARCH_SWEEP_RECENT_MINUTES, log: this.log });
    // Another worker is sweeping: try again on the next tick
    if (r.locked) return false;
    if (r.written || r.skipped) this.log.debug({ written: r.written, skipped: r.skipped, full }, "story search rows built");
    const more = r.candidates >= SEARCH_SWEEP_BATCH;
    if (full) {
      // A full pass goes on until it has seen every story
      this.fullDue = more;
      if (!more) this.lastFullAt = now;
    }
    return more;
  }
}

/** Wikidata into staging. Never into the directory: an editor verifies each handle first. */
export async function syncHandles(db: Db, orgId: string, userAgent: string, log: Logger): Promise<number> {
  let total = 0;
  for (const [name, query] of Object.entries(WIKIDATA_QUERIES)) {
    const rows = await fetchWikidataHandles(query, { userAgent });
    for (let i = 0; i < rows.length; i += 500) {
      const values = rows.slice(i, i + 500).map((r) => ({
        orgId, entityName: r.label, entityNameHi: r.labelHi, platform: "x", handle: r.handle, description: r.description, source: "wikidata", sourceId: r.qid,
      }));
      await db
        .insert(handleDirectoryStaging)
        .values(values)
        .onConflictDoUpdate({
          target: [handleDirectoryStaging.orgId, handleDirectoryStaging.source, handleDirectoryStaging.sourceId, handleDirectoryStaging.platform],
          set: { entityName: sql`excluded.entity_name`, entityNameHi: sql`excluded.entity_name_hi`, handle: sql`excluded.handle`, description: sql`excluded.description`, fetchedAt: sql`now()` },
        });
    }
    log.info({ query: name, rows: rows.length }, "wikidata handles staged");
    total += rows.length;
  }
  await setKv(db, "handles.last_sync", { at: new Date().toISOString(), rows: total });
  return total;
}

/** kv key: the IST day of the last reporter_features snapshot */
export const FEATURES_KV = "reporter_features.last";
/** kv key: the last failure, for whoever looks (never cleared by a success: it carries its own time) */
export const FEATURES_ERROR_KV = "reporter_features.last_error";
/** A failed snapshot is tried again after this long, not every minute */
export const FEATURES_RETRY_MS = 60 * 60_000;
/** Failures in a row before they are logged at error rather than warn */
export const FEATURES_ESCALATE_AFTER = 3;

/** Whole days from IST day `a` to IST day `b` ("2026-11-13" → "2026-11-15" = 2) */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The nightly reporter features (reporter-prior brief §7.1), on a loop of its own so it never delays the
 * housekeeping (claims, jobs, media waits). The first tick of each IST day takes that day's snapshot from the
 * decisions made before the day began (L5); the snapshot has its own 60 s statement budget. A snapshot already
 * taken is never overwritten, so a restart or a second worker does no harm.
 *
 * Never throws. A failure is retried an hour later (or at once when the IST day changes: S2), logged at warn, and at
 * error from the third in a row; the last one is kept in kv. Days with no snapshot are logged when one is next taken,
 * with the reason: the last failure if runs failed (S2), else the worker was not running.
 * NOTHING reads these features yet.
 */
export class NightlyFeatures {
  private lastDay: string | null | undefined = undefined;
  private failedAt = 0;
  private failures = 0;
  /** The last failure since the last snapshot taken, and its IST day: the reason a missed day is given (S2) */
  private lastError: { day: string; message: string } | null = null;

  constructor(
    private readonly db: Db, private readonly pool: Pool, private readonly orgId: string, private readonly log: Logger, private readonly m = 20,
    /**
     * The directory's institution handles (R2, P3, D2): the only prior candidates a snapshot lists. In the worker it is
     * nightlyInstitutions: the files re-checked on disk (R3), and a throw while one is broken (R2). A throw or an empty
     * set fails the run (R4). The default, null (no list at all: the snapshot lists none), is for tests only.
     */
    private readonly institutions: () => ReadonlySet<string> | null | Promise<ReadonlySet<string> | null> = () => null,
  ) {}

  /** Loop tick: always false (nothing more to do straight away) */
  async tick(now = new Date()): Promise<boolean> {
    await this.run(now);
    return false;
  }

  /** Takes today's snapshot when it is due; the reporters it holds, or null when nothing ran or it failed */
  async run(now = new Date()): Promise<number | null> {
    const today = istDate(now);
    // S2 (15 Nov 2026): a new IST day clears the wait — a run that failed at 23:50 does not hold the next day's snapshot
    // back until 00:50
    if (this.failedAt && istDate(new Date(this.failedAt)) !== today) this.failedAt = 0;
    // The backoff comes first: a failed kv read waits the hour too, rather than being tried (and escalated) every tick
    if (this.failedAt && now.getTime() - this.failedAt < FEATURES_RETRY_MS) return null;
    try {
      if (this.lastDay === undefined) this.lastDay = (await getKv<{ day: string }>(this.db, FEATURES_KV))?.day ?? null;
    } catch (err) {
      return this.failed(now, err, "could not read when the reporter features last ran");
    }
    if (this.lastDay === today) return null;

    // R4 (15 Nov 2026): the prior candidates first. A build that fails (a directory file missing or broken) or comes
    // back empty is a FAILURE, not an empty snapshot: nothing is written, the day is not marked done, and it is tried
    // again in an hour until it succeeds that day; the previous day's snapshot stays the latest meanwhile
    let institutions: ReadonlySet<string> | null;
    try {
      institutions = await this.institutions();
      if (institutions && institutions.size === 0) throw new Error("the prior candidates came back empty");
    } catch (err) {
      return this.failed(now, err, "reporter features: the prior candidates could not be built, so no snapshot was taken");
    }
    let snap: Awaited<ReturnType<typeof snapshotReporterFeatures>>;
    try {
      snap = await snapshotReporterFeatures(this.pool, this.orgId, now, this.m, { institutions });
    } catch (err) {
      return this.failed(now, err, "reporter features snapshot failed");
    }
    // S2: the real reason for days with no snapshot — the runs failed while the worker was up, or it was not running
    const failedBefore = this.lastError;
    if (this.lastDay && daysBetween(this.lastDay, today) > 1) {
      const missed = { lastDay: this.lastDay, today, missedDays: daysBetween(this.lastDay, today) - 1 };
      if (failedBefore) this.log.warn({ ...missed, failedOn: failedBefore.day, failures: this.failures, tmpl: "reporter features: days with no snapshot — previous run failed: {error}" }, `reporter features: days with no snapshot — previous run failed: ${failedBefore.message}`);
      else this.log.warn(missed, "reporter features: days with no snapshot (the worker was not running)");
    }
    this.lastDay = today;
    this.failedAt = 0;
    this.failures = 0;
    this.lastError = null;
    this.log.info({ ...snap, ...(failedBefore && { afterFailure: failedBefore.message }) }, "reporter features snapshot taken");
    try {
      await setKv(this.db, FEATURES_KV, { day: today, at: now.toISOString(), reporters: snap.reporters, written: snap.written });
    } catch (err) {
      // The snapshot stands; only the marker is missing, so a restart today tries again and inserts nothing
      this.log.warn({ err, day: today }, "reporter features: snapshot taken but its day could not be recorded");
    }
    return snap.reporters;
  }

  private async failed(now: Date, err: unknown, msg: string): Promise<null> {
    this.failedAt = now.getTime();
    this.failures += 1;
    this.lastError = { day: istDate(now), message: err instanceof Error ? err.message : String(err) };
    const level = this.failures >= FEATURES_ESCALATE_AFTER ? "error" : "warn";
    this.log[level]({ err, failures: this.failures }, `${msg}; trying again in an hour`);
    try {
      await setKv(this.db, FEATURES_ERROR_KV, { at: now.toISOString(), failures: this.failures, message: err instanceof Error ? err.message : String(err) });
    } catch (kvErr) {
      this.log.warn({ err: kvErr }, "reporter features: could not record the failure");
    }
    return null;
  }
}
