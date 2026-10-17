// The publish outbox, from the worker's side. Claims use FOR UPDATE SKIP LOCKED so workers never
// queue behind each other; a lease that runs out puts the job back, and the platform post id is
// recorded before success so a crash between posting and recording never posts twice.

import { MAX_PUBLISH_ATTEMPTS, backoffSeconds } from "@socia/core";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Db } from "./client";
import { capUsage } from "./desk";
import { notify } from "./events";
import { postDrafts, publishJobs, publishedPosts } from "./schema";

export type PublishJob = typeof publishJobs.$inferSelect;

export async function claimPublishJobs(db: Db, limit = 10, leaseSeconds = 120): Promise<PublishJob[]> {
  return db.transaction(async (tx) => {
    const due = tx
      .select({ id: publishJobs.id })
      .from(publishJobs)
      .where(and(eq(publishJobs.status, "pending"), lte(publishJobs.nextAttemptAt, sql`now()`)))
      .orderBy(asc(publishJobs.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    const jobs = await tx
      .update(publishJobs)
      .set({
        status: "running",
        claimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
        attempts: sql`${publishJobs.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(inArray(publishJobs.id, due))
      .returning();

    const postDraftIds = jobs.filter((j) => j.kind === "post").map((j) => j.draftId);
    if (postDraftIds.length) {
      await tx
        .update(postDrafts)
        .set({ status: "publishing", updatedAt: sql`now()` })
        .where(and(inArray(postDrafts.id, postDraftIds), eq(postDrafts.status, "queued")));
    }
    return jobs;
  });
}

/** Write the platform's id the moment it comes back, before anything else can fail. */
export async function recordPlatformPost(db: Db, jobId: string, platformPostId: string, permalink: string | null): Promise<void> {
  await db.update(publishJobs).set({ platformPostId, permalink, updatedAt: sql`now()` }).where(eq(publishJobs.id, jobId));
}

export async function completePost(db: Db, job: PublishJob, result: { platformPostId: string; permalink: string; text: string }) {
  await db.transaction(async (tx) => {
    await tx
      .update(publishJobs)
      .set({ status: "succeeded", platformPostId: result.platformPostId, permalink: result.permalink, lastError: null, updatedAt: sql`now()` })
      .where(eq(publishJobs.id, job.id));
    const [draft] = await tx
      .update(postDrafts)
      .set({ status: "published", claimedBy: null, claimExpiresAt: null, version: sql`${postDrafts.version} + 1`, updatedAt: sql`now()` })
      .where(eq(postDrafts.id, job.draftId))
      .returning();
    const [post] = await tx
      .insert(publishedPosts)
      .values({ orgId: job.orgId, draftId: job.draftId, platform: draft!.platform, platformPostId: result.platformPostId, permalink: result.permalink, text: result.text, publishedBy: job.createdBy })
      .onConflictDoNothing()
      .returning();
    await audit(tx, { orgId: job.orgId, actorId: job.createdBy, action: "post.published", entityType: "publish_job", entityId: job.id, after: { ...result, attempts: job.attempts } });
    await notify(tx, job.orgId, { type: "post.sent", draftId: job.draftId, postId: post?.id ?? "", permalink: result.permalink });
    const cap = await capUsage(tx, job.orgId, draft!.platform);
    await notify(tx, job.orgId, { type: "cap.changed", platform: draft!.platform, used: cap.used, cap: cap.cap });
  });
}

/**
 * A failed attempt. Retries with backoff (or at the platform's reset time on a 429) until
 * MAX_PUBLISH_ATTEMPTS, then the job is dead and shows in the UI with a Retry button.
 * A rate limit is backpressure, not a failure, so it does not use up an attempt.
 * `final` is for errors a retry cannot fix (a 4xx other than 429).
 */
export async function failAttempt(db: Db, job: PublishJob, error: string, opts: { retryAt?: Date; rateLimited?: boolean; final?: boolean } = {}) {
  await db.transaction(async (tx) => {
    const attempts = opts.rateLimited ? job.attempts - 1 : job.attempts;
    const final = opts.final === true || (!opts.rateLimited && attempts >= MAX_PUBLISH_ATTEMPTS);
    const nextAttemptAt = opts.retryAt ?? new Date(Date.now() + backoffSeconds(attempts) * 1000);

    await tx
      .update(publishJobs)
      .set({ status: final ? "dead" : "pending", attempts, nextAttemptAt, leaseExpiresAt: null, lastError: error, updatedAt: sql`now()` })
      .where(eq(publishJobs.id, job.id));

    if (job.kind === "post") {
      await tx
        .update(postDrafts)
        .set({ status: final ? "failed" : "queued", updatedAt: sql`now()` })
        .where(eq(postDrafts.id, job.draftId));
    }
    await audit(tx, { orgId: job.orgId, actorId: null, action: final ? "post.dead" : "post.attempt_failed", entityType: "publish_job", entityId: job.id, after: { error, attempts, nextAttemptAt } });
    await notify(tx, job.orgId, { type: "post.failed", draftId: job.draftId, jobId: job.id, error, final });
  });
}

export async function completeDelete(db: Db, job: PublishJob) {
  await db.transaction(async (tx) => {
    await tx.update(publishJobs).set({ status: "succeeded", updatedAt: sql`now()` }).where(eq(publishJobs.id, job.id));
    const [post] = await tx
      .update(publishedPosts)
      .set({ recalledAt: sql`now()`, recalledBy: job.createdBy, recallReason: job.reason })
      .where(and(eq(publishedPosts.draftId, job.draftId), eq(publishedPosts.platformPostId, job.platformPostId!)))
      .returning();
    await tx.update(postDrafts).set({ status: "recalled", updatedAt: sql`now()` }).where(eq(postDrafts.id, job.draftId));
    await audit(tx, { orgId: job.orgId, actorId: job.createdBy, action: "post.recalled", entityType: "published_post", entityId: post?.id ?? job.draftId, after: { reason: job.reason, platformPostId: job.platformPostId } });
    await notify(tx, job.orgId, { type: "post.recalled", draftId: job.draftId, postId: post?.id ?? "" });
  });
}

/** Jobs whose worker died mid-flight. They go back to pending; the worker reconciles before reposting. */
export async function reviveExpiredJobs(db: Db): Promise<number> {
  const rows = await db
    .update(publishJobs)
    .set({ status: "pending", leaseExpiresAt: null, nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(publishJobs.status, "running"), sql`${publishJobs.leaseExpiresAt} < now()`))
    .returning({ id: publishJobs.id });
  return rows.length;
}

/** On a clean shutdown, hand back what this worker was holding. */
export async function releaseJobs(db: Db, jobIds: string[]): Promise<void> {
  if (!jobIds.length) return;
  await db
    .update(publishJobs)
    .set({ status: "pending", leaseExpiresAt: null, attempts: sql`${publishJobs.attempts} - 1`, updatedAt: sql`now()` })
    .where(and(inArray(publishJobs.id, jobIds), eq(publishJobs.status, "running")));
}
