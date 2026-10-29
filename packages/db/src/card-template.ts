// Each user's own card background, one per platform. The desk draws the date, headline and story body
// on it in the browser; the server only keeps the image, its size and where to draw. Writes are audited.
//
// Storage: the new file is written before the transaction (no row lock held during an upload), removed
// again if the transaction fails, and the file it replaces is removed after commit. Only the current
// file stays; the audit log keeps the history of keys and sizes.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Db, Executor } from "./client";
import type { Actor } from "./desk";
import { cardTemplates, type CardLayout } from "./schema";

export type CardTemplate = typeof cardTemplates.$inferSelect;

/** The First India card: date in the yellow tag top-right, headline and body centred in the red box. */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
  date: { x: 0.54, y: 0.185, w: 0.415, h: 0.06, color: "#000000", format: "Date:DD/MM/YYYY" },
  box: { x: 0.075, y: 0.27, w: 0.85, h: 0.58 },
  headline: { color: "#FFE600" },
  body: { color: "#FFFFFF" },
  fontMinPx: 18,
  fontMaxPx: 56,
};

export interface CardBackground {
  contentType: "image/png" | "image/jpeg";
  bytes: number;
  width: number;
  height: number;
}

/** Writes and removes the image files; the route passes its Storage */
export interface CardFiles {
  put(key: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const own = (actor: Actor, platform: string) => and(eq(cardTemplates.userId, actor.id), eq(cardTemplates.platform, platform));

/** One writer per user and platform at a time, even before the row exists (two first uploads at once). */
async function lockOwn(tx: Executor, actor: Actor, platform: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`card_template:${actor.id}:${platform}`}, 0))`);
}

/** Removing a replaced file is housekeeping: a failure leaves an orphan, never a broken template. */
async function removeQuietly(files: Pick<CardFiles, "remove">, key: string): Promise<void> {
  await files.remove(key).catch(() => undefined);
}

export async function getCardTemplate(db: Db, actor: Actor, platform: string): Promise<CardTemplate | null> {
  const [row] = await db.select().from(cardTemplates).where(own(actor, platform));
  return row ?? null;
}

/**
 * Create or replace the background. A replace keeps the layout; a create starts from the default.
 * The file goes under a new key each time, so the old URL never shows the new image.
 */
export async function saveCardBackground(db: Db, actor: Actor, platform: string, image: CardBackground, files: CardFiles): Promise<CardTemplate> {
  const ext = image.contentType === "image/png" ? "png" : "jpg";
  const key = `card-templates/${actor.id}/${platform}-${randomUUID()}.${ext}`;
  await files.put(key);

  let saved: { row: CardTemplate; replaced: string | null };
  try {
    saved = await db.transaction(async (tx) => {
      await lockOwn(tx, actor, platform);
      const [before] = await tx.select().from(cardTemplates).where(own(actor, platform));
      const [row] = before
        ? await tx
            .update(cardTemplates)
            .set({ backgroundKey: key, width: image.width, height: image.height, updatedAt: sql`now()` })
            .where(eq(cardTemplates.id, before.id))
            .returning()
        : await tx
            .insert(cardTemplates)
            .values({ orgId: actor.orgId, userId: actor.id, platform, backgroundKey: key, width: image.width, height: image.height, layout: DEFAULT_CARD_LAYOUT })
            .returning();
      await audit(tx, {
        orgId: actor.orgId, actorId: actor.id, action: before ? "card_template.replaced" : "card_template.created", entityType: "card_template", entityId: row!.id,
        before: before ? { key: before.backgroundKey, width: before.width, height: before.height } : null,
        after: { platform, key, ...image },
      });
      return { row: row!, replaced: before?.backgroundKey ?? null };
    });
  } catch (err) {
    await removeQuietly(files, key);
    throw err;
  }
  if (saved.replaced && saved.replaced !== key) await removeQuietly(files, saved.replaced);
  return saved.row;
}

/** Null when the user has no template on this platform. */
export async function updateCardLayout(db: Db, actor: Actor, platform: string, layout: CardLayout): Promise<CardTemplate | null> {
  return db.transaction(async (tx) => {
    await lockOwn(tx, actor, platform);
    const [before] = await tx.select().from(cardTemplates).where(own(actor, platform));
    if (!before) return null;
    const [row] = await tx.update(cardTemplates).set({ layout, updatedAt: sql`now()` }).where(eq(cardTemplates.id, before.id)).returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "card_template.layout_changed", entityType: "card_template", entityId: before.id, before: before.layout, after: layout });
    return row!;
  });
}

/** Removes the row, then its file. False when there was nothing to remove. */
export async function deleteCardTemplate(db: Db, actor: Actor, platform: string, files: Pick<CardFiles, "remove">): Promise<boolean> {
  const gone = await db.transaction(async (tx) => {
    await lockOwn(tx, actor, platform);
    const [row] = await tx.delete(cardTemplates).where(own(actor, platform)).returning();
    if (!row) return null;
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "card_template.deleted", entityType: "card_template", entityId: row.id,
      before: { platform, key: row.backgroundKey, width: row.width, height: row.height }, after: null,
    });
    return row;
  });
  if (!gone) return false;
  await removeQuietly(files, gone.backgroundKey);
  return true;
}
