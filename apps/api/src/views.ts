// What the digital desk receives for a draft: everything one screen needs, nothing more.

import { LOW_CONFIDENCE, X_LIMIT, checkXPost } from "@socia/core";
import {
  asCategory, asPriority, assets, ingestedFiles, postDrafts, postText, postedCardKey, publishJobs, stories, users, type Db, type StoryExternal, type StoryPriority,
} from "@socia/db";
import type { Storage } from "@socia/providers";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

type Draft = typeof postDrafts.$inferSelect;
type Story = typeof stories.$inferSelect;

/** Samvadia's priority and category for colouring the desk; shared-folder stories and older rows are normal / null. */
export function storyLabels(external: StoryExternal | null | undefined): { priority: StoryPriority; category: string | null } {
  return { priority: asPriority(external?.priority), category: asCategory(external?.category) };
}

export async function cardUrl(storage: Storage, key: string | null): Promise<string | null> {
  return key ? storage.url(key, 600) : null;
}

/** A story's photos and videos: copied ones get a short-lived URL; recorded-only ones say why not. */
export async function storyMedia(db: Db, storage: Storage, storyId: string) {
  const rows = await db
    .select({ a: assets, fileName: ingestedFiles.fileName, fileBytes: ingestedFiles.bytes })
    .from(assets)
    .leftJoin(ingestedFiles, eq(ingestedFiles.id, assets.fileId))
    .where(eq(assets.storyId, storyId))
    // Photos first, then by name
    .orderBy(sql`CASE WHEN ${assets.kind} = 'image' THEN 0 ELSE 1 END`, asc(assets.seq), asc(assets.fileName), asc(assets.createdAt));
  return Promise.all(
    rows.map(async ({ a, fileName, fileBytes }) => ({
      id: a.id,
      kind: a.kind,
      fileName: a.fileName ?? fileName ?? null,
      bytes: a.bytes ?? fileBytes ?? null,
      url: a.storageKey ? await storage.url(a.storageKey, 600) : null,
      copied: !!a.storageKey,
      skipReason: a.skipReason,
      sourcePath: a.sourcePath,
      attachedBy: a.attachedBy,
      createdAt: a.createdAt,
    })),
  );
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
      /** The card that will be posted: the operator's own when set, else the rendered one */
      url: await cardUrl(storage, postedCardKey(draft)),
      /** A custom card is ready as it is; the rendered one is ready once it caught up with the last edit */
      ready: !!draft.customCardKey || (draft.cardRenderedRev === draft.cardRev && !!draft.cardKey),
      fontPx: draft.cardFontPx,
      error: draft.renderError,
      custom: !!draft.customCardKey,
      /** The rendered card, kept so the editor can start from it or go back to it */
      autoUrl: await cardUrl(storage, draft.cardKey),
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
      source: story.source,
      district: story.district,
      ...storyLabels(story.external),
      external: story.external ?? null,
    },
    media: await storyMedia(db, storage, story.id),
  };
}
