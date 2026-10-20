// Regression tests for the gaps found in the 20 Oct 2026 review, all fixed since. Each note says what
// used to go wrong; a failure here is a bug in src/, not in the test. Needs TEST_DATABASE_URL (the database is wiped).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { DeskError, approveDraft, claimDraft, retryFailed } from "../src/desk";
import { claimPublishJobs, failAttempt } from "../src/queue";
import { orgs, publishJobs } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";

const run = TEST_URL ? describe : describe.skip;

run("known gaps: desk", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h); // dailyCaps.x = 2
  });
  afterAll(async () => h?.close());

  // Was: approveDraft checks the daily cap, retryFailed does not. A failed post retried after the
  // cap is used up goes out anyway, past the limit the desk set.
  it("does not let a retry go past the daily cap", async () => {
    await h.db.update(orgs).set({ settings: sql`jsonb_set(${orgs.settings}, '{dailyCaps,x}', '1')` }).where(eq(orgs.id, s.org.id));
    const failed = await s.draft();
    const c = await claimDraft(h.db, s.priya, failed.id);
    const { job } = await approveDraft(h.db, s.priya, failed.id, c.version);
    await h.db.update(publishJobs).set({ nextAttemptAt: sql`now()` }).where(eq(publishJobs.id, job.id));
    const [claimed] = await claimPublishJobs(h.db);
    await failAttempt(h.db, claimed!, "X said 403", { final: true });

    // the one post allowed today goes to another draft
    const other = await s.draft();
    const c2 = await claimDraft(h.db, s.amit, other.id);
    await approveDraft(h.db, s.amit, other.id, c2.version);

    const err = await retryFailed(h.db, s.priya, failed.id).catch((e) => e);
    expect(err).toBeInstanceOf(DeskError);
    expect((err as DeskError).code).toBe("cap_full");
  });
});
