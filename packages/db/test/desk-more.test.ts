// More desk operations against Postgres: org isolation, leases, retries and recall edge cases.
// Needs TEST_DATABASE_URL (the database is wiped).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import {
  DeskError, approveDraft, claimDraft, extendClaim, rejectDraft, releaseDraft, requestRecall, restoreDraft,
  retryFailed, undoPost, updateDraft, type Actor,
} from "../src/desk";
import { claimPublishJobs, completeDelete, completePost, failAttempt, releaseJobs } from "../src/queue";
import { auditLog, orgs, postDrafts, publishJobs, publishedPosts, users } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";

const run = TEST_URL ? describe : describe.skip;

async function expectDeskError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DeskError && e.code === code);
}

run("desk operations: more edge cases", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  let outsider: Actor;
  const makeDue = (jobId: string) => h.db.update(publishJobs).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(publishJobs.id, jobId));

  /** A draft that went out: claimed, approved, published. Returns the published post. */
  async function published() {
    const d = await s.draft();
    const c = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, c.version);
    await makeDue(job.id);
    const [claimed] = await claimPublishJobs(h.db);
    await completePost(h.db, claimed!, { platformPostId: `x-${d.id}`, permalink: "https://x.com/a/status/1", text: "t" });
    const [post] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, d.id));
    return { draft: d, post: post! };
  }

  /** Clear the queue so each test claims only its own jobs. */
  const clearJobs = () => h.db.update(publishJobs).set({ status: "cancelled" }).where(sql`${publishJobs.status} IN ('pending', 'running')`);

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
    const [other] = await h.db
      .insert(orgs)
      .values({ name: "Other", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    const [u] = await h.db.insert(users).values({ orgId: other!.id, name: "Eve", email: "eve@test", passwordHash: "x", role: "admin" }).returning();
    outsider = { id: u!.id, orgId: other!.id, name: "Eve", role: "admin" };
  });
  afterAll(async () => h?.close());

  it("never lets another org see or touch a draft", async () => {
    const d = await s.draft();
    await expectDeskError(claimDraft(h.db, outsider, d.id), "not_found");
    await expectDeskError(updateDraft(h.db, outsider, d.id, d.version, { bodyText: "x" }), "not_found");
    await expectDeskError(rejectDraft(h.db, outsider, d.id, "other", null), "not_found");
    const { post } = await published();
    await expectDeskError(requestRecall(h.db, outsider, post.id, "wrong org"), "not_found");
  });

  it("needs a live lease to edit, approve or reject", async () => {
    const d = await s.draft();
    await expectDeskError(updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "x" }), "lease_lost");
    const c = await claimDraft(h.db, s.priya, d.id);
    await expectDeskError(approveDraft(h.db, s.amit, d.id, c.version), "lease_lost");
    await expectDeskError(rejectDraft(h.db, s.amit, d.id, "other", null), "lease_lost");
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, d.id));
    await expectDeskError(approveDraft(h.db, s.priya, d.id, c.version), "lease_lost");
  });

  it("does not let a non-holder extend or release a lease", async () => {
    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    await expectDeskError(extendClaim(h.db, s.amit, d.id), "lease_lost");
    await releaseDraft(h.db, s.amit, d.id); // a no-op, not an error
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    expect(row!.claimedBy).toBe(s.priya.id);
  });

  it("refuses to claim a draft that is not in the queue", async () => {
    const d = await s.draft(undefined, false); // still rendering
    await expectDeskError(claimDraft(h.db, s.priya, d.id), "invalid_state");
  });

  it("keeps the card stale until it is re-rendered when only hashtags change", async () => {
    const d = await s.draft();
    const c = await claimDraft(h.db, s.priya, d.id);
    const saved = await updateDraft(h.db, s.priya, d.id, c.version, { hashtags: ["#Jaipur", "#Rajasthan"] });
    expect(saved.cardRev).toBe(c.cardRev); // hashtags are not on the card
    const { job } = await approveDraft(h.db, s.priya, d.id, saved.version);
    expect(job.kind).toBe("post");
  });

  it("does not undo another operator's job after it was claimed by a worker", async () => {
    await clearJobs();
    const d = await s.draft();
    const c = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, c.version);
    await makeDue(job.id);
    await claimPublishJobs(h.db);
    await expectDeskError(undoPost(h.db, s.priya, job.id), "too_late");
  });

  it("lets a failed post be retried once", async () => {
    await clearJobs();
    const d = await s.draft();
    const c = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, c.version);
    await makeDue(job.id);
    const [claimed] = await claimPublishJobs(h.db);
    await failAttempt(h.db, claimed!, "X said 403", { final: true });
    const [failed] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    expect(failed!.status).toBe("failed");

    const again = await retryFailed(h.db, s.priya, d.id);
    expect(again.status).toBe("pending");
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    expect(row!.status).toBe("queued");
    await expectDeskError(retryFailed(h.db, s.priya, d.id), "invalid_state");
  });

  it("hands back unstarted jobs on shutdown without spending an attempt", async () => {
    await clearJobs();
    const d = await s.draft();
    const c = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, c.version);
    await makeDue(job.id);
    const [claimed] = await claimPublishJobs(h.db);
    expect(claimed!.attempts).toBe(1);
    await releaseJobs(h.db, [claimed!.id]);
    const [row] = await h.db.select().from(publishJobs).where(eq(publishJobs.id, job.id));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
  });

  it("asks for one recall at a time, and refuses a second recall", async () => {
    await clearJobs();
    const { post } = await published();
    const first = await requestRecall(h.db, s.priya, post.id, "wrong photo");
    const second = await requestRecall(h.db, s.priya, post.id, "wrong photo again");
    expect(second.id).toBe(first.id);
    await makeDue(first.id);
    const [job] = await claimPublishJobs(h.db);
    await completeDelete(h.db, job!);
    await expectDeskError(requestRecall(h.db, s.priya, post.id, "once more"), "invalid_state");
    const [row] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.id, post.id));
    expect(row!.recallReason).toBe("wrong photo");
  });

  it("restores only rejected drafts, and clears the reason", async () => {
    const d = await s.draft();
    await expectDeskError(restoreDraft(h.db, s.priya, d.id), "invalid_state");
    await claimDraft(h.db, s.priya, d.id);
    await rejectDraft(h.db, s.priya, d.id, "duplicate", "same as 10:02");
    const restored = await restoreDraft(h.db, s.amit, d.id);
    expect(restored.status).toBe("ready");
    expect(restored.rejectReason).toBeNull();
  });

  it("writes an audit row for every operator action", async () => {
    const d = await s.draft();
    const c = await claimDraft(h.db, s.priya, d.id);
    const saved = await updateDraft(h.db, s.priya, d.id, c.version, { bodyText: "बदला हुआ पाठ" });
    await rejectDraft(h.db, s.priya, d.id, "other", null);
    await restoreDraft(h.db, s.priya, d.id);
    const rows = await h.db.select().from(auditLog).where(eq(auditLog.entityId, d.id));
    expect(rows.map((r) => r.action).sort()).toEqual(["draft.edit", "draft.reject", "draft.restore"]);
    expect(saved.bodyText).toBe("बदला हुआ पाठ");
  });
});
