// What the digital desk receives for a draft: everything one screen needs, nothing more.

import { LOW_CONFIDENCE, X_LIMIT, checkXPost } from "@socia/core";
import { postDrafts, postText, publishJobs, stories, users, type Db } from "@socia/db";
import type { Storage } from "@socia/providers";
import { and, desc, eq, inArray } from "drizzle-orm";

type Draft = typeof postDrafts.$inferSelect;
type Story = typeof stories.$inferSelect;

export async function cardUrl(storage: Storage, key: string | null): Promise<string | null> {
  return key ? storage.url(key, 600) : null;
}

export async function draftView(db: Db, storage: Storage, draft: Draft, story: Story, viewerId: string) {
  const [holder] = draft.claimedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, draft.claimedBy)) : [];
  const [job] = await db
    .select()
    .from(publishJobs)
    .where(and(eq(publishJobs.draftId, draft.id), inArray(publishJobs.status, ["pending", "running", "dead"])))
    .orderBy(desc(publishJobs.createdAt))
    .limit(1);
  const text = postText(draft);
  const check = checkXPost(text);
  const leaseLive = !!draft.claimExpiresAt && draft.claimExpiresAt > new Date();

  return {
    id: draft.id,
    platform: draft.platform,
    status: draft.status,
    version: draft.version,
    bodyText: draft.bodyText,
    cardHeadline: draft.cardHeadline,
    hashtags: draft.hashtags,
    mentions: draft.mentions,
    mentionSuggestions: draft.mentionSuggestions,
    postText: text,
    check: { length: check.length, limit: X_LIMIT, problems: check.problems },
    card: {
      url: await cardUrl(storage, draft.cardKey),
      ready: draft.cardRenderedRev === draft.cardRev && !!draft.cardKey,
      fontPx: draft.cardFontPx,
      error: draft.renderError,
    },
    claim:
      draft.claimedBy && draft.status === "claimed" && leaseLive
        ? { userId: draft.claimedBy, name: holder?.name ?? "Someone", until: draft.claimExpiresAt, mine: draft.claimedBy === viewerId }
        : null,
    reject: draft.rejectReason ? { reason: draft.rejectReason, note: draft.rejectNote } : null,
    job: job ? { id: job.id, kind: job.kind, status: job.status, sendAt: job.nextAttemptAt, attempts: job.attempts, error: job.lastError } : null,
    composeMethod: draft.composeMethod,
    composeVersion: draft.composeVersion,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    story: {
      id: story.id,
      slug: story.slug,
      headline: story.headline,
      body: story.body,
      receivedAt: story.createdAt,
      mediaState: story.mediaState,
      conversionConfidence: story.conversionConfidence,
      lowConfidence: story.conversionConfidence !== null && story.conversionConfidence < LOW_CONFIDENCE,
      sourceEncoding: story.sourceEncoding,
      /** The file as the machine read it; shown beside a low-confidence conversion */
      sourceText: story.sourceText,
      parseMethod: story.parseMethod,
      parseNote: story.parseNote,
    },
  };
}
