// Scheduled work: housekeeping every 30 s, metrics every 6 h, handles nightly.

import {
  expireMediaWaits, handleDirectoryStaging, postMetrics, publishedPosts, releaseExpiredClaims, reviveExpiredJobs, setKv, type Db,
} from "@socia/db";
import { WIKIDATA_QUERIES, fetchWikidataHandles, type XClient } from "@socia/providers";
import { and, gte, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";

export async function housekeeping(db: Db, log: Logger): Promise<boolean> {
  const released = await releaseExpiredClaims(db);
  const revived = await reviveExpiredJobs(db);
  const expired = await expireMediaWaits(db);
  if (released || revived || expired) log.info({ released, revived, expired }, "housekeeping");
  return false;
}

/** Engagement for the last 7 days of posts, in batches of 100 (X's per-call limit). */
export async function pullMetrics(db: Db, x: XClient, log: Logger): Promise<number> {
  const posts = await db
    .select({ id: publishedPosts.id, platformPostId: publishedPosts.platformPostId })
    .from(publishedPosts)
    .where(and(gte(publishedPosts.publishedAt, sql`now() - interval '7 days'`), isNull(publishedPosts.recalledAt)));
  let saved = 0;
  for (let i = 0; i < posts.length; i += 100) {
    const batch = posts.slice(i, i + 100);
    const metrics = await x.metrics(batch.map((p) => p.platformPostId));
    const rows = batch
      .filter((p) => metrics[p.platformPostId])
      .map((p) => {
        const m = metrics[p.platformPostId]!;
        return { postId: p.id, impressions: m.impressions, likes: m.likes, comments: m.replies, shares: m.reposts + m.quotes, saves: m.bookmarks };
      });
    if (rows.length) await db.insert(postMetrics).values(rows);
    saved += rows.length;
  }
  log.info({ posts: posts.length, saved }, "metrics pulled");
  return saved;
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
