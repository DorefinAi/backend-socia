import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import {
  DeskError, approveDraft, capUsage, claimDraft, extendClaim, rejectDraft, releaseDraft, releaseExpiredClaims,
  requestRecall, restoreDraft, undoPost, updateDraft,
} from "../src/desk";
import { EVENTS_CHANNEL } from "../src/events";
import { claimPublishJobs, completeDelete, completePost, failAttempt, recordPlatformPost, reviveExpiredJobs } from "../src/queue";
import { auditLog, postDrafts, publishJobs, publishedPosts } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";

const run = TEST_URL ? describe : describe.skip;

async function expectDeskError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DeskError && e.code === code);
}

run("desk operations against Postgres", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  const makeDue = (jobId: string) => h.db.update(publishJobs).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(publishJobs.id, jobId));

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
  });
  afterAll(async () => h?.close());

  it("lets only one operator hold a draft, and names the holder", async () => {
    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    const err = await claimDraft(h.db, s.amit, d.id).catch((e) => e);
    expect(err).toBeInstanceOf(DeskError);
    expect(err.code).toBe("held_by_other");
    expect(err.message).toBe("Priya is working on this.");
    // the holder can re-open it, and extend it
    await claimDraft(h.db, s.priya, d.id);
    await extendClaim(h.db, s.priya, d.id);
  });

  it("gives an expired lease to the next operator", async () => {
    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, d.id));
    const taken = await claimDraft(h.db, s.amit, d.id);
    expect(taken.claimedBy).toBe(s.amit.id);
    await expectDeskError(extendClaim(h.db, s.priya, d.id), "lease_lost");
  });

  it("returns stale leases to the queue", async () => {
    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, d.id));
    expect(await releaseExpiredClaims(h.db)).toBeGreaterThanOrEqual(1);
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    expect(row!.status).toBe("ready");
  });

  it("refuses a save made on a stale version", async () => {
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    const saved = await updateDraft(h.db, s.priya, d.id, claimed.version, { bodyText: "नया पाठ" });
    expect(saved.version).toBe(claimed.version + 1);
    const err = await updateDraft(h.db, s.priya, d.id, claimed.version, { bodyText: "पुराना" }).catch((e) => e);
    expect(err.code).toBe("stale_version");
    expect(err.data.current.bodyText).toBe("नया पाठ");
  });

  it("re-renders the card when its text changes, and holds approve until then", async () => {
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    const saved = await updateDraft(h.db, s.priya, d.id, claimed.version, { cardHeadline: "नई हेडलाइन" });
    expect(saved.cardRev).toBe(2);
    await expectDeskError(approveDraft(h.db, s.priya, d.id, saved.version), "card_not_ready");
  });

  it("accepts only suggested or verified mentions", async () => {
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    await updateDraft(h.db, s.priya, d.id, claimed.version, { mentions: ["@JDAJaipur"] });
    await expectDeskError(updateDraft(h.db, s.priya, d.id, claimed.version + 1, { mentions: ["@SomeoneRandom"] }), "bad_mention");
  });

  it("refuses a post with a link", async () => {
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    const saved = await updateDraft(h.db, s.priya, d.id, claimed.version, { bodyText: "पूरी खबर www.example.com पर" });
    const err = await approveDraft(h.db, s.priya, d.id, saved.version).catch((e) => e);
    expect(err.code).toBe("post_invalid");
    expect(err.message).toContain("13 times");
  });

  it("runs the whole path: approve, undo, approve, publish, recall", async () => {
    const d = await s.draft();
    let draft = await claimDraft(h.db, s.priya, d.id);

    // approve writes a job that waits 10 s
    const first = await approveDraft(h.db, s.priya, d.id, draft.version);
    expect(first.draft.status).toBe("queued");
    const wait = first.job.nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(7000);
    expect(await claimPublishJobs(h.db)).toEqual([]);

    // undo inside the window: nothing sent, the draft is back with Priya
    draft = await undoPost(h.db, s.priya, first.job.id);
    expect(draft.status).toBe("claimed");
    expect(draft.claimedBy).toBe(s.priya.id);

    // approve again, let the window pass, a worker takes it
    const second = await approveDraft(h.db, s.priya, d.id, draft.version);
    await makeDue(second.job.id);
    const [job] = await claimPublishJobs(h.db);
    expect(job!.id).toBe(second.job.id);
    expect(job!.attempts).toBe(1);
    await expectDeskError(undoPost(h.db, s.priya, second.job.id), "too_late");

    // the id is recorded first, then success
    await recordPlatformPost(h.db, job!.id, "1850000000000000001", null);
    await completePost(h.db, job!, { platformPostId: "1850000000000000001", permalink: "https://x.com/i/status/1850000000000000001", text: "t" });
    const [published] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    expect(published!.status).toBe("published");
    const [post] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, d.id));
    expect(post!.permalink).toContain("1850000000000000001");

    // recall: a delete job, then the post is marked recalled
    const del = await requestRecall(h.db, s.priya, post!.id, "wrong district");
    expect(await requestRecall(h.db, s.priya, post!.id, "again")).toMatchObject({ id: del.id });
    const [delJob] = await claimPublishJobs(h.db);
    await completeDelete(h.db, delJob!);
    const [recalled] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.id, post!.id));
    expect(recalled!.recallReason).toBe("wrong district");

    const trail = await h.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, d.id));
    expect(trail.map((t) => t.action)).toContain("draft.approve");
  });

  it("counts the daily cap, including posts waiting to send", async () => {
    const used = await capUsage(h.db, s.org.id);
    expect(used.cap).toBe(2);
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    await approveDraft(h.db, s.priya, d.id, claimed.version); // 1 published today + 1 waiting = 2 = cap
    const d2 = await s.draft();
    const c2 = await claimDraft(h.db, s.priya, d2.id);
    await expectDeskError(approveDraft(h.db, s.priya, d2.id, c2.version), "cap_full");
  });

  it("retries a failing post, then marks it failed", async () => {
    await h.db.update(publishJobs).set({ status: "cancelled" }).where(eq(publishJobs.status, "pending"));
    await h.db.execute(sql`UPDATE orgs SET settings = jsonb_set(settings, '{dailyCaps,x}', '100')`);
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, claimed.version);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await makeDue(job.id);
      const [claimedJob] = await claimPublishJobs(h.db);
      expect(claimedJob!.attempts).toBe(attempt);
      await failAttempt(h.db, claimedJob!, "X returned 503");
    }
    const [row] = await h.db.select().from(publishJobs).where(eq(publishJobs.id, job.id));
    expect(row!.status).toBe("dead");
    const [draft] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    expect(draft!.status).toBe("failed");
  });

  it("does not spend an attempt on a rate limit", async () => {
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, claimed.version);
    await makeDue(job.id);
    const [taken] = await claimPublishJobs(h.db);
    await failAttempt(h.db, taken!, "429", { rateLimited: true, retryAt: new Date(Date.now() + 60_000) });
    const [row] = await h.db.select().from(publishJobs).where(eq(publishJobs.id, job.id));
    expect(row!.attempts).toBe(0);
    expect(row!.status).toBe("pending");
  });

  it("puts a job whose worker died back in the queue", async () => {
    const d = await s.draft();
    const claimed = await claimDraft(h.db, s.priya, d.id);
    const { job } = await approveDraft(h.db, s.priya, d.id, claimed.version);
    await makeDue(job.id);
    await claimPublishJobs(h.db, 10, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(await reviveExpiredJobs(h.db)).toBeGreaterThanOrEqual(1);
    const [row] = await h.db.select().from(publishJobs).where(eq(publishJobs.id, job.id));
    expect(row!.status).toBe("pending");
  });

  it("rejects with a reason and restores", async () => {
    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    const rejected = await rejectDraft(h.db, s.priya, d.id, "duplicate", null);
    expect(rejected.status).toBe("rejected");
    expect(rejected.claimedBy).toBeNull();
    expect((await restoreDraft(h.db, s.amit, d.id)).status).toBe("ready");
  });

  it("releases a draft the operator leaves", async () => {
    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    await releaseDraft(h.db, s.priya, d.id);
    expect((await claimDraft(h.db, s.amit, d.id)).claimedBy).toBe(s.amit.id);
  });

  it("sends events only when the change commits", async () => {
    const client = new pg.Client({ connectionString: TEST_URL });
    await client.connect();
    const got: { type: string }[] = [];
    client.on("notification", (n) => got.push(JSON.parse(n.payload!)));
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);

    const d = await s.draft();
    await claimDraft(h.db, s.priya, d.id);
    await claimDraft(h.db, s.amit, d.id).catch(() => undefined); // fails: no event
    await new Promise((r) => setTimeout(r, 100));
    await client.end();
    expect(got.filter((e) => e.type === "draft.claimed")).toHaveLength(1);
  });
});
