// Stage claims for the ingest → convert → compose → render pipeline. A stage never calls the next
// one: it updates the row, and the next stage's worker claims it (backend doc §3).

import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db, Tx } from "./client";
import { assets, postDrafts, stories } from "./schema";

/** How far apart a story's text and media may land and still pair: the same day plus overlap. */
export const PAIR_WINDOW_HOURS = 30;
/** After this, a story stops waiting for media and goes out as a card (spec §6.1.1). */
export const MEDIA_WAIT_HOURS = 6;

/**
 * Take one story in `status`, run `work` on it inside the transaction, and let `work` move it on.
 * The row stays locked (SKIP LOCKED for other workers) until the transaction ends; if the worker
 * dies, the transaction rolls back and the story is free again.
 */
export async function withNextStory(db: Db, status: "ingested" | "converted", work: (tx: Tx, story: typeof stories.$inferSelect) => Promise<void>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [story] = await tx
      .select()
      .from(stories)
      .where(eq(stories.status, status))
      .orderBy(asc(stories.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!story) return false;
    await work(tx, story);
    return true;
  });
}

export type RenderClaim = Pick<typeof postDrafts.$inferSelect, "id" | "orgId" | "status" | "cardRev" | "cardHeadline" | "storyId">;

/** Claim one draft whose card is behind its text, for leaseSeconds. Rendering happens outside any transaction. */
export async function claimRender(db: Db, leaseSeconds = 60): Promise<RenderClaim | null> {
  const due = db
    .select({ id: postDrafts.id })
    .from(postDrafts)
    .where(
      and(
        lt(postDrafts.cardRenderedRev, postDrafts.cardRev),
        inArray(postDrafts.status, ["rendering", "ready", "claimed"]),
        or(isNull(postDrafts.renderLeaseUntil), lt(postDrafts.renderLeaseUntil, sql`now()`)),
      ),
    )
    .orderBy(asc(postDrafts.updatedAt))
    .limit(1)
    .for("update", { skipLocked: true });

  const [row] = await db
    .update(postDrafts)
    .set({ renderLeaseUntil: sql`now() + make_interval(secs => ${leaseSeconds})` })
    .where(inArray(postDrafts.id, due))
    .returning({ id: postDrafts.id, orgId: postDrafts.orgId, status: postDrafts.status, cardRev: postDrafts.cardRev, cardHeadline: postDrafts.cardHeadline, storyId: postDrafts.storyId });
  return row ?? null;
}

/** Media that arrived before its text, waiting for a story with the same slug. */
export async function attachWaitingAssets(tx: Tx, story: { id: string; orgId: string; slug: string }): Promise<number> {
  const rows = await tx
    .update(assets)
    .set({ storyId: story.id, attachedBy: "auto" })
    .where(
      and(
        eq(assets.orgId, story.orgId),
        eq(assets.slug, story.slug),
        isNull(assets.storyId),
        gte(assets.createdAt, sql`now() - make_interval(hours => ${PAIR_WINDOW_HOURS})`),
      ),
    )
    .returning({ id: assets.id });
  if (rows.length) await tx.update(stories).set({ mediaState: "attached" }).where(eq(stories.id, story.id));
  return rows.length;
}

/** The newest story with this slug inside the window, for media that arrives after its text. */
export async function storyForSlug(tx: Tx, orgId: string, slug: string) {
  const [story] = await tx
    .select({ id: stories.id })
    .from(stories)
    .where(and(eq(stories.orgId, orgId), eq(stories.slug, slug), gte(stories.createdAt, sql`now() - make_interval(hours => ${PAIR_WINDOW_HOURS})`)))
    .orderBy(sql`${stories.createdAt} DESC`)
    .limit(1);
  return story ?? null;
}

/** Stories that waited MEDIA_WAIT_HOURS with no media stop waiting. Late media still attaches. */
export async function expireMediaWaits(db: Db): Promise<number> {
  const rows = await db
    .update(stories)
    .set({ mediaState: "none" })
    .where(and(eq(stories.mediaState, "awaiting"), lt(stories.createdAt, sql`now() - make_interval(hours => ${MEDIA_WAIT_HOURS})`)))
    .returning({ id: stories.id });
  return rows.length;
}
