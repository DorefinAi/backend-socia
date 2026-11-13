// Scheduled work: housekeeping every 30 s, reporter features once each IST day, handles nightly.

import {
  expireMediaWaits, getKv, handleDirectoryStaging, istDate, pruneOps, releaseExpiredClaims, reviveExpiredJobs, setKv, snapshotReporterFeatures, type Db,
} from "@socia/db";
import { WIKIDATA_QUERIES, fetchWikidataHandles } from "@socia/providers";
import { sql } from "drizzle-orm";
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
  }
  return false;
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
/** A failed snapshot is tried again after this long, not every 30 s */
export const FEATURES_RETRY_MS = 60 * 60_000;

/**
 * The nightly reporter features (reporter-prior brief §7.1), on the maintenance loop: the first tick of each IST
 * day takes that day's snapshot from the decisions made before the day began (L5). A snapshot already taken is
 * never overwritten (the insert skips it), so a restart or a second worker does no harm. Never throws: a failure
 * is logged and tried again an hour later, and housekeeping runs regardless. NOTHING reads these features yet.
 */
export class NightlyFeatures {
  private lastDay: string | null | undefined = undefined;
  private failedAt = 0;

  constructor(private readonly db: Db, private readonly orgId: string, private readonly log: Logger, private readonly m = 20) {}

  async tick(now = new Date()): Promise<number | null> {
    try {
      const today = istDate(now);
      if (this.lastDay === undefined) this.lastDay = (await getKv<{ day: string }>(this.db, FEATURES_KV))?.day ?? null;
      if (this.lastDay === today) return null;
      if (this.failedAt && now.getTime() - this.failedAt < FEATURES_RETRY_MS) return null;
      const reporters = await snapshotReporterFeatures(this.db, this.orgId, now, this.m);
      await setKv(this.db, FEATURES_KV, { day: today, at: now.toISOString(), reporters });
      this.lastDay = today;
      this.failedAt = 0;
      this.log.info({ day: today, reporters }, "reporter features snapshot taken");
      return reporters;
    } catch (err) {
      this.failedAt = now.getTime();
      this.log.warn({ err }, "reporter features snapshot failed; trying again in an hour");
      return null;
    }
  }
}
