// Render: eager, before an operator opens the draft. The card is already waiting in the queue,
// which is the point of the product. An edit to the card text bumps card_rev and lands back here.

import { claimRender, notify, postDrafts, type Db } from "@socia/db";
import type { Storage } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { CardRenderer } from "../card/renderer";

/** A failed render is tried again after this long */
const RETRY_SECONDS = 30;
/** Failures in a row before a new draft is parked in render_failed, where the Failed view shows it */
export const MAX_RENDER_ATTEMPTS = 5;

export async function renderNext(db: Db, storage: Storage, renderer: CardRenderer, log: Logger): Promise<boolean> {
  const claim = await claimRender(db);
  if (!claim) return false;

  try {
    const { png, fontPx } = await renderer.render({ headline: claim.cardHeadline });
    const key = `cards/${claim.id}/r${claim.cardRev}.png`;
    await storage.put(key, png, "image/png");

    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(postDrafts)
        .set({
          cardKey: key,
          cardRenderedRev: claim.cardRev,
          cardFontPx: fontPx,
          renderError: null,
          renderAttempts: 0,
          renderLeaseUntil: null,
          status: sql`CASE WHEN ${postDrafts.status} = 'rendering' THEN 'ready' ELSE ${postDrafts.status} END`,
          updatedAt: sql`now()`,
        })
        // Only if nobody edited the card while it rendered; otherwise the newer text renders next
        .where(and(eq(postDrafts.id, claim.id), eq(postDrafts.cardRev, claim.cardRev)))
        .returning({ status: postDrafts.status, version: postDrafts.version });

      if (!row) {
        await tx.update(postDrafts).set({ renderLeaseUntil: null }).where(eq(postDrafts.id, claim.id));
        return;
      }
      if (claim.status === "rendering") {
        await notify(tx, claim.orgId, { type: "story.arrived", storyId: claim.storyId, draftIds: [claim.id] });
      } else {
        await notify(tx, claim.orgId, { type: "draft.updated", draftId: claim.id, status: row.status, version: row.version });
      }
    });
    log.info({ draftId: claim.id, rev: claim.cardRev, fontPx }, "card rendered");
  } catch (err) {
    log.error({ err, draftId: claim.id }, "card render failed");
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(postDrafts)
        .set({
          renderError: String((err as Error).message ?? err).slice(0, 500),
          renderAttempts: sql`${postDrafts.renderAttempts} + 1`,
          renderLeaseUntil: sql`now() + make_interval(secs => ${RETRY_SECONDS})`,
        })
        .where(eq(postDrafts.id, claim.id))
        .returning({ attempts: postDrafts.renderAttempts });
      // A new draft that keeps failing would sit in `rendering` forever, which no queue view shows.
      // Drafts already ready or claimed keep retrying: an operator has them open and sees the error.
      if (claim.status !== "rendering" || (row?.attempts ?? 0) < MAX_RENDER_ATTEMPTS) return;
      const [failed] = await tx
        .update(postDrafts)
        .set({ status: "render_failed", renderLeaseUntil: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(postDrafts.id, claim.id), eq(postDrafts.status, "rendering")))
        .returning({ status: postDrafts.status, version: postDrafts.version });
      if (failed) await notify(tx, claim.orgId, { type: "draft.updated", draftId: claim.id, status: failed.status, version: failed.version });
      log.warn({ draftId: claim.id, attempts: row?.attempts }, "card render gave up; draft moved to render_failed");
    });
  }
  return true;
}
