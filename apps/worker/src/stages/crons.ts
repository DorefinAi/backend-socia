// Scheduled work: housekeeping every 30 s, handles nightly.

import { expireMediaWaits, handleDirectoryStaging, releaseExpiredClaims, reviveExpiredJobs, setKv, type Db } from "@socia/db";
import { WIKIDATA_QUERIES, fetchWikidataHandles } from "@socia/providers";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";

export async function housekeeping(db: Db, log: Logger): Promise<boolean> {
  const released = await releaseExpiredClaims(db);
  const revived = await reviveExpiredJobs(db);
  const expired = await expireMediaWaits(db);
  if (released || revived || expired) log.info({ released, revived, expired }, "housekeeping");
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
