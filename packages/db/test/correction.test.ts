// Correcting a posted story (Edit on Posted today): the hold, the edits and what they must never do again.
// Needs TEST_DATABASE_URL (the database is wiped).

import { istDayStart } from "@socia/core";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { recordProposal } from "../src/decisions";
import {
  DeskError, claimDraft, clearCustomCard, clearExpiredCorrectionHolds, copyPosted, correctionInfo, endCorrection, extendClaim, markPosted, nextIstMidnight,
  postedTodayIst, releaseDraft, releaseExpiredClaims, requestRecall, setCustomCard, startCorrection, undoCopyPosted, updateDraft, type CorrectionRights,
} from "../src/desk";
import { completeDelete } from "../src/queue";
import { auditLog, hashtagStaging, postDecisions, postDrafts, publishJobs, publishedPosts } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";

const run = TEST_URL ? describe : describe.skip;

async function expectDeskError(p: Promise<unknown>, code: string, message?: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DeskError && e.code === code && (message === undefined || e.message === message));
}

/** The poster's rights (Edit drafts), and someone who may also correct others' posts */
const OWN: CorrectionRights = { canEdit: true, canCorrectOthers: false };
const ANY: CorrectionRights = { canEdit: true, canCorrectOthers: true };
const YESTERDAY_MSG = "This post is from yesterday and can't be edited.";

run("correcting a posted story", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  const store = async () => {};
  const card = { bytes: 10, width: 1080, height: 1080 };

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
  }, 60_000);
  afterAll(async () => h?.close());

  const draftRow = async (id: string) => (await h.db.select().from(postDrafts).where(eq(postDrafts.id, id)))[0]!;
  const posts = async (id: string) => h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, id));
  const postCount = async () => Number((await h.db.select({ n: count() }).from(publishedPosts))[0]!.n);
  const audits = async (id: string, action: string) =>
    h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));
  const toYesterday = (id: string) =>
    h.db.update(publishedPosts).set({ publishedAt: new Date(istDayStart(new Date()).getTime() - 60_000) }).where(eq(publishedPosts.draftId, id));

  /** A breaking draft (it has a handle_pick: staging and the decision log apply), with a proposal, posted by Priya */
  async function posted(headline: string) {
    const d = await s.draft(headline);
    await h.db.update(postDrafts).set({ handlePick: { cls: "other", why: "", warnings: [], handles: [] } }).where(eq(postDrafts.id, d.id));
    await recordProposal(h.db, { orgId: s.org.id, draftId: d.id }, {
      orgId: s.org.id, draftId: d.id, storyId: d.storyId, filenameRaw: "BTN_RJ_BREAKING_NDR_X.txt", slotRaw: null, reporterToken: null, bureauCode: null,
      bureauDistrict: null, reporterHandle: null, reporterStatus: "none", storyClass: "other", district: "Jaipur", districtFrom: "place_line",
      composeVersion: "test", draftText: d.bodyText, proposals: [], explore: false,
    });
    await copyPosted(h.db, s.priya, d.id, (await draftRow(d.id)).version);
    return draftRow(d.id);
  }

  it("the poster holds it; the status, place in the posted view and counts stay; edits land on the post record once", async () => {
    const d = await posted("जयपुर में गलत खबर");
    const total = await postCount();
    const [staged] = await h.db.select().from(hashtagStaging).where(eq(hashtagStaging.tagKey, "jaipur"));
    expect(staged).toMatchObject({ uses: 1 });
    const [decided] = await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, d.id));
    expect(decided).toMatchObject({ decision: "copy_posted" });

    const held = await startCorrection(h.db, s.priya, d.id, OWN);
    expect(held).toMatchObject({ status: "published", claimedBy: s.priya.id, version: d.version });
    expect(held.updatedAt.getTime()).toBe(d.updatedAt.getTime());
    // The hold never runs past the next 00:00 IST, on start or heartbeat
    expect(held.claimExpiresAt!.getTime()).toBeLessThanOrEqual(nextIstMidnight().getTime());
    expect((await extendClaim(h.db, s.priya, d.id)).getTime()).toBeLessThanOrEqual(nextIstMidnight().getTime());
    expect((await draftRow(d.id)).status).toBe("published");

    // A save that changes nothing writes nothing: no version, no stamp, no audit
    const same = await updateDraft(h.db, s.priya, d.id, d.version, { bodyText: `  ${d.bodyText}  `, hashtags: d.hashtags }, { correction: OWN });
    expect(same.version).toBe(d.version);
    expect((await posts(d.id))[0]!.correctedAt).toBeNull();

    // Text, hashtags and mentions corrected
    const edited = await updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "जयपुर में सही खबर", hashtags: ["#Jaipur", "#Metro"], mentions: ["@JDAJaipur"] }, { correction: OWN });
    expect(edited).toMatchObject({ status: "published", version: d.version + 1, bodyText: "जयपुर में सही खबर" });
    expect(edited.updatedAt.getTime()).toBe(d.updatedAt.getTime());
    const [post] = await posts(d.id);
    expect(post).toMatchObject({ text: "जयपुर में सही खबर\n\n#Jaipur #Metro @JDAJaipur", correctedBy: s.priya.id });
    expect(post!.correctedAt).toBeInstanceOf(Date);
    const [audit] = await audits(d.id, "draft.correct_posted");
    expect(audit).toMatchObject({ actorId: s.priya.id, before: { bodyText: "जयपुर में गलत खबर", version: d.version }, after: { bodyText: "जयपुर में सही खबर", version: d.version + 1 } });
    expect(await audits(d.id, "draft.edit")).toHaveLength(0);

    // The same words in another Unicode form (NFD) are no change to the post
    const nfd = await updateDraft(h.db, s.priya, d.id, edited.version, { bodyText: "जयपुर में सही खबर".normalize("NFD") }, { correction: OWN });
    expect((await posts(d.id))[0]!.correctedAt!.getTime()).toBe(post!.correctedAt!.getTime());
    expect(await audits(d.id, "draft.correct_posted")).toHaveLength(1);

    // Card corrected by upload, then back to the rendered one; resetting again changes nothing
    const withCard = await setCustomCard(h.db, s.priya, d.id, nfd.version, card, store, "jpg", OWN);
    expect(withCard).toMatchObject({ status: "published", customCardKey: expect.stringMatching(/^cards\/.*\/custom-.*\.jpg$/) });
    expect((await posts(d.id))[0]!.cardKey).toBe(withCard.customCardKey);
    const reset = await clearCustomCard(h.db, s.priya, d.id, withCard.version, OWN);
    expect(reset.status).toBe("published");
    expect((await posts(d.id))[0]!.cardKey).toBe(d.cardKey);
    expect(await clearCustomCard(h.db, s.priya, d.id, reset.version, OWN)).toMatchObject({ version: reset.version });
    expect(await audits(d.id, "draft.correct_posted")).toHaveLength(3);
    expect(await audits(d.id, "draft.card_uploaded")).toHaveLength(0);

    // Nothing that posting does ran again: one post record, staging and the decision log untouched
    expect(await postCount()).toBe(total);
    expect(await posts(d.id)).toHaveLength(1);
    const stagedNow = await h.db.select().from(hashtagStaging).where(eq(hashtagStaging.orgId, s.org.id));
    expect(stagedNow.map((r) => [r.tagKey, r.uses])).toEqual([["jaipur", 1]]);
    expect(await audits(d.id, "hashtag.staged")).toHaveLength(1);
    const [decidedNow] = await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, d.id));
    expect(decidedNow).toMatchObject({ decision: decided!.decision, finalText: decided!.finalText, decidedAt: decided!.decidedAt, voided: [] });

    expect(await correctionInfo(h.db, s.org.id, d.id)).toMatchObject({
      postedBy: { id: s.priya.id, name: "Priya" }, correctedBy: { id: s.priya.id, name: "Priya" }, correctedAt: expect.any(Date),
    });

    // Done: the hold goes (audited), the story stays posted where it was
    const done = await endCorrection(h.db, s.priya, d.id, OWN);
    expect(done).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null });
    expect(done.updatedAt.getTime()).toBe(d.updatedAt.getTime());
    expect(await audits(d.id, "draft.correction_ended")).toHaveLength(1);
    await expectDeskError(updateDraft(h.db, s.priya, d.id, done.version, { bodyText: "again" }, { correction: OWN }), "lease_lost");
  });

  it("another editor: 403 without the right to act on others' posts; with it, 409 while held, then allowed", async () => {
    const d = await posted("अजमेर खबर");
    await expectDeskError(startCorrection(h.db, s.amit, d.id, OWN), "forbidden");
    await expectDeskError(startCorrection(h.db, s.priya, d.id, { canEdit: false, canCorrectOthers: true }), "forbidden");
    await startCorrection(h.db, s.priya, d.id, OWN);
    const err = await startCorrection(h.db, s.amit, d.id, ANY).catch((e: unknown) => e as DeskError);
    expect(err).toBeInstanceOf(DeskError);
    expect(err).toMatchObject({ code: "held_by_other", message: "Priya is working on this.", data: { heldBy: "Priya" } });
    // Amit cannot edit under Priya's hold
    await expectDeskError(updateDraft(h.db, s.amit, d.id, d.version, { bodyText: "x" }, { correction: ANY }), "lease_lost");
    // Nor can Amit take the post back while Priya fixes it
    await expectDeskError(undoCopyPosted(h.db, s.amit, d.id, true), "held_by_other", "Priya is fixing this post. Undo after they finish.");
    expect((await draftRow(d.id)).status).toBe("published");

    // Release (the editor closed) keeps it published, never back to the queue
    await releaseDraft(h.db, s.priya, d.id);
    expect(await draftRow(d.id)).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null });
    const amit = await startCorrection(h.db, s.amit, d.id, ANY);
    expect(amit).toMatchObject({ status: "published", claimedBy: s.amit.id });
    // Rights are checked on every save: lost mid-hold, the save is refused
    await expectDeskError(updateDraft(h.db, s.amit, d.id, d.version, { bodyText: "अजमेर सही" }, { correction: OWN }), "forbidden");
    await expectDeskError(updateDraft(h.db, s.amit, d.id, d.version, { bodyText: "अजमेर सही" }, { correction: { canEdit: false, canCorrectOthers: true } }), "forbidden");
    await expectDeskError(setCustomCard(h.db, s.amit, d.id, d.version, card, store, "png", OWN), "forbidden");
    // Done with the rights gone still lets the hold go (audited with the rule that failed)
    expect(await endCorrection(h.db, s.amit, d.id, OWN)).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null });
    expect((await audits(d.id, "draft.correction_ended")).at(-1)).toMatchObject({ actorId: s.amit.id, after: { rulesFailed: "forbidden" } });
    await startCorrection(h.db, s.amit, d.id, ANY);
    await updateDraft(h.db, s.amit, d.id, d.version, { bodyText: "अजमेर सही" }, { correction: ANY });
    expect((await posts(d.id))[0]).toMatchObject({ correctedBy: s.amit.id, publishedBy: s.priya.id });
    // An expired hold is free for anyone allowed
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, d.id));
    await expectDeskError(extendClaim(h.db, s.amit, d.id), "lease_lost");
    expect(await startCorrection(h.db, s.priya, d.id, OWN)).toMatchObject({ claimedBy: s.priya.id, status: "published" });
    await endCorrection(h.db, s.priya, d.id, OWN);
  });

  it("a corrected post must still be a post: not empty, up to 1000 (not 280); Done still lets go of a bad one", async () => {
    const d = await posted("लंबी खबर");
    await startCorrection(h.db, s.priya, d.id, OWN);
    await expectDeskError(updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "", hashtags: [], mentions: [] }, { correction: OWN }), "post_invalid");
    await expectDeskError(updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "क".repeat(1001) }, { correction: OWN }), "post_invalid");
    const long = await updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "क".repeat(300) }, { correction: OWN });
    expect(long.version).toBe(d.version + 1);
    // A text that went bad another way (written directly here): Done still releases, and the audit says why it would not pass
    await h.db.update(postDrafts).set({ bodyText: "", hashtags: [], mentions: [] }).where(eq(postDrafts.id, d.id));
    expect((await endCorrection(h.db, s.priya, d.id, OWN)).claimedBy).toBeNull();
    expect((await audits(d.id, "draft.correction_ended")).at(-1)).toMatchObject({ after: { rulesFailed: "post_invalid" } });
  });

  it("only today's posts (IST): a hold that crosses midnight is refused with too_late on save; Done still releases", async () => {
    const d = await posted("कल की खबर");
    await startCorrection(h.db, s.priya, d.id, OWN);
    await toYesterday(d.id);
    await expectDeskError(updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "देर से" }, { correction: OWN }), "too_late", YESTERDAY_MSG);
    await expectDeskError(setCustomCard(h.db, s.priya, d.id, d.version, card, store, "png", OWN), "too_late", YESTERDAY_MSG);
    await expectDeskError(clearCustomCard(h.db, s.priya, d.id, d.version, OWN), "too_late", YESTERDAY_MSG);
    expect(await endCorrection(h.db, s.priya, d.id, OWN)).toMatchObject({ status: "published", claimedBy: null });
    await expectDeskError(startCorrection(h.db, s.priya, d.id, ANY), "too_late", "Only today's posts can be edited.");
    const yesterday = new Date(istDayStart(new Date()).getTime() - 60_000);
    expect(postedTodayIst(yesterday)).toBe(false);
    expect(postedTodayIst(new Date(istDayStart(new Date()).getTime()))).toBe(true);
  });

  it("edited is measured against what went out: back to the original text (trim, NFC) or card clears the stamp", async () => {
    const d = await posted("मूल खबर");
    const [sent] = await posts(d.id);
    await startCorrection(h.db, s.priya, d.id, OWN);
    // A -> B: stamped
    const b = await updateDraft(h.db, s.priya, d.id, d.version, { bodyText: "बदली खबर" }, { correction: OWN });
    expect((await posts(d.id))[0]).toMatchObject({ correctedBy: s.priya.id, correctedAt: expect.any(Date) });
    // B -> A (with spaces, in NFD): the original text is written back and the stamp cleared
    const a = await updateDraft(h.db, s.priya, d.id, b.version, { bodyText: `  ${d.bodyText.normalize("NFD")} ` }, { correction: OWN });
    expect((await posts(d.id))[0]).toMatchObject({ text: sent!.text, correctedAt: null, correctedBy: null });
    // A -> C -> card changed -> text back to A: still edited (the card differs); card back too: clean again
    const c = await updateDraft(h.db, s.priya, d.id, a.version, { bodyText: "तीसरी खबर" }, { correction: OWN });
    const carded = await setCustomCard(h.db, s.priya, d.id, c.version, card, store, "png", OWN);
    const back = await updateDraft(h.db, s.priya, d.id, carded.version, { bodyText: d.bodyText }, { correction: OWN });
    expect((await posts(d.id))[0]).toMatchObject({ text: sent!.text, correctedBy: s.priya.id });
    await clearCustomCard(h.db, s.priya, d.id, back.version, OWN);
    expect((await posts(d.id))[0]).toMatchObject({ text: sent!.text, cardKey: sent!.cardKey, correctedAt: null, correctedBy: null });
    await endCorrection(h.db, s.priya, d.id, OWN);
  });

  it("only Copy & Posted ones, only published drafts", async () => {
    const ready = await s.draft("अभी तैयार");
    await expectDeskError(startCorrection(h.db, s.priya, ready.id, ANY), "invalid_state");
    await expectDeskError(endCorrection(h.db, s.priya, ready.id, ANY), "invalid_state");
    await expectDeskError(startCorrection(h.db, s.priya, crypto.randomUUID(), ANY), "not_found");
    await expectDeskError(endCorrection(h.db, s.priya, crypto.randomUUID(), ANY), "not_found");
    // Another org's draft is not found either
    await expectDeskError(startCorrection(h.db, { ...s.priya, orgId: crypto.randomUUID() }, ready.id, ANY), "not_found");

    // Recorded with a link (Mark posted), not Copy & Posted: not correctable here
    const linked = await s.draft("लिंक वाली");
    await claimDraft(h.db, s.priya, linked.id);
    await markPosted(h.db, s.priya, linked.id, (await draftRow(linked.id)).version, { platformPostId: "123456789", permalink: "https://x.com/a/status/123456789" });
    await expectDeskError(startCorrection(h.db, s.priya, linked.id, ANY), "invalid_state");
    expect(await correctionInfo(h.db, s.org.id, linked.id)).toBeNull();

    // A recall that completes ends any hold on the draft
    await h.db.update(postDrafts).set({ claimedBy: s.amit.id, claimExpiresAt: sql`now() + interval '5 minutes'` }).where(eq(postDrafts.id, linked.id));
    const [record] = await posts(linked.id);
    const { id: jobId } = await requestRecall(h.db, s.priya, record!.id, "wrong story");
    const [job] = await h.db.select().from(publishJobs).where(eq(publishJobs.id, jobId));
    await completeDelete(h.db, job!);
    expect(await draftRow(linked.id)).toMatchObject({ status: "recalled", claimedBy: null, claimExpiresAt: null });
  });

  it("expired holds on posted stories are cleared on read and by the sweep, status and updated_at untouched", async () => {
    const a = await posted("पुरानी पकड़ एक");
    const b = await posted("पुरानी पकड़ दो");
    for (const d of [a, b]) {
      await startCorrection(h.db, s.priya, d.id, OWN);
      await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, d.id));
    }
    expect(await clearExpiredCorrectionHolds(h.db, s.org.id, [a.id])).toBe(1);
    expect(await draftRow(a.id)).toMatchObject({ status: "published", claimedBy: null, updatedAt: a.updatedAt });
    expect(await releaseExpiredClaims(h.db)).toBeGreaterThanOrEqual(1);
    expect(await draftRow(b.id)).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null, updatedAt: b.updatedAt });
  });

  it("an undo of the post inside its window ends any correction hold with it", async () => {
    const d = await posted("वापस");
    await startCorrection(h.db, s.priya, d.id, OWN);
    const back = await undoCopyPosted(h.db, s.priya, d.id, false);
    expect(back).toMatchObject({ status: "ready", claimedBy: null, claimExpiresAt: null });
    // A plain claim and release still return the draft to the queue
    await claimDraft(h.db, s.amit, d.id);
    await releaseDraft(h.db, s.amit, d.id);
    expect((await draftRow(d.id)).status).toBe("ready");
  });
});
