// Publish: take due jobs from the outbox and send them. Order per job (backend doc §5):
// token → card from storage → media upload → create post → record the id → verify → success.
// The id is recorded before success, so a worker that dies after posting never posts twice: the
// job comes back with the id (just verify and finish) or without it (look for the post first).

import { checkXPost } from "@socia/core";
import { claimPublishJobs, completeDelete, completePost, failAttempt, postDrafts, postText, recordPlatformPost, releaseJobs, type Db, type PublishJob } from "@socia/db";
import { XApiError, XRateLimited, type Storage, type XClient } from "@socia/providers";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { RateBucket } from "../bucket";

/** X appends a t.co link for attached media; compare texts without it. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s*https:\/\/t\.co\/\S+/g, "").normalize("NFC").replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

export interface PublisherDeps {
  db: Db;
  storage: Storage;
  x: XClient;
  bucket: RateBucket;
  account: string;
  log: Logger;
  /** False once shutdown starts: claimed but unstarted jobs are handed back */
  active: () => boolean;
}

export class Publisher {
  constructor(private readonly deps: PublisherDeps) {}

  async tick(): Promise<boolean> {
    const jobs = await claimPublishJobs(this.deps.db, 5);
    if (!jobs.length) return false;
    for (const [i, job] of jobs.entries()) {
      if (!this.deps.active()) {
        await releaseJobs(this.deps.db, jobs.slice(i).map((j) => j.id));
        break;
      }
      await this.run(job);
    }
    return true;
  }

  async run(job: PublishJob): Promise<void> {
    const { log } = this.deps;
    try {
      if (job.kind === "delete") await this.recall(job);
      else await this.post(job);
    } catch (err) {
      await this.fail(job, err);
      log.warn({ err, jobId: job.id, attempt: job.attempts }, "publish attempt failed");
    }
  }

  private async post(job: PublishJob): Promise<void> {
    const { db, storage, x, bucket, account, log } = this.deps;
    const [draft] = await db.select().from(postDrafts).where(eq(postDrafts.id, job.draftId));
    if (!draft) throw new Error(`Draft ${job.draftId} is gone`);
    const text = postText(draft);

    // The API checked this at approve; check again, the text is what actually goes out
    const check = checkXPost(text);
    if (!check.ok) {
      await failAttempt(db, job, check.problems.join(" "), { final: true });
      return;
    }

    let postId = job.platformPostId;
    if (!postId && job.attempts > 1) {
      const recent = await x.recentPosts(new Date(job.createdAt.getTime() - 60_000));
      postId = recent.find((p) => sameText(p.text, text))?.id ?? null;
      if (postId) {
        log.warn({ jobId: job.id, postId }, "found the post from an earlier attempt; not posting again");
        await recordPlatformPost(db, job.id, postId, x.permalink(postId));
      }
    }

    if (!postId) {
      const take = await bucket.take(`x:${account}`);
      if (!take.ok) {
        await failAttempt(db, job, "Waiting for the X rate window", { rateLimited: true, retryAt: take.retryAt });
        return;
      }
      if (!draft.cardKey) throw new Error("The draft has no card");
      const mediaId = await x.uploadImage(await storage.get(draft.cardKey));
      postId = (await x.createPost(text, [mediaId])).id;
      await recordPlatformPost(db, job.id, postId, x.permalink(postId));
    }

    const live = await x.getPost(postId).catch(() => null);
    if (!live) log.warn({ jobId: job.id, postId }, "posted, but X did not return the post on verify");
    await completePost(db, job, { platformPostId: postId, permalink: x.permalink(postId), text });
    log.info({ jobId: job.id, draftId: job.draftId, postId, mode: x.mode }, "posted");
  }

  private async recall(job: PublishJob): Promise<void> {
    await this.deps.x.deletePost(job.platformPostId!);
    await completeDelete(this.deps.db, job);
    this.deps.log.info({ jobId: job.id, postId: job.platformPostId }, "post recalled");
  }

  private async fail(job: PublishJob, err: unknown): Promise<void> {
    const { db } = this.deps;
    const message = String((err as Error)?.message ?? err).slice(0, 500);
    if (err instanceof XRateLimited) {
      await failAttempt(db, job, message, { rateLimited: true, retryAt: err.resetAt });
    } else if (err instanceof XApiError && !err.retryable) {
      // A 4xx other than 429 (bad auth, duplicate text, forbidden): retrying will not help
      await failAttempt(db, job, message, { final: true });
    } else {
      await failAttempt(db, job, message);
    }
  }
}
