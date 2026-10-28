// What an operator can do to a draft. Each function is one transaction: the state change, the
// audit row, and the live event commit together or not at all.

import {
  LEASE_SECONDS, UNDO_SECONDS, assemblePostText, capLevel, checkXPost, istDayStart, nextDraftStatus,
  type DraftAction, type DraftStatus, type RejectReason,
} from "@socia/core";
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Db, Executor } from "./client";
import { notify } from "./events";
import { handleDirectory, orgs, postDrafts, publishJobs, publishedPosts, users } from "./schema";

export interface Actor {
  id: string;
  orgId: string;
  name: string;
  role: "operator" | "editor" | "admin" | "viewer";
}

export type DeskErrorCode =
  | "not_found" | "held_by_other" | "lease_lost" | "stale_version" | "invalid_state"
  | "card_not_ready" | "post_invalid" | "cap_full" | "too_late" | "bad_mention" | "duplicate_post";

const HTTP_STATUS: Record<DeskErrorCode, number> = {
  not_found: 404, held_by_other: 409, lease_lost: 409, stale_version: 409, invalid_state: 409,
  card_not_ready: 409, post_invalid: 422, cap_full: 429, too_late: 409, bad_mention: 422, duplicate_post: 409,
};

export class DeskError extends Error {
  readonly status: number;
  constructor(readonly code: DeskErrorCode, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.status = HTTP_STATUS[code];
  }
}

type Draft = typeof postDrafts.$inferSelect;

async function lockDraft(tx: Executor, actor: Actor, draftId: string): Promise<Draft> {
  const [draft] = await tx
    .select()
    .from(postDrafts)
    .where(and(eq(postDrafts.id, draftId), eq(postDrafts.orgId, actor.orgId)))
    .for("update");
  if (!draft) throw new DeskError("not_found", "This draft does not exist.");
  return draft;
}

function move(draft: Draft, action: DraftAction): DraftStatus {
  const next = nextDraftStatus(draft.status as DraftStatus, action);
  if (!next) throw new DeskError("invalid_state", `A ${draft.status} draft cannot be changed this way.`, { status: draft.status });
  return next;
}

function holdsLease(draft: Draft, actor: Actor, now = new Date()): boolean {
  return draft.claimedBy === actor.id && !!draft.claimExpiresAt && draft.claimExpiresAt > now;
}

function requireLease(draft: Draft, actor: Actor): void {
  if (!holdsLease(draft, actor)) {
    throw new DeskError("lease_lost", "Your hold on this draft has expired. Open it again to keep working.");
  }
}

async function holderName(db: Executor, userId: string | null): Promise<string> {
  if (!userId) return "Someone";
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return u?.name ?? "Someone";
}

const leaseUntil = () => sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

// ─── Claim leases ────────────────────────────────────────────────────────────

/** Take the draft for LEASE_SECONDS. Zero rows means someone else has it; the error says who. */
export async function claimDraft(db: Db, actor: Actor, draftId: string): Promise<Draft> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(postDrafts)
      .set({ claimedBy: actor.id, claimExpiresAt: leaseUntil(), status: "claimed", updatedAt: sql`now()` })
      .where(
        and(
          eq(postDrafts.id, draftId),
          eq(postDrafts.orgId, actor.orgId),
          inArray(postDrafts.status, ["ready", "claimed"]),
          sql`(${postDrafts.claimedBy} IS NULL OR ${postDrafts.claimedBy} = ${actor.id} OR ${postDrafts.claimExpiresAt} < now())`,
        ),
      )
      .returning();

    if (!claimed) {
      const [draft] = await tx.select().from(postDrafts).where(and(eq(postDrafts.id, draftId), eq(postDrafts.orgId, actor.orgId)));
      if (!draft) throw new DeskError("not_found", "This draft does not exist.");
      if (draft.status !== "claimed") throw new DeskError("invalid_state", `This draft is ${draft.status}.`, { status: draft.status });
      const name = await holderName(tx, draft.claimedBy);
      throw new DeskError("held_by_other", `${name} is working on this.`, { heldBy: name, until: draft.claimExpiresAt });
    }

    await notify(tx, actor.orgId, { type: "draft.claimed", draftId, userId: actor.id, name: actor.name, until: claimed.claimExpiresAt!.toISOString() });
    return claimed;
  });
}

/** Sent every 60 s while the editor is open. */
export async function extendClaim(db: Db, actor: Actor, draftId: string): Promise<Date> {
  const [row] = await db
    .update(postDrafts)
    .set({ claimExpiresAt: leaseUntil() })
    .where(and(eq(postDrafts.id, draftId), eq(postDrafts.claimedBy, actor.id), eq(postDrafts.status, "claimed"), sql`${postDrafts.claimExpiresAt} > now()`))
    .returning({ until: postDrafts.claimExpiresAt });
  if (!row?.until) throw new DeskError("lease_lost", "Your hold on this draft has expired. Open it again to keep working.");
  return row.until;
}

export async function releaseDraft(db: Db, actor: Actor, draftId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(postDrafts)
      .set({ status: "ready", claimedBy: null, claimExpiresAt: null, updatedAt: sql`now()` })
      .where(and(eq(postDrafts.id, draftId), eq(postDrafts.claimedBy, actor.id), eq(postDrafts.status, "claimed")))
      .returning({ id: postDrafts.id });
    if (row) await notify(tx, actor.orgId, { type: "draft.released", draftId });
  });
}

/** Run by the worker: a lease nobody extended goes back to the queue. */
export async function releaseExpiredClaims(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(postDrafts)
      .set({ status: "ready", claimedBy: null, claimExpiresAt: null, updatedAt: sql`now()` })
      .where(and(eq(postDrafts.status, "claimed"), sql`${postDrafts.claimExpiresAt} < now()`))
      .returning({ id: postDrafts.id, orgId: postDrafts.orgId });
    for (const r of rows) await notify(tx, r.orgId, { type: "draft.released", draftId: r.id });
    return rows.length;
  });
}

// ─── Editing ─────────────────────────────────────────────────────────────────

export interface DraftPatch {
  bodyText?: string;
  cardHeadline?: string;
  hashtags?: string[];
  mentions?: string[];
}

/**
 * Save the operator's edits. The client sends the version it loaded; a different version on the
 * server means a colleague saved in between, and the 409 carries the current copy for a diff.
 */
export async function updateDraft(db: Db, actor: Actor, draftId: string, version: number, patch: DraftPatch): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    if (draft.version !== version) {
      throw new DeskError("stale_version", "Someone else saved this draft after you opened it.", { current: draft });
    }
    requireLease(draft, actor);

    if (patch.mentions) await assertVerifiedMentions(tx, actor.orgId, patch.mentions, draft);

    const cardChanged = patch.cardHeadline !== undefined && patch.cardHeadline.trim() !== draft.cardHeadline;
    const [updated] = await tx
      .update(postDrafts)
      .set({
        ...(patch.bodyText !== undefined && { bodyText: patch.bodyText.trim() }),
        ...(patch.cardHeadline !== undefined && { cardHeadline: patch.cardHeadline.trim() }),
        ...(patch.hashtags && { hashtags: patch.hashtags }),
        ...(patch.mentions && { mentions: patch.mentions }),
        ...(cardChanged && { cardRev: sql`${postDrafts.cardRev} + 1` }),
        version: sql`${postDrafts.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(postDrafts.id, draftId))
      .returning();

    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.edit", entityType: "post_draft", entityId: draftId, before: pickEditable(draft), after: pickEditable(updated!) });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

// ─── Custom card ─────────────────────────────────────────────────────────────

/** The card that goes out with the post: the operator's own if set, else the rendered one. */
export function postedCardKey(draft: Pick<Draft, "cardKey" | "customCardKey">): string | null {
  return draft.customCardKey ?? draft.cardKey;
}

/** Checks shared by the card changes: same version, a live hold, still claimed. */
function requireEditable(draft: Draft, actor: Actor, version: number): void {
  if (draft.version !== version) throw new DeskError("stale_version", "Someone else saved this draft after you opened it.", { current: draft });
  requireLease(draft, actor);
  if (draft.status !== "claimed") throw new DeskError("invalid_state", `A ${draft.status} draft cannot be changed this way.`, { status: draft.status });
}

export interface CustomCard {
  bytes: number;
  width: number;
  height: number;
}

/**
 * Use the operator's edited card (a PNG made in the browser) in place of the rendered one. The
 * file is stored only after every check passes, under a new key each time, so a link to an
 * earlier card never shows the new one. Editing the headline later does not clear it.
 */
export async function setCustomCard(
  db: Db, actor: Actor, draftId: string, version: number, card: CustomCard, store: (key: string) => Promise<void>,
): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    requireEditable(draft, actor, version);
    const key = `cards/${draftId}/custom-${randomUUID()}.png`;
    await store(key);
    const [updated] = await tx
      .update(postDrafts)
      .set({ customCardKey: key, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId))
      .returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.card_uploaded", entityType: "post_draft", entityId: draftId, before: { key: draft.customCardKey }, after: { key, ...card } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

/** Back to the rendered card. The old file stays in storage (the audit log points at it). */
export async function clearCustomCard(db: Db, actor: Actor, draftId: string, version: number): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    requireEditable(draft, actor, version);
    const [updated] = await tx
      .update(postDrafts)
      .set({ customCardKey: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId))
      .returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.card_reset", entityType: "post_draft", entityId: draftId, before: { key: draft.customCardKey }, after: { key: null } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

function pickEditable(d: Draft) {
  return { bodyText: d.bodyText, cardHeadline: d.cardHeadline, hashtags: d.hashtags, mentions: d.mentions, version: d.version };
}

/** A mention must be one the composer suggested or a verified directory handle. Never a free guess. */
async function assertVerifiedMentions(db: Executor, orgId: string, mentions: string[], draft: Draft): Promise<void> {
  const suggested = new Set((draft.mentionSuggestions as { handle: string }[]).map((m) => m.handle.toLowerCase()));
  const unknown = mentions.filter((m) => !suggested.has(m.toLowerCase()));
  if (!unknown.length) return;
  const bare = unknown.map((m) => m.replace(/^@/, "").toLowerCase());
  const rows = await db
    .select({ handle: handleDirectory.handle })
    .from(handleDirectory)
    .where(and(eq(handleDirectory.orgId, orgId), sql`lower(ltrim(${handleDirectory.handle}, '@')) IN ${bare}`, sql`${handleDirectory.verifiedAt} IS NOT NULL`));
  const verified = new Set(rows.map((r) => r.handle.replace(/^@/, "").toLowerCase()));
  const bad = bare.filter((h) => !verified.has(h));
  if (bad.length) throw new DeskError("bad_mention", `@${bad[0]} is not a verified handle. Add it to the handle directory first.`, { handles: bad });
}

// ─── Caps ────────────────────────────────────────────────────────────────────

export interface CapUsage {
  platform: string;
  used: number;
  cap: number;
  level: ReturnType<typeof capLevel>;
}

/** Posts sent today (IST) plus posts waiting to send, against the org's daily cap. */
export async function capUsage(db: Executor, orgId: string, platform = "x", now = new Date()): Promise<CapUsage> {
  const [org] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const cap = org?.settings.dailyCaps.x ?? 800;
  const [sent] = await db
    .select({ n: count() })
    .from(publishedPosts)
    .where(and(eq(publishedPosts.orgId, orgId), eq(publishedPosts.platform, platform), gte(publishedPosts.publishedAt, istDayStart(now))));
  const [waiting] = await db
    .select({ n: count() })
    .from(publishJobs)
    .where(and(eq(publishJobs.orgId, orgId), eq(publishJobs.kind, "post"), inArray(publishJobs.status, ["pending", "running"])));
  const used = (sent?.n ?? 0) + (waiting?.n ?? 0);
  return { platform, used, cap, level: capLevel(used, cap) };
}

// ─── Approve, undo, reject ──────────────────────────────────────────────────

export function postText(draft: Pick<Draft, "bodyText" | "hashtags" | "mentions">): string {
  return assemblePostText(draft.bodyText, draft.hashtags, draft.mentions);
}

/**
 * Approve & post. The publish job is written in the same transaction as the draft's change, and
 * waits UNDO_SECONDS before any worker may take it.
 */
export async function approveDraft(db: Db, actor: Actor, draftId: string, version: number) {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    if (draft.version !== version) throw new DeskError("stale_version", "Someone else saved this draft after you opened it.", { current: draft });
    requireLease(draft, actor);
    const status = move(draft, "approve");

    // An operator's own card does not wait for the rendered one to catch up with an edit
    if (!draft.customCardKey && (draft.cardRenderedRev !== draft.cardRev || !draft.cardKey)) {
      throw new DeskError("card_not_ready", "The card is still being drawn with your last change. Try again in a second.");
    }
    const check = checkXPost(postText(draft));
    if (!check.ok) throw new DeskError("post_invalid", check.problems[0]!, { problems: check.problems });

    const cap = await capUsage(tx, actor.orgId, draft.platform);
    if (cap.used >= cap.cap) throw new DeskError("cap_full", `Today's X cap of ${cap.cap} posts is used up.`, { ...cap });

    const [job] = await tx
      .insert(publishJobs)
      .values({ orgId: actor.orgId, draftId, kind: "post", nextAttemptAt: sql`now() + make_interval(secs => ${UNDO_SECONDS})`, createdBy: actor.id })
      .returning();
    const [updated] = await tx
      .update(postDrafts)
      .set({ status, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId))
      .returning();

    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.approve", entityType: "post_draft", entityId: draftId, before: { status: draft.status }, after: { status, jobId: job!.id, text: postText(draft) } });
    await notify(tx, actor.orgId, { type: "post.queued", draftId, jobId: job!.id, sendAt: job!.nextAttemptAt.toISOString() });
    await notify(tx, actor.orgId, { type: "cap.changed", platform: draft.platform, used: cap.used + 1, cap: cap.cap });
    return { draft: updated!, job: job! };
  });
}

/**
 * Cancel a post inside its undo window. Zero rows means a worker already took the job, so it is
 * too late: the operator recalls it from the Published tab instead.
 */
export async function undoPost(db: Db, actor: Actor, jobId: string): Promise<Draft> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .update(publishJobs)
      .set({ status: "cancelled", updatedAt: sql`now()` })
      .where(and(eq(publishJobs.id, jobId), eq(publishJobs.orgId, actor.orgId), eq(publishJobs.status, "pending"), isNull(publishJobs.claimedAt)))
      .returning();
    if (!job) throw new DeskError("too_late", "This post has already gone out. Recall it from the Published tab.");

    const draft = await lockDraft(tx, actor, job.draftId);
    const status = move(draft, "undo");
    const [updated] = await tx
      .update(postDrafts)
      .set({ status, claimedBy: actor.id, claimExpiresAt: leaseUntil(), version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draft.id))
      .returning();

    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "post.undo", entityType: "publish_job", entityId: jobId, before: { status: "pending" }, after: { status: "cancelled" } });
    await notify(tx, actor.orgId, { type: "post.cancelled", draftId: draft.id, jobId });
    return updated!;
  });
}

export async function rejectDraft(db: Db, actor: Actor, draftId: string, reason: RejectReason, note: string | null): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    requireLease(draft, actor);
    const status = move(draft, "reject");
    const [updated] = await tx
      .update(postDrafts)
      .set({ status, rejectReason: reason, rejectNote: note, claimedBy: null, claimExpiresAt: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId))
      .returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.reject", entityType: "post_draft", entityId: draftId, before: { status: draft.status }, after: { status, reason, note } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status, version: updated!.version });
    return updated!;
  });
}

export async function restoreDraft(db: Db, actor: Actor, draftId: string): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    const status = move(draft, "restore");
    const [updated] = await tx
      .update(postDrafts)
      .set({ status, rejectReason: null, rejectNote: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId))
      .returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.restore", entityType: "post_draft", entityId: draftId, before: { status: draft.status }, after: { status } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status, version: updated!.version });
    return updated!;
  });
}

/**
 * The operator posted on X by hand and records it here. The post already exists, so the daily cap
 * is not checked (it still counts); the post row is what makes it show as published.
 */
export async function markPosted(db: Db, actor: Actor, draftId: string, version: number, post: { platformPostId: string; permalink: string }) {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    if (draft.version !== version) throw new DeskError("stale_version", "Someone else saved this draft after you opened it.", { current: draft });
    requireLease(draft, actor);
    const status = move(draft, "mark_posted");
    const cardKey = postedCardKey(draft);

    // The unique (platform, platform_post_id) index decides: a second record of the same post is refused
    const [row] = await tx
      .insert(publishedPosts)
      .values({ orgId: actor.orgId, draftId, platform: draft.platform, platformPostId: post.platformPostId, permalink: post.permalink, text: postText(draft), publishedBy: actor.id, cardKey, manual: true })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new DeskError("duplicate_post", "This X post is already recorded on the desk.", { platformPostId: post.platformPostId });

    await tx
      .update(postDrafts)
      .set({ status, claimedBy: null, claimExpiresAt: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId));
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.mark_posted", entityType: "post_draft", entityId: draftId, before: { status: draft.status }, after: { permalink: post.permalink, cardKey } });
    await notify(tx, actor.orgId, { type: "post.sent", draftId, postId: row.id, permalink: post.permalink });
    const cap = await capUsage(tx, actor.orgId, draft.platform);
    await notify(tx, actor.orgId, { type: "cap.changed", platform: draft.platform, used: cap.used, cap: cap.cap });
    return row;
  });
}

/** A post whose attempts ran out goes back to the publish queue, sending now. */
export async function retryFailed(db: Db, actor: Actor, draftId: string) {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    const status = move(draft, "retry");
    // The same daily cap as approveDraft: a failed post did not count, so its retry must fit under the cap
    const cap = await capUsage(tx, actor.orgId, draft.platform);
    if (cap.used >= cap.cap) throw new DeskError("cap_full", `Today's X cap of ${cap.cap} posts is used up.`, { ...cap });
    const [job] = await tx.insert(publishJobs).values({ orgId: actor.orgId, draftId, kind: "post", createdBy: actor.id }).returning();
    await tx.update(postDrafts).set({ status, updatedAt: sql`now()` }).where(eq(postDrafts.id, draftId));
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "post.retry", entityType: "post_draft", entityId: draftId, before: { status: draft.status }, after: { status, jobId: job!.id } });
    await notify(tx, actor.orgId, { type: "post.queued", draftId, jobId: job!.id, sendAt: job!.nextAttemptAt.toISOString() });
    await notify(tx, actor.orgId, { type: "cap.changed", platform: draft.platform, used: cap.used + 1, cap: cap.cap });
    return job!;
  });
}

/** Recall: the publish worker deletes the post on X, then marks it recalled. */
export async function requestRecall(db: Db, actor: Actor, postId: string, reason: string) {
  return db.transaction(async (tx) => {
    const [post] = await tx
      .select()
      .from(publishedPosts)
      .where(and(eq(publishedPosts.id, postId), eq(publishedPosts.orgId, actor.orgId)))
      .for("update");
    if (!post) throw new DeskError("not_found", "This post does not exist.");
    if (post.recalledAt) throw new DeskError("invalid_state", "This post has already been recalled.");
    const [pendingDelete] = await tx
      .select({ id: publishJobs.id })
      .from(publishJobs)
      .where(and(eq(publishJobs.draftId, post.draftId), eq(publishJobs.kind, "delete"), inArray(publishJobs.status, ["pending", "running"])));
    if (pendingDelete) return pendingDelete;

    const [job] = await tx
      .insert(publishJobs)
      .values({ orgId: actor.orgId, draftId: post.draftId, kind: "delete", platformPostId: post.platformPostId, reason, createdBy: actor.id })
      .returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "post.recall_requested", entityType: "published_post", entityId: postId, after: { reason, jobId: job!.id } });
    return job!;
  });
}
