// What an operator can do to a draft. Each function is one transaction: the state change, the
// audit row, and the live event commit together or not at all.

import {
  BREAKING_POST_MAX, COPY_UNDO_SECONDS, LEASE_SECONDS, NATIONAL_FOOTER, RAJASTHAN_FOOTER, UNDO_SECONDS, assemblePostText, capLevel, checkXPost, istDayStart, nextDraftStatus, reporterKey,
  type DraftAction, type DraftStatus, type RejectReason,
} from "@socia/core";
import { randomUUID } from "node:crypto";
import { and, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { audit } from "./audit";
import { noteOutcome, recordOutcome, voidOutcome } from "./decisions";
import type { Db, Executor } from "./client";
import { notify } from "./events";
import { REPORTER_SOURCE, auditLog, handleDirectory, hashtagStaging, orgs, postDrafts, publishJobs, publishedPosts, users, type DraftHandlePick } from "./schema";

export interface Actor {
  id: string;
  orgId: string;
  name: string;
  /** roles.key: a built-in role or a custom one */
  role: string;
}

export type DeskErrorCode =
  | "not_found" | "held_by_other" | "lease_lost" | "stale_version" | "invalid_state"
  | "card_not_ready" | "post_invalid" | "cap_full" | "too_late" | "bad_mention" | "duplicate_post" | "forbidden" | "already_posted" | "cooldown";

const HTTP_STATUS: Record<DeskErrorCode, number> = {
  not_found: 404, held_by_other: 409, lease_lost: 409, stale_version: 409, invalid_state: 409,
  card_not_ready: 409, post_invalid: 422, cap_full: 429, too_late: 409, bad_mention: 422, duplicate_post: 409, forbidden: 403, already_posted: 409, cooldown: 429,
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

/** Sent every 60 s while the editor is open. Keeps a correction hold on a posted story too; the status never changes. */
export async function extendClaim(db: Db, actor: Actor, draftId: string): Promise<Date> {
  const [row] = await db
    .update(postDrafts)
    // A correction hold never runs past 00:00 IST: after that the post is yesterday's and cannot be edited
    .set({ claimExpiresAt: sql`CASE WHEN ${postDrafts.status} = 'published' THEN ${correctionLeaseUntil()} ELSE ${leaseUntil()} END` })
    .where(and(eq(postDrafts.id, draftId), eq(postDrafts.claimedBy, actor.id), inArray(postDrafts.status, ["claimed", "published"]), sql`${postDrafts.claimExpiresAt} > now()`))
    .returning({ until: postDrafts.claimExpiresAt });
  if (!row?.until) throw new DeskError("lease_lost", "Your hold on this draft has expired. Open it again to keep working.");
  return row.until;
}

/**
 * Let the draft go: a claimed draft returns to the queue (ready). A posted story under a correction hold only
 * loses the hold: it stays published, and its updated_at (the posted view's order and day) is left alone. Either
 * way the hold's end is announced as draft.released (one lock record, one event, whichever kind of hold it was).
 */
export async function releaseDraft(db: Db, actor: Actor, draftId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const claimed = sql`${postDrafts.status} = 'claimed'`;
    const [row] = await tx
      .update(postDrafts)
      .set({
        status: sql`CASE WHEN ${claimed} THEN 'ready' ELSE ${postDrafts.status} END`,
        claimedBy: null,
        claimExpiresAt: null,
        updatedAt: sql`CASE WHEN ${claimed} THEN now() ELSE ${postDrafts.updatedAt} END`,
      })
      .where(and(eq(postDrafts.id, draftId), eq(postDrafts.claimedBy, actor.id), inArray(postDrafts.status, ["claimed", "published"])))
      .returning({ status: postDrafts.status, version: postDrafts.version });
    if (!row) return;
    await notify(tx, actor.orgId, { type: "draft.released", draftId });
  });
}

/**
 * Run by the worker: a lease nobody extended goes back to the queue. An expired correction hold on a posted story
 * (one that ran out, or reached 00:00 IST) is only cleared: it stays published, with its updated_at. Both kinds are
 * announced as draft.released. The count is both kinds.
 */
export async function releaseExpiredClaims(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(postDrafts)
      .set({ status: "ready", claimedBy: null, claimExpiresAt: null, updatedAt: sql`now()` })
      .where(and(eq(postDrafts.status, "claimed"), sql`${postDrafts.claimExpiresAt} < now()`))
      .returning({ id: postDrafts.id, orgId: postDrafts.orgId });
    for (const r of rows) await notify(tx, r.orgId, { type: "draft.released", draftId: r.id });
    const holds = await clearExpiredHolds(tx);
    for (const r of holds) await notify(tx, r.orgId, { type: "draft.released", draftId: r.id });
    return rows.length + holds.length;
  });
}

/** Expired correction holds on posted stories (optionally only these drafts of one org) cleared; status and updated_at kept */
async function clearExpiredHolds(tx: Executor, only?: { orgId: string; draftIds: string[] }) {
  if (only && !only.draftIds.length) return [];
  return tx
    .update(postDrafts)
    .set({ claimedBy: null, claimExpiresAt: null })
    .where(
      and(
        eq(postDrafts.status, "published"),
        sql`${postDrafts.claimedBy} IS NOT NULL`,
        sql`${postDrafts.claimExpiresAt} <= now()`,
        only ? eq(postDrafts.orgId, only.orgId) : undefined,
        only ? inArray(postDrafts.id, only.draftIds) : undefined,
      ),
    )
    .returning({ id: postDrafts.id, orgId: postDrafts.orgId, status: postDrafts.status, version: postDrafts.version });
}

/** On read (the draft view, the posted view): an expired correction hold on these drafts is cleared, quietly */
export async function clearExpiredCorrectionHolds(db: Executor, orgId: string, draftIds: string[]): Promise<number> {
  return (await clearExpiredHolds(db, { orgId, draftIds })).length;
}

// ─── Editing ─────────────────────────────────────────────────────────────────

export interface DraftPatch {
  bodyText?: string;
  cardHeadline?: string;
  hashtags?: string[];
  mentions?: string[];
}

export interface UpdateDraftOptions {
  /**
   * Every handle in the desk's reporter list, lower-cased without the @ (the API reads
   * apps/worker/config/reporter-handles.json). Two jobs: a reporter's handle counts as a verified handle
   * an editor may add, and adding one teaches us the file-name token it belongs to.
   */
  reporterHandles?: ReadonlySet<string>;
  /** The requesting user's rights over a posted story, recomputed for this request; without them a posted story is not editable */
  correction?: CorrectionRights;
}

/**
 * Save the operator's edits. The client sends the version it loaded; a different version on the
 * server means a colleague saved in between, and the 409 carries the current copy for a diff.
 *
 * A posted story under a correction hold (startCorrection) is saved the same way but stays published, after every
 * correction rule is checked again (today's post, the poster or someone allowed, Edit drafts). Only when the post
 * text really changes (trimmed, NFC) is it checked (checkXPost, 1000) and written to the Copy & Posted record,
 * stamped corrected_at / corrected_by and audited (draft.correct_posted); a save that changes nothing writes
 * nothing. Nothing that posting does runs again (no new post record, no hashtag staging, no decision-log
 * outcome), and updated_at is left alone, so the story keeps its place and day in the posted view.
 */
export async function updateDraft(db: Db, actor: Actor, draftId: string, version: number, patch: DraftPatch, opts: UpdateDraftOptions = {}): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    if (draft.version !== version) {
      throw new DeskError("stale_version", "Someone else saved this draft after you opened it.", { current: draft });
    }
    const post = draft.status === "published" ? await correctionPost(tx, actor, draft) : null;
    if (post) assertCorrectionRules(post, actor, opts.correction ?? NO_RIGHTS, "save");
    requireLease(draft, actor);

    if (patch.mentions) await assertVerifiedMentions(tx, actor.orgId, patch.mentions, draft, opts.reporterHandles);

    // A posted story: what the post would say after this save, and whether anything changes at all
    const nextText = postText({ bodyText: patch.bodyText?.trim() ?? draft.bodyText, hashtags: patch.hashtags ?? draft.hashtags, mentions: patch.mentions ?? draft.mentions });
    const textChanged = !!post && !sameText(nextText, post.text);
    if (post) {
      const same = (a: readonly string[] | undefined, b: readonly string[]) => a === undefined || (a.length === b.length && a.every((x, i) => x === b[i]));
      const draftChanged =
        (patch.bodyText !== undefined && patch.bodyText.trim() !== draft.bodyText) ||
        (patch.cardHeadline !== undefined && patch.cardHeadline.trim() !== draft.cardHeadline) ||
        !same(patch.hashtags, draft.hashtags) || !same(patch.mentions, draft.mentions);
      if (!draftChanged && !textChanged) return draft;
      if (textChanged) assertPostValid(nextText);
    }

    // A draft with no card asked for (phase 1, card_rev 0) stays without one when its card text changes. A posted
    // story is never re-rendered (the render worker skips published drafts): its card is corrected by upload.
    const cardChanged = !post && patch.cardHeadline !== undefined && patch.cardHeadline.trim() !== draft.cardHeadline && draft.cardRev > 0;
    const [updated] = await tx
      .update(postDrafts)
      .set({
        ...(patch.bodyText !== undefined && { bodyText: patch.bodyText.trim() }),
        ...(patch.cardHeadline !== undefined && { cardHeadline: patch.cardHeadline.trim() }),
        ...(patch.hashtags && { hashtags: patch.hashtags }),
        ...(patch.mentions && { mentions: patch.mentions }),
        ...(cardChanged && { cardRev: sql`${postDrafts.cardRev} + 1` }),
        version: sql`${postDrafts.version} + 1`,
        ...(!post && { updatedAt: sql`now()` }),
      })
      .where(eq(postDrafts.id, draftId))
      .returning();

    if (post && textChanged) {
      // Back to exactly what went out (trimmed, NFC): the original is written back and the post is no longer "edited"
      const original = await originalPost(tx, post);
      const restored = sameText(nextText, original.text);
      const text = restored ? original.text : postText(updated!);
      const edited = !(restored && post.cardKey === original.cardKey);
      await tx
        .update(publishedPosts)
        .set({ text, correctedAt: edited ? sql`now()` : null, correctedBy: edited ? actor.id : null })
        .where(eq(publishedPosts.id, post.id));
      await audit(tx, {
        orgId: actor.orgId, actorId: actor.id, action: "draft.correct_posted", entityType: "post_draft", entityId: draftId,
        before: { ...pickEditable(draft), postId: post.id, text: post.text }, after: { ...pickEditable(updated!), postId: post.id, text, restored: !edited },
      });
    } else {
      await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.edit", entityType: "post_draft", entityId: draftId, before: pickEditable(draft), after: pickEditable(updated!) });
    }
    // An editor putting a reporter's handle on a draft tells us whose byline that file name means
    if (patch.mentions) await learnReporterTokens(tx, actor, draft, patch.mentions, opts.reporterHandles);
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

/** How many example headlines a staged hashtag keeps, newest first */
const HASHTAG_EXAMPLES = 5;

/**
 * The write-back loop for hashtags: what the desk tags that we do not.
 *
 * A breaking post carries the footer tag and nothing else automatically — the topic rules are offered,
 * not applied, because applying them was wrong far more often than right. So every other hashtag on a
 * published post was typed by an editor, and that is the most direct evidence there is of a rule the
 * desk wants and we do not have. Each one is counted here with a few example headlines, for the weekly
 * pass that decides whether it earns a rule and which keywords should fire it.
 *
 * Nothing staged here is ever tagged automatically. A row is a question for a human: the tag the desk
 * reached for, how often, and on what kind of story. Accepting one of our own suggestions is not staged
 * — that is the rule working, not a gap.
 */
async function stagePostedHashtags(tx: Executor, actor: Actor, draft: Draft): Promise<void> {
  // Only a post as it went out: the editor autosaves while typing, and a half-typed "#Rajas" is not a tag.
  // Only breaking drafts composed footer-only (they carry a handle_pick): on an older or a non-breaking
  // draft the composer applied topic tags itself, and those are not the desk's.
  if (draft.handlePick === null) return;
  const known = new Set(
    [RAJASTHAN_FOOTER, NATIONAL_FOOTER, ...draft.hashtagSuggestions].map((t) => t.replace(/^#/, "").toLowerCase()),
  );
  const added = new Map<string, string>();
  for (const raw of draft.hashtags) {
    const tag = raw.trim();
    const key = tag.replace(/^#/, "").toLowerCase();
    if (!key || known.has(key) || added.has(key)) continue;
    added.set(key, tag.startsWith("#") ? tag : `#${tag}`);
  }
  if (!added.size) return;

  const example = { draftId: draft.id, headline: draft.cardHeadline.slice(0, 200), at: new Date().toISOString() };
  for (const [tagKey, tag] of added) {
    await tx
      .insert(hashtagStaging)
      .values({ orgId: actor.orgId, tag, tagKey, uses: 1, examples: [example] })
      .onConflictDoUpdate({
        target: [hashtagStaging.orgId, hashtagStaging.tagKey],
        // A draft posted, undone and posted again counts once
        setWhere: sql`NOT (${hashtagStaging.examples} @> ${JSON.stringify([{ draftId: draft.id }])}::jsonb)`,
        set: {
          uses: sql`${hashtagStaging.uses} + 1`,
          lastSeenAt: sql`now()`,
          // Newest first, capped — enough to see what kind of story it goes on without growing forever
          examples: sql`(
            SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
            FROM (
              SELECT e FROM jsonb_array_elements(${JSON.stringify([example])}::jsonb || ${hashtagStaging.examples}) AS e
              LIMIT ${HASHTAG_EXAMPLES}
            ) t
          )`,
        },
      });
  }
  await audit(tx, {
    orgId: actor.orgId, actorId: actor.id, action: "hashtag.staged", entityType: "post_draft", entityId: draft.id,
    before: { tags: [] }, after: { tags: [...added.values()] },
  });
}

/**
 * The write-back loop that keeps the reporter list from decaying.
 *
 * A breaking file name carries a reporter token ("...NDR_PK_AGARWAL_BIG"). When the list does not know
 * that token the post goes out with no byline and the token is recorded on the draft. If an editor then
 * adds a reporter's handle by hand, that is the desk telling us the token belongs to that reporter: it is
 * stored as an alias in handle_directory (source "reporter"), and the worker merges it into the list on
 * its next reload, so the same file name resolves by itself from then on.
 *
 * Only handles the desk already lists as reporters are learned from. Any other handle an editor adds —
 * a district police handle, a minister — says nothing about whose byline the file carries, and learning
 * from it would put that handle on every future story by the same reporter.
 */
async function learnReporterTokens(tx: Executor, actor: Actor, draft: Draft, mentions: string[], reporterHandles?: ReadonlySet<string>): Promise<void> {
  if (!reporterHandles?.size) return;
  const pick = draft.handlePick as DraftHandlePick | null;
  // jsonb from the database: never trusted to have the shape the type claims
  const token = typeof pick?.reporterToken === "string" ? pick.reporterToken : null;
  if (!token) return;
  // The name already resolved to a reporter, so this edit is about something else — a second byline, a
  // correction. Learning from it would hand the name to two reporters at once, and a name two reporters
  // claim is then tagged for NEITHER of them, on every later story that carries it.
  if (Array.isArray(pick?.handles) && pick.handles.some((h) => h?.reason === "reporter")) return;
  const key = reporterKey(token);
  if (!key) return;
  const had = new Set(draft.mentions.map((m) => m.replace(/^@/, "").toLowerCase()));
  const added = [
    ...new Map(
      mentions
        .map((m) => m.replace(/^@/, ""))
        .filter((h) => !had.has(h.toLowerCase()) && reporterHandles.has(h.toLowerCase()))
        .map((h) => [h.toLowerCase(), h] as const),
    ).values(),
  ];

  for (const handle of added) {
    const [row] = await tx
      .select({ id: handleDirectory.id })
      .from(handleDirectory)
      .where(
        and(
          eq(handleDirectory.orgId, actor.orgId),
          eq(handleDirectory.platform, "x"),
          eq(handleDirectory.source, REPORTER_SOURCE),
          sql`lower(ltrim(${handleDirectory.handle}, '@')) = ${handle.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (row) {
      // Appended in one statement, so two editors teaching two names at the same moment cannot lose one
      // of them to a read-modify-write. The guard makes a name we already hold a no-op.
      //
      // verified_at doubles as the directory's change stamp — dictionaryFingerprint is built from the
      // row count and max(verified_at) — so bumping it is what makes the worker reload and start
      // resolving the new name. A row an admin has UN-verified stays un-verified: they took that handle
      // out of use on purpose, and nothing here may put it back. verified_by is left alone either way:
      // it records who vouched for the handle, not who taught us a name for it.
      const [changed] = await tx
        .update(handleDirectory)
        .set({
          aliases: sql`array_append(${handleDirectory.aliases}, ${key})`,
          verifiedAt: sql`CASE WHEN ${handleDirectory.verifiedAt} IS NULL THEN NULL ELSE now() END`,
        })
        .where(and(eq(handleDirectory.id, row.id), sql`NOT (${handleDirectory.aliases} @> ARRAY[${key}]::text[])`))
        .returning({ id: handleDirectory.id });
      if (!changed) continue;
    } else {
      await tx.insert(handleDirectory).values({
        orgId: actor.orgId,
        entityName: handle,
        aliases: [key],
        platform: "x",
        handle: `@${handle}`,
        source: REPORTER_SOURCE,
        verifiedAt: sql`now()`,
        verifiedBy: actor.id,
      });
    }
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "handle.reporter_token_learned", entityType: "post_draft", entityId: draft.id,
      before: { token: key, handle: null }, after: { token: key, handle: `@${handle}` },
    });
  }
}

// ─── Custom card ─────────────────────────────────────────────────────────────

/** The card that goes out with the post: the operator's own if set, else the rendered one. */
export function postedCardKey(draft: Pick<Draft, "cardKey" | "customCardKey">): string | null {
  return draft.customCardKey ?? draft.cardKey;
}

/**
 * Checks shared by the card changes: same version, a live hold, and still claimed. Or a posted story under a
 * correction hold: its Copy & Posted record (locked) is returned, so the change is recorded on it.
 */
async function requireEditable(tx: Executor, draft: Draft, actor: Actor, version: number, rights: CorrectionRights): Promise<CorrectedPost | null> {
  if (draft.version !== version) throw new DeskError("stale_version", "Someone else saved this draft after you opened it.", { current: draft });
  if (draft.status === "published") {
    const post = await correctionPost(tx, actor, draft);
    assertCorrectionRules(post, actor, rights, "save");
    requireLease(draft, actor);
    return post;
  }
  requireLease(draft, actor);
  if (draft.status !== "claimed") throw new DeskError("invalid_state", `A ${draft.status} draft cannot be changed this way.`, { status: draft.status });
  return null;
}

/**
 * A posted story's card changed under a correction hold: the post record takes the new card, stamped, and audited.
 * Only a different card key is a change; the same card again writes nothing.
 */
async function recordCardCorrection(tx: Executor, actor: Actor, before: Draft, after: Draft, post: CorrectedPost, extra: Record<string, unknown> = {}): Promise<void> {
  const cardKey = postedCardKey(after);
  if (cardKey === post.cardKey) return;
  // Back to the card that went out, with the text as it went out: the post is no longer "edited"
  const original = await originalPost(tx, post);
  const edited = !(cardKey === original.cardKey && sameText(post.text, original.text));
  await tx
    .update(publishedPosts)
    .set({ cardKey, correctedAt: edited ? sql`now()` : null, correctedBy: edited ? actor.id : null })
    .where(eq(publishedPosts.id, post.id));
  await audit(tx, {
    orgId: actor.orgId, actorId: actor.id, action: "draft.correct_posted", entityType: "post_draft", entityId: before.id,
    before: { ...pickEditable(before), postId: post.id, cardKey: post.cardKey },
    after: { ...pickEditable(after), postId: post.id, cardKey, restored: !edited, ...extra },
  });
}

/**
 * What a Copy & Posted record said when it went out. A record never corrected (or corrected back) is as it went
 * out; otherwise the first draft.correct_posted audit row of this record that changed the text (or the card) holds
 * the original in its `before`. Audit rows are written in the same transaction as each correction and never pruned.
 */
async function originalPost(tx: Executor, post: CorrectedPost): Promise<{ text: string; cardKey: string | null }> {
  if (!post.correctedAt) return { text: post.text, cardKey: post.cardKey };
  const rows = await tx
    .select({ before: auditLog.before })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "post_draft"),
        eq(auditLog.entityId, post.draftId),
        eq(auditLog.action, "draft.correct_posted"),
        sql`${auditLog.after}->>'postId' = ${post.id}`,
      ),
    )
    .orderBy(auditLog.id);
  const befores = rows.map((r) => r.before).filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
  const firstText = befores.find((b) => typeof b.text === "string");
  const firstCard = befores.find((b) => "cardKey" in b);
  return {
    text: firstText ? (firstText.text as string) : post.text,
    cardKey: firstCard ? ((firstCard.cardKey as string | null) ?? null) : post.cardKey,
  };
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
  /** The file's own format: the key's extension, which is what the file is served as */
  format: "jpg" | "png" = "png",
  /** The requesting user's rights over a posted story; without them a posted story's card cannot change */
  rights: CorrectionRights = NO_RIGHTS,
): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    const post = await requireEditable(tx, draft, actor, version, rights);
    const key = `cards/${draftId}/custom-${randomUUID()}.${format}`;
    await store(key);
    const [updated] = await tx
      .update(postDrafts)
      // A posted story keeps its updated_at: its place and day in the posted view
      .set({ customCardKey: key, version: sql`${postDrafts.version} + 1`, ...(!post && { updatedAt: sql`now()` }) })
      .where(eq(postDrafts.id, draftId))
      .returning();
    if (post) await recordCardCorrection(tx, actor, draft, updated!, post, { ...card });
    else await audit(tx,{ orgId: actor.orgId, actorId: actor.id, action: "draft.card_uploaded", entityType: "post_draft", entityId: draftId, before: { key: draft.customCardKey }, after: { key, ...card } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

/** Back to the rendered card. The old file stays in storage (the audit log points at it). */
export async function clearCustomCard(db: Db, actor: Actor, draftId: string, version: number, rights: CorrectionRights = NO_RIGHTS): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    const post = await requireEditable(tx, draft, actor, version, rights);
    // A posted story already on its rendered card: nothing changes, nothing is written
    if (post && !draft.customCardKey) return draft;
    const [updated] = await tx
      .update(postDrafts)
      .set({ customCardKey: null, version: sql`${postDrafts.version} + 1`, ...(!post && { updatedAt: sql`now()` }) })
      .where(eq(postDrafts.id, draftId))
      .returning();
    if (post) await recordCardCorrection(tx, actor, draft, updated!, post);
    else await audit(tx,{ orgId: actor.orgId, actorId: actor.id, action: "draft.card_reset", entityType: "post_draft", entityId: draftId, before: { key: draft.customCardKey }, after: { key: null } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

function pickEditable(d: Draft) {
  return { bodyText: d.bodyText, cardHeadline: d.cardHeadline, hashtags: d.hashtags, mentions: d.mentions, version: d.version };
}

/**
 * A mention must be one the composer suggested, a handle in the desk's own reporter list, or a verified
 * directory handle. Never a free guess.
 */
async function assertVerifiedMentions(db: Executor, orgId: string, mentions: string[], draft: Draft, reporterHandles?: ReadonlySet<string>): Promise<void> {
  const suggested = new Set((draft.mentionSuggestions as { handle: string }[]).map((m) => m.handle.toLowerCase()));
  const unknown = mentions.filter((m) => !suggested.has(m.toLowerCase()) && !reporterHandles?.has(m.replace(/^@/, "").toLowerCase()));
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

    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    await stagePostedHashtags(tx, actor, draft);
    noteOutcome(await recordOutcome(tx, { orgId: actor.orgId, draftId, decision: "approved", finalText: postText(draft), decidedBy: actor.id }), { orgId: actor.orgId, draftId: draftId, op: "approved", expectRow: draft.handlePick !== null });
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

    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    noteOutcome(await voidOutcome(tx, { orgId: actor.orgId, draftId: draft.id, voidedBy: actor.id }), { orgId: actor.orgId, draftId: draft.id, op: "void", expectRow: draft.handlePick !== null });
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
    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    noteOutcome(await recordOutcome(tx, { orgId: actor.orgId, draftId, decision: "rejected", finalText: postText(draft), decidedBy: actor.id, rejectReason: reason }), { orgId: actor.orgId, draftId: draftId, op: "rejected", expectRow: draft.handlePick !== null });
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
    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    noteOutcome(await voidOutcome(tx, { orgId: actor.orgId, draftId, voidedBy: actor.id }), { orgId: actor.orgId, draftId: draftId, op: "void", expectRow: draft.handlePick !== null });
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
    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    await stagePostedHashtags(tx, actor, draft);
    noteOutcome(await recordOutcome(tx, { orgId: actor.orgId, draftId, decision: "mark_posted", finalText: row.text, decidedBy: actor.id }), { orgId: actor.orgId, draftId: draftId, op: "mark_posted", expectRow: draft.handlePick !== null });
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
    if (!post.platformPostId) throw new DeskError("invalid_state", "This post was pasted on X by hand, so Socia cannot delete it. Delete it on X yourself.");
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

// ─── Phase 1: Copy & Posted, card on demand ─────────────────────────────────

export interface CopyPosted {
  postId: string;
  draftId: string;
  text: string;
  postedAt: Date;
  postedBy: { id: string; name: string };
  undoUntil: Date;
}

/**
 * The operator copied the post text and pasted it on X by hand. No claim needed first: from the queue a
 * ready draft goes straight to published, unless someone else is holding it. The version is the one whose
 * text was copied, so a colleague's edit in between is caught (409) instead of recorded as posted.
 */
export async function copyPosted(db: Db, actor: Actor, draftId: string, version: number): Promise<CopyPosted> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    // Before the version check: a colleague's Copy & Posted bumps the version too, and "copy again" would be wrong
    if (draft.status === "published") {
      const [post] = await tx
        .select({ at: publishedPosts.publishedAt, name: users.name })
        .from(publishedPosts)
        .leftJoin(users, eq(users.id, publishedPosts.publishedBy))
        .where(and(eq(publishedPosts.draftId, draftId), isNull(publishedPosts.recalledAt)))
        .orderBy(sql`${publishedPosts.publishedAt} DESC`)
        .limit(1);
      const by = post?.name ?? "Someone";
      throw new DeskError("already_posted", `${by} already posted this. Do not post it again.`, { postedBy: by, postedAt: post?.at ?? null });
    }
    if (draft.version !== version) throw new DeskError("stale_version", "This post changed after you copied it. Copy it again.", { current: draft });
    const holder = draft.claimedBy;
    if (draft.status === "claimed" && holder !== null && holder !== actor.id && holdsLease(draft, { ...actor, id: holder })) {
      const name = await holderName(tx, draft.claimedBy);
      throw new DeskError("held_by_other", `${name} is working on this.`, { heldBy: name, until: draft.claimExpiresAt });
    }
    const status = move(draft, "copy_posted");
    const text = postText(draft);
    // Posted by hand: the composer's limit, not X's 280 (b8 decisions §0.2)
    const check = checkXPost(text, BREAKING_POST_MAX);
    if (!check.ok) throw new DeskError("post_invalid", check.problems[0]!, { problems: check.problems });

    const [row] = await tx
      .insert(publishedPosts)
      .values({ orgId: actor.orgId, draftId, platform: draft.platform, platformPostId: null, permalink: null, text, publishedBy: actor.id, cardKey: postedCardKey(draft), manual: true })
      .returning();
    await tx
      .update(postDrafts)
      .set({ status, claimedBy: null, claimExpiresAt: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId));
    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    await stagePostedHashtags(tx, actor, draft);
    noteOutcome(await recordOutcome(tx, { orgId: actor.orgId, draftId, decision: "copy_posted", finalText: text, decidedBy: actor.id }), { orgId: actor.orgId, draftId: draftId, op: "copy_posted", expectRow: draft.handlePick !== null });
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.copy_posted", entityType: "post_draft", entityId: draftId, before: { status: draft.status, version }, after: { status, postId: row!.id, text } });
    await notify(tx, actor.orgId, { type: "post.sent", draftId, postId: row!.id, permalink: null });
    const cap = await capUsage(tx, actor.orgId, draft.platform);
    await notify(tx, actor.orgId, { type: "cap.changed", platform: draft.platform, used: cap.used, cap: cap.cap });
    return {
      postId: row!.id, draftId, text, postedAt: row!.publishedAt, postedBy: { id: actor.id, name: actor.name },
      undoUntil: new Date(row!.publishedAt.getTime() + COPY_UNDO_SECONDS * 1000),
    };
  });
}

/** The newest Copy & Posted record of a draft (no link, not recalled), locked; null when there is none */
async function copiedPost(tx: Executor, orgId: string, draftId: string) {
  const [post] = await tx
    .select()
    .from(publishedPosts)
    .where(and(eq(publishedPosts.orgId, orgId), eq(publishedPosts.draftId, draftId), eq(publishedPosts.manual, true), isNull(publishedPosts.permalink), isNull(publishedPosts.recalledAt)))
    .orderBy(sql`${publishedPosts.publishedAt} DESC`)
    .limit(1)
    .for("update");
  return post ?? null;
}

// ─── Correcting a posted story (Edit on Posted today) ───────────────────────

type CorrectedPost = typeof publishedPosts.$inferSelect;

const NOT_COPY_POSTED = "Only a story posted with Copy & Posted can be edited after posting.";

/** The Copy & Posted record of a published draft under a correction hold (locked); any other published draft is 409 invalid_state */
async function correctionPost(tx: Executor, actor: Actor, draft: Draft): Promise<CorrectedPost> {
  const post = await copiedPost(tx, actor.orgId, draft.id);
  if (!post) throw new DeskError("invalid_state", NOT_COPY_POSTED, { status: draft.status });
  return post;
}

/** Posted on today's India calendar day: the day the posted view and the daily counts use (istDayStart) */
export function postedTodayIst(postedAt: Date, now = new Date()): boolean {
  return postedAt >= istDayStart(now);
}

/** The next 00:00 IST after `now`: a correction hold never outlives the day of its post */
export function nextIstMidnight(now = new Date()): Date {
  return new Date(istDayStart(now).getTime() + 24 * 60 * 60 * 1000);
}

/** claimDraft's lease, capped at the next 00:00 IST */
const correctionLeaseUntil = () => sql`LEAST(now() + make_interval(secs => ${LEASE_SECONDS}), ${nextIstMidnight().toISOString()}::timestamptz)`;

/** What the requesting user may do to a posted story, from this request's own permissions (never cached) */
export interface CorrectionRights {
  /** Edit drafts, usable on X */
  canEdit: boolean;
  /** May correct a story someone else posted: Undo, the admin role, or every permission */
  canCorrectOthers: boolean;
}

const NO_RIGHTS: CorrectionRights = { canEdit: false, canCorrectOthers: false };

const NOT_YOURS = "Only the person who posted it or an admin can edit a posted story.";

/** The same text once trimmed and NFC-normalised (a different byte form of the same Hindi is no change) */
function sameText(a: string, b: string): boolean {
  return a.trim().normalize("NFC") === b.trim().normalize("NFC");
}

/** A corrected post must still be a post: not empty, within BREAKING_POST_MAX (never 280); 422 post_invalid otherwise */
function assertPostValid(text: string): void {
  const check = checkXPost(text, BREAKING_POST_MAX);
  if (!check.ok) throw new DeskError("post_invalid", check.problems[0]!, { problems: check.problems });
}

/**
 * Every rule of a correction, checked when it starts and again on each save and on Done: Edit drafts, the poster or
 * someone allowed to act on others' posts, and a post from today (IST).
 */
function assertCorrectionRules(post: CorrectedPost, actor: Actor, rights: CorrectionRights, at: "start" | "save", now = new Date()): void {
  if (!rights.canEdit) throw new DeskError("forbidden", NOT_YOURS);
  if (post.publishedBy !== actor.id && !rights.canCorrectOthers) throw new DeskError("forbidden", NOT_YOURS);
  if (!postedTodayIst(post.publishedAt, now)) {
    throw new DeskError("too_late", at === "start" ? "Only today's posts can be edited." : "This post is from yesterday and can't be edited.");
  }
}

/**
 * Edit on Posted today: hold a posted story to correct its text or card. Only a Copy & Posted story, only on the
 * day it was posted (IST), only by the person who posted it or someone who may act on others' posts. The hold is
 * claimDraft's lease capped at the next 00:00 IST; the status stays published and updated_at is left alone, so
 * the story keeps its place and day in the posted view. Announced as draft.updated (never draft.claimed).
 */
export async function startCorrection(db: Db, actor: Actor, draftId: string, rights: CorrectionRights, now = new Date()): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    const post = draft.status === "published" ? await copiedPost(tx, actor.orgId, draftId) : null;
    if (!post) throw new DeskError("invalid_state", NOT_COPY_POSTED, { status: draft.status });
    assertCorrectionRules(post, actor, rights, "start", now);
    const holder = draft.claimedBy;
    if (holder !== null && holder !== actor.id && holdsLease(draft, { ...actor, id: holder })) {
      const name = await holderName(tx, holder);
      throw new DeskError("held_by_other", `${name} is working on this.`, { heldBy: name, until: draft.claimExpiresAt });
    }
    const [held] = await tx.update(postDrafts).set({ claimedBy: actor.id, claimExpiresAt: correctionLeaseUntil() }).where(eq(postDrafts.id, draftId)).returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.correction_started", entityType: "post_draft", entityId: draftId, after: { postId: post.id, postedBy: post.publishedBy, until: held!.claimExpiresAt } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: held!.status, version: held!.version });
    return held!;
  });
}

/**
 * Done correcting a posted story: the caller's own hold always ends, whatever else is true now — rights taken away
 * mid-session, the post moved to yesterday, a text that would not pass. Saving is where the rules are enforced (a
 * save that fails them is refused); Done only lets go. The audit row records whether the rules still held. The
 * story stays published. A no-op when the caller does not hold it (also the keepalive Done of a closed tab).
 * Announced as draft.released, like any hold's end: Done writes nothing to the post (the fix was saved, and
 * announced as draft.updated, by updateDraft / setCustomCard / clearCustomCard).
 */
export async function endCorrection(db: Db, actor: Actor, draftId: string, rights: CorrectionRights): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    if (draft.status !== "published") throw new DeskError("invalid_state", `This draft is ${draft.status}, not posted.`, { status: draft.status });
    if (draft.claimedBy !== actor.id) return draft;
    const post = await copiedPost(tx, actor.orgId, draftId);
    // Only the audit depends on the rules: why the hold ended without them, if it did
    let refused: string | null = null;
    try {
      if (!post) throw new DeskError("invalid_state", NOT_COPY_POSTED);
      assertCorrectionRules(post, actor, rights, "save");
      assertPostValid(postText(draft));
    } catch (e) {
      if (!(e instanceof DeskError)) throw e;
      refused = e.code;
    }
    const [freed] = await tx.update(postDrafts).set({ claimedBy: null, claimExpiresAt: null }).where(eq(postDrafts.id, draftId)).returning();
    await audit(tx, {
      orgId: actor.orgId, actorId: actor.id, action: "draft.correction_ended", entityType: "post_draft", entityId: draftId,
      before: { until: draft.claimExpiresAt },
      after: { postId: post?.id ?? null, correctedAt: post?.correctedAt ?? null, correctedBy: post?.correctedBy ?? null, rulesFailed: refused },
    });
    await notify(tx, actor.orgId, { type: "draft.released", draftId });
    return freed!;
  });
}

/** A post's poster and its last correction, as the desk shows them; corrected is null for a post never corrected */
export function correctionView(row: { postedAt: Date; postedById: string | null; postedByName: string | null; correctedAt: Date | null; correctedById: string | null; correctedByName: string | null }) {
  const person = (id: string | null, name: string | null) => (id ? { id, name: name ?? "Someone" } : null);
  return {
    postedAt: row.postedAt,
    postedBy: person(row.postedById, row.postedByName),
    correctedAt: row.correctedAt,
    correctedBy: row.correctedAt ? person(row.correctedById, row.correctedByName) : null,
  };
}

/** The live Copy & Posted record of a published draft, with its correction; null for any other draft */
export async function correctionInfo(db: Executor, orgId: string, draftId: string) {
  const [row] = await db
    .select({
      postedAt: publishedPosts.publishedAt,
      postedById: publishedPosts.publishedBy,
      postedByName: sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${publishedPosts.publishedBy})`,
      correctedAt: publishedPosts.correctedAt,
      correctedById: publishedPosts.correctedBy,
      correctedByName: sql<string | null>`(SELECT u.name FROM users u WHERE u.id = ${publishedPosts.correctedBy})`,
    })
    .from(publishedPosts)
    .where(and(eq(publishedPosts.orgId, orgId), eq(publishedPosts.draftId, draftId), eq(publishedPosts.manual, true), isNull(publishedPosts.permalink), isNull(publishedPosts.recalledAt)))
    .orderBy(sql`${publishedPosts.publishedAt} DESC`)
    .limit(1);
  return row ? correctionView(row) : null;
}

/**
 * Take back a Copy & Posted within COPY_UNDO_SECONDS: the record goes and the draft returns to the queue.
 * Only the person who marked it, or someone allowed to undo posts (`canUndoOthers`).
 */
export async function undoCopyPosted(db: Db, actor: Actor, draftId: string, canUndoOthers: boolean): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    const post = draft.status === "published" ? await copiedPost(tx, actor.orgId, draftId) : null;
    if (!post) throw new DeskError("invalid_state", "This draft was not marked posted with Copy & Posted.", { status: draft.status });
    if (post.publishedBy !== actor.id && !canUndoOthers) throw new DeskError("forbidden", "Only the person who marked it posted can take it back.");
    const fixer = draft.claimedBy;
    if (fixer !== null && fixer !== actor.id && holdsLease(draft, { ...actor, id: fixer })) {
      const name = await holderName(tx, fixer);
      throw new DeskError("held_by_other", `${name} is fixing this post. Undo after they finish.`, { heldBy: name, until: draft.claimExpiresAt });
    }
    if (Date.now() - post.publishedAt.getTime() > COPY_UNDO_SECONDS * 1000) {
      throw new DeskError("too_late", `"Posted" can be taken back for ${COPY_UNDO_SECONDS / 60} minutes. Delete the post on X by hand if it is wrong.`);
    }
    const status = move(draft, "undo_copy_posted");
    await tx.delete(publishedPosts).where(eq(publishedPosts.id, post.id));
    const [updated] = await tx
      .update(postDrafts)
      // A correction hold on the posted story ends with it: the draft goes back to the queue free
      .set({ status, claimedBy: null, claimExpiresAt: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, draftId))
      .returning();
    // The decision log (never throws); a breaking draft (it has a handle_pick) that could not be logged is warned about
    noteOutcome(await voidOutcome(tx, { orgId: actor.orgId, draftId, voidedBy: actor.id }), { orgId: actor.orgId, draftId: draftId, op: "void", expectRow: draft.handlePick !== null });
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.copy_posted_undo", entityType: "post_draft", entityId: draftId, before: { status: draft.status, postId: post.id, postedBy: post.publishedBy }, after: { status } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status, version: updated!.version });
    return updated!;
  });
}

/** When a Copy & Posted was made and by whom, with its undo deadline; null for any other draft */
export async function copiedPostInfo(db: Executor, orgId: string, draftId: string) {
  const [row] = await db
    .select({ id: publishedPosts.id, at: publishedPosts.publishedAt, byId: publishedPosts.publishedBy, byName: users.name })
    .from(publishedPosts)
    .leftJoin(users, eq(users.id, publishedPosts.publishedBy))
    .where(and(eq(publishedPosts.orgId, orgId), eq(publishedPosts.draftId, draftId), isNull(publishedPosts.recalledAt)))
    .orderBy(sql`${publishedPosts.publishedAt} DESC`)
    .limit(1);
  return row ? postedView(row) : null;
}

export function postedView(row: { at: Date; byId: string | null; byName: string | null }) {
  return { at: row.at, by: row.byId ? { id: row.byId, name: row.byName ?? "Someone" } : null, undoUntil: new Date(row.at.getTime() + COPY_UNDO_SECONDS * 1000) };
}

/**
 * "Add card": ask the render worker for a card (phase 1 drafts start with none). Already rendering or
 * rendered: nothing to do. After a failure it starts again from zero attempts.
 */
export async function requestCardRender(db: Db, actor: Actor, draftId: string): Promise<Draft> {
  return db.transaction(async (tx) => {
    const draft = await lockDraft(tx, actor, draftId);
    if (!["ready", "claimed", "rendering", "render_failed"].includes(draft.status)) {
      throw new DeskError("invalid_state", `A ${draft.status} draft cannot get a new card.`, { status: draft.status });
    }
    const state = cardState(draft);
    if (state === "ready" || state === "rendering") return draft;
    // After a failed render the worker waits before trying again (render lease); a click inside that wait is refused
    const wait = draft.renderLeaseUntil ? Math.ceil((draft.renderLeaseUntil.getTime() - Date.now()) / 1000) : 0;
    if (state === "failed" && wait > 0) {
      throw new DeskError("cooldown", `The card could not be drawn just now. Try again in ${wait} seconds.`, { retryAfter: wait, renderError: draft.renderError });
    }
    // Attempts are kept, so a card that keeps failing still ends in render_failed instead of looping
    const [updated] = await tx
      .update(postDrafts)
      .set({
        cardRev: sql`${postDrafts.cardRenderedRev} + 1`, renderError: null, renderLeaseUntil: null,
        // A draft parked in render_failed waits for its card again
        ...(draft.status === "render_failed" && { status: "rendering" }),
        version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()`,
      })
      .where(eq(postDrafts.id, draftId))
      .returning();
    await audit(tx, { orgId: actor.orgId, actorId: actor.id, action: "draft.card_requested", entityType: "post_draft", entityId: draftId, before: { cardRev: draft.cardRev }, after: { cardRev: updated!.cardRev } });
    await notify(tx, actor.orgId, { type: "draft.updated", draftId, status: updated!.status, version: updated!.version });
    return updated!;
  });
}

export type CardState = "none" | "rendering" | "ready" | "failed";

/** The card as the desk sees it: none (not asked for), rendering, ready, failed */
export function cardState(d: Pick<Draft, "cardRev" | "cardRenderedRev" | "cardKey" | "customCardKey" | "renderError">): CardState {
  if (d.customCardKey) return "ready";
  if (d.cardRev === 0) return "none";
  if (d.cardKey && d.cardRenderedRev === d.cardRev) return "ready";
  return d.renderError ? "failed" : "rendering";
}
