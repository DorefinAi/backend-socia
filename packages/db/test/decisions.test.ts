// The decision log (reporter-prior brief §2) and the nightly reporter features (§7.1). The pure parts run
// anywhere; the rest needs TEST_DATABASE_URL (the database is wiped).

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import {
  LOGIC_VERSION, editDistance, istDate, itemOutcomes, postItems, recordOutcome, recordProposal, reporterStatusReport, reworkBase, reworkRatio,
  setDecisionLogErrorHandler, snapshotReporterFeatures, voidOutcome, type ProposalRecord,
} from "../src/decisions";
import { claimDraft, copyPosted, rejectDraft, restoreDraft, undoCopyPosted } from "../src/desk";
import { postDecisions, postDrafts, reporterFeatures, type LoggedProposal } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";
import { eq } from "drizzle-orm";

/** Drizzle wraps the driver's error ("Failed query: ..."); the trigger's message is on its cause */
async function refused(p: Promise<unknown>, re: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { message: string; cause?: { message?: string } });
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ""}`).toMatch(re);
}

const P = (item: string, layer: "emit" | "suggest", source: string, extra: Partial<LoggedProposal> = {}): LoggedProposal => ({
  item, kind: item.startsWith("#") ? "hashtag" : "handle", layer, source, reason: `${source} reason`, ...extra,
});

describe("rework ratio (brief §2.5)", () => {
  it("strips hashtags, handles and links before measuring", () => {
    expect(reworkBase("#Jaipur: जयपुर में बारिश https://t.co/abc @JaipurPolice\n\n#RajasthanWithFirstIndia")).toBe(": जयपुर में बारिश");
    // Only tags and handles changed: no rework
    expect(reworkRatio("#Jaipur: जयपुर में बारिश @A", "#Kota: जयपुर में बारिश @B #X")).toBe(0);
  });

  it("is the edit distance over the stripped draft's length", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(reworkRatio("abcd #T", "abXd #T")).toBe(0.25);
    expect(reworkRatio("abcd", "")).toBe(1);
    // A draft with no words of its own: nothing to compare against
    expect(reworkRatio("#Only @Tags", "anything")).toBeNull();
  });

  it("counts a Devanagari matra as one edit", () => {
    expect(editDistance("बारिश", "बारीश")).toBe(1);
  });
});

describe("item outcomes (brief §2.4)", () => {
  const proposals = [
    P("#Jaipur", "emit", "district.place_line"),
    P("#RajasthanWithFirstIndia", "emit", "brand.geo"),
    P("@JaipurPolice", "emit", "district.police"),
    P("#RoadAccident", "suggest", "topic_rule"),
    P("@RajGovOfficial", "suggest", "reporter_prior", { score: 0.62, n: 102 }),
    // Offered again as a suggestion: counts once, as the emitted item
    P("#jaipur", "suggest", "campaign"),
  ];

  it("kept / removed / accepted / ignored / desk_added, case-insensitively", () => {
    const final = "#Jaipur: सड़क हादसा\n\n#RajasthanWithFirstIndia #roadaccident #Breaking @CMOfficeRajasthan";
    expect(itemOutcomes(proposals, final)).toEqual([
      { item: "#Jaipur", kind: "hashtag", layer: "emit", source: "district.place_line", outcome: "kept" },
      { item: "#RajasthanWithFirstIndia", kind: "hashtag", layer: "emit", source: "brand.geo", outcome: "kept" },
      { item: "@JaipurPolice", kind: "handle", layer: "emit", source: "district.police", outcome: "removed" },
      { item: "#RoadAccident", kind: "hashtag", layer: "suggest", source: "topic_rule", outcome: "accepted" },
      { item: "@RajGovOfficial", kind: "handle", layer: "suggest", source: "reporter_prior", outcome: "ignored" },
      { item: "#Breaking", kind: "hashtag", layer: null, source: "desk", outcome: "desk_added" },
      { item: "@CMOfficeRajasthan", kind: "handle", layer: null, source: "desk", outcome: "desk_added" },
    ]);
  });

  it("reads hashtags and handles out of the post text", () => {
    expect(postItems("#जयपुर: x @A_b, #K2 @a_B")).toEqual({ hashtags: ["#जयपुर", "#K2"], handles: ["@A_b"] });
  });
});

describe("istDate", () => {
  it("is the IST calendar day", () => {
    expect(istDate(new Date("2026-11-12T18:29:00Z"))).toBe("2026-11-12");
    expect(istDate(new Date("2026-11-12T18:31:00Z"))).toBe("2026-11-13");
  });
});

(TEST_URL ? describe : describe.skip)("decision log on Postgres", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  const errors: unknown[] = [];

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
    setDecisionLogErrorHandler((err) => void errors.push(err));
  }, 60_000);
  afterAll(async () => h?.close());
  beforeEach(() => void (errors.length = 0));

  const proposalFor = (d: { id: string; storyId: string; bodyText: string }, extra: Partial<ProposalRecord> = {}): ProposalRecord => ({
    orgId: s.org.id, draftId: d.id, storyId: d.storyId, filenameRaw: "BTN_RJ_BREAKING_29OCT_NDR_Bhanwar_BIG.txt", slotRaw: "Bhanwar",
    reporterToken: "BHANWAR", bureauCode: null, bureauDistrict: null, reporterHandle: "BhanwarJ", reporterStatus: "matched",
    storyClass: "incident", district: "Jaipur", districtFrom: "place_line", composeVersion: "test",
    draftText: `${d.bodyText}\n\n#Jaipur @JDAJaipur`,
    proposals: [P("#Jaipur", "emit", "district.place_line"), P("@JDAJaipur", "suggest", "subject")],
    explore: false, ...extra,
  });
  const row = async (draftId: string) => (await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, draftId)))[0]!;

  it("writes the proposal half with the logic version; explore marks every item", async () => {
    const d = await s.draft("जयपुर मेट्रो फेज-2 को मंजूरी");
    expect(await recordProposal(h.db, proposalFor(d, { explore: true }))).toBe(true);
    const r = await row(d.id);
    expect(r).toMatchObject({ logicVersion: LOGIC_VERSION, reporterStatus: "matched", explore: true, proposalRev: 1, decidedAt: null });
    expect(r.proposals.every((p) => p.explore === true)).toBe(true);
    // A re-saved file refreshes an undecided proposal and keeps the first explore roll
    expect(await recordProposal(h.db, proposalFor(d, { explore: false, draftText: "new" }))).toBe(true);
    expect(await row(d.id)).toMatchObject({ proposalRev: 2, explore: true, draftText: "new" });
  });

  it("Copy & Posted writes the outcome once; the decided row is append-only", async () => {
    const d = await s.draft("जयपुर मेट्रो फेज-2 को मंजूरी");
    await recordProposal(h.db, proposalFor(d));
    // The desk edits the words and the tags, then copies it
    await h.db.update(postDrafts).set({ bodyText: "जयपुर मेट्रो फेज-2 मंजूर", hashtags: ["#Jaipur", "#Metro"], mentions: ["@JDAJaipur"] }).where(eq(postDrafts.id, d.id));
    const [cur] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    const posted = await copyPosted(h.db, s.priya, d.id, cur!.version);
    const r = await row(d.id);
    expect(r).toMatchObject({ decision: "copy_posted", decidedBy: s.priya.id, finalText: posted.text, finalHashtags: ["#Jaipur", "#Metro"], finalHandles: ["@JDAJaipur"] });
    expect(r.itemOutcomes).toEqual([
      { item: "#Jaipur", kind: "hashtag", layer: "emit", source: "district.place_line", outcome: "kept" },
      { item: "@JDAJaipur", kind: "handle", layer: "suggest", source: "subject", outcome: "accepted" },
      { item: "#Metro", kind: "hashtag", layer: null, source: "desk", outcome: "desk_added" },
    ]);
    expect(r.reworkRatio).toBeCloseTo(reworkRatio(r.draftText, posted.text)!, 5);
    expect(r.reworkRatio).toBeGreaterThan(0);

    // A second decision and a re-saved file both leave it alone
    expect(await recordOutcome(h.db, { draftId: d.id, decision: "rejected", finalText: "x", decidedBy: s.amit.id })).toBe(false);
    expect(await recordProposal(h.db, proposalFor(d, { draftText: "changed" }))).toBe(false);
    expect(await row(d.id)).toMatchObject({ decision: "copy_posted", draftText: r.draftText, proposalRev: 1 });
    // And the database itself refuses a rewrite
    await refused(h.db.execute(sql`UPDATE post_decisions SET final_text = 'forged' WHERE draft_id = ${d.id}`), /append-only/);
    await refused(h.db.execute(sql`UPDATE post_decisions SET proposals = '[]'::jsonb WHERE draft_id = ${d.id}`), /append-only/);

    // Undo inside the window voids the outcome (kept in `voided`); posting again is the new outcome
    await undoCopyPosted(h.db, s.priya, d.id, false);
    const voided = await row(d.id);
    expect(voided).toMatchObject({ decision: null, decidedAt: null, finalText: null });
    expect(voided.voided).toHaveLength(1);
    expect(voided.voided[0]).toMatchObject({ decision: "copy_posted", finalText: posted.text, voidedBy: s.priya.id });
    expect(voided.proposals).toEqual(r.proposals);
    const [again] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    await copyPosted(h.db, s.amit, d.id, again!.version);
    expect(await row(d.id)).toMatchObject({ decision: "copy_posted", decidedBy: s.amit.id });
    expect((await row(d.id)).voided).toHaveLength(1);
    // voided only ever grows
    await refused(h.db.execute(sql`UPDATE post_decisions SET voided = '[]'::jsonb, decision = NULL, decided_at = NULL WHERE draft_id = ${d.id}`), /append-only/);
    expect(errors).toEqual([]);
  });

  it("Reject writes the outcome with its reason; restore voids it", async () => {
    const d = await s.draft("कोटा में बारिश");
    await recordProposal(h.db, proposalFor(d));
    await claimDraft(h.db, s.amit, d.id);
    await rejectDraft(h.db, s.amit, d.id, "duplicate", null);
    expect(await row(d.id)).toMatchObject({ decision: "rejected", rejectReason: "duplicate", decidedBy: s.amit.id });
    await restoreDraft(h.db, s.amit, d.id);
    expect(await row(d.id)).toMatchObject({ decision: null, rejectReason: null });
    expect((await row(d.id)).voided[0]).toMatchObject({ decision: "rejected" });
  });

  it("a re-save after the decision marks the proposal stale: the next outcome keeps the post, not item outcomes", async () => {
    const d = await s.draft("बाड़मेर में हादसा");
    await recordProposal(h.db, proposalFor(d));
    await claimDraft(h.db, s.amit, d.id);
    await rejectDraft(h.db, s.amit, d.id, "other", null);
    // The reporter saves the file again: compose rewrites the rejected draft and tries to log a new proposal
    expect(await recordProposal(h.db, proposalFor(d, { draftText: "rewritten" }))).toBe(false);
    expect(await row(d.id)).toMatchObject({ proposalStale: true, decision: "rejected", draftText: expect.not.stringMatching(/rewritten/) });
    await restoreDraft(h.db, s.amit, d.id);
    const [cur] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id));
    const posted = await copyPosted(h.db, s.priya, d.id, cur!.version);
    expect(await row(d.id)).toMatchObject({ decision: "copy_posted", finalText: posted.text, itemOutcomes: null, reworkRatio: null, proposalStale: true });
    // stale only goes one way
    await refused(h.db.execute(sql`UPDATE post_decisions SET proposal_stale = false WHERE draft_id = ${d.id}`), /append-only/);
  });

  it("the trigger refuses a void that keeps or forges the outcome", async () => {
    const d = await s.draft("जोधपुर");
    await recordProposal(h.db, proposalFor(d));
    await recordOutcome(h.db, { draftId: d.id, decision: "copy_posted", finalText: "real", decidedBy: s.priya.id });
    // decision cleared but final_text kept
    await refused(
      h.db.execute(sql`UPDATE post_decisions SET decision = NULL, decided_at = NULL, decided_by = NULL, voided = voided || '[{"decision":"copy_posted","finalText":"real"}]'::jsonb WHERE draft_id = ${d.id}`),
      /append-only/,
    );
    // a voided entry that is not the outcome it replaces
    await refused(
      h.db.execute(sql`UPDATE post_decisions SET decision = NULL, decided_at = NULL, decided_by = NULL, final_text = NULL, final_hashtags = NULL, final_handles = NULL, item_outcomes = NULL, rework_ratio = NULL, voided = voided || '[{"decision":"rejected","finalText":"forged"}]'::jsonb WHERE draft_id = ${d.id}`),
      /append-only/,
    );
    expect(await voidOutcome(h.db, d.id, s.priya.id)).toBe(true);
  });

  it("a draft with no proposal logs nothing, and a failed log write never fails the desk action", async () => {
    const plain = await s.draft("बिना प्रस्ताव");
    const [cur] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, plain.id));
    await copyPosted(h.db, s.priya, plain.id, cur!.version);
    expect(await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, plain.id))).toEqual([]);

    // A proposal the database refuses (no such org): caught and reported, the surrounding transaction goes on
    const d = await s.draft("टूटी लॉग पंक्ति");
    const ok = await h.db.transaction(async (tx) => {
      const written = await recordProposal(tx, proposalFor(d, { orgId: "00000000-0000-0000-0000-000000000000" }));
      await tx.update(postDrafts).set({ bodyText: "still saved" }).where(eq(postDrafts.id, d.id));
      return written;
    });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect((await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id)))[0]!.bodyText).toBe("still saved");
    expect(await voidOutcome(h.db, d.id, null)).toBe(false);
  });

  it("the weekly report lists unknown tokens, collisions and unknown bureau codes, most frequent first", async () => {
    const mk = async (status: string, token: string | null, code: string | null, file: string) => {
      const d = await s.draft("रिपोर्ट");
      await recordProposal(h.db, proposalFor(d, { reporterStatus: status, reporterToken: token, bureauCode: code, filenameRaw: file, reporterHandle: null }));
    };
    await mk("unknown_token", "RAMESH", null, "a_RAMESH.txt");
    await mk("unknown_token", "RAMESH", null, "b_RAMESH.txt");
    await mk("unknown_token", "SURESH", null, "c_SURESH.txt");
    await mk("collision", "PK", null, "d_PK.txt");
    await mk("unknown_bureau_code", null, "XYZ", "e_XYZ9.txt");
    const since = new Date(Date.now() - 7 * 86_400_000);
    const report = await reporterStatusReport(h.db, s.org.id, { since });
    expect(report.map((r) => [r.status, r.value, r.files])).toEqual([
      ["unknown_token", "RAMESH", 2],
      ["collision", "PK", 1],
      ["unknown_token", "SURESH", 1],
      ["unknown_bureau_code", "XYZ", 1],
    ]);
    expect(report[0]!.example).toBe("b_RAMESH.txt");
    expect(await reporterStatusReport(h.db, s.org.id, { since, limit: 1 })).toHaveLength(3);
  });
});

(TEST_URL ? describe : describe.skip)("nightly reporter features (brief §7.1)", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  // 2026-11-13 10:00 IST
  const NOW = new Date("2026-11-13T04:30:00Z");
  const TODAY_START = new Date("2026-11-12T18:30:00Z");

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
  }, 60_000);
  afterAll(async () => h?.close());

  /** A posted decision for `reporter` decided at `at`, with `items` on the final post */
  async function decided(
    reporter: string, at: Date, items: string[], decision: "copy_posted" | "rejected" | "approved" = "copy_posted", outcomes: { source: string; outcome: string }[] = [],
    reporterStatus = "matched",
  ) {
    const d = await s.draft("x");
    await h.db.insert(postDecisions).values({
      orgId: s.org.id, draftId: d.id, storyId: d.storyId, reporterToken: reporter, reporterStatus, logicVersion: LOGIC_VERSION,
      composeVersion: "t", draftText: "x", proposals: [], decision, decidedAt: at, finalText: items.join(" "),
      finalHashtags: items.filter((i) => i.startsWith("#")), finalHandles: items.filter((i) => i.startsWith("@")),
      itemOutcomes: outcomes.map((o) => ({ item: "@X", kind: "handle" as const, layer: "suggest" as const, source: o.source, outcome: o.outcome as "accepted" })),
      reworkRatio: 0.1,
    });
  }

  it("smooths each rate toward the desk's with m = 20, from posted decisions before today only (L5)", async () => {
    const yesterday = new Date("2026-11-12T10:00:00Z");
    // RITURAJ: 4 posts, 3 with @RajGovOfficial; AMIT: 6 posts, none
    for (let i = 0; i < 3; i++) await decided("RITURAJ", yesterday, ["#Jaipur", "@RajGovOfficial"], "copy_posted", [{ source: "reporter_prior", outcome: "accepted" }]);
    await decided("RITURAJ", yesterday, ["#Jaipur"], "copy_posted", [{ source: "reporter_prior", outcome: "ignored" }]);
    for (let i = 0; i < 6; i++) await decided("AMIT", yesterday, ["#Kota"]);
    // Leakage guard L5: decided after today began, so it must not count, however many
    for (let i = 0; i < 5; i++) await decided("RITURAJ", new Date(TODAY_START.getTime() + 60_000), ["@Leak"]);
    // A rejection says nothing about the tags the desk wanted
    await decided("RITURAJ", yesterday, ["@Rejected"], "rejected");
    // A token that names nobody (or two people) is no reporter's profile
    await decided("REPORTER", yesterday, ["#Kota"], "copy_posted", [], "unknown_token");
    await decided("DINESH", yesterday, ["#Kota"], "copy_posted", [], "collision");
    // An API post that never went out (no published_posts row) did not reach X
    await decided("RITURAJ", yesterday, ["@NeverSent"], "approved");

    expect(await snapshotReporterFeatures(h.db, s.org.id, NOW)).toBe(2);
    const [rit] = await h.db.select().from(reporterFeatures).where(eq(reporterFeatures.reporter, "RITURAJ"));
    expect(rit).toMatchObject({ snapshotDate: "2026-11-13", n: 4 });
    const f = rit!.features;
    expect(f.m).toBe(20);
    expect(f.cutoff).toBe(TODAY_START.toISOString());
    // base 3/10; smoothed (3 + 20·0.3) / (4 + 20) = 0.375
    expect(f.items["@rajgovofficial"]).toEqual({ kind: "handle", count: 3, rate: 0.75, base: 0.3, smoothed: 0.375 });
    expect(f.items["@leak"]).toBeUndefined();
    expect(f.items["@rejected"]).toBeUndefined();
    expect(f.items["@neversent"]).toBeUndefined();
    expect((await h.db.select().from(reporterFeatures)).map((r) => r.reporter).sort()).toEqual(["AMIT", "RITURAJ"]);
    // reporter_prior: 3 of 4 taken, desk-wide also 3/4 → smoothed stays 0.75
    expect(f.sources.reporter_prior).toEqual({ proposed: 4, taken: 3, rate: 0.75, base: 0.75, smoothed: 0.75 });
    expect(f.reworkMean).toBe(0.1);
  });

  it("never overwrites a day's snapshot: a second run inserts nothing and an UPDATE is refused", async () => {
    await decided("NEWCOMER", new Date("2026-11-12T11:00:00Z"), ["#Ajmer"]);
    // Same day again: the existing rows are kept; only the reporter who had none gets one
    expect(await snapshotReporterFeatures(h.db, s.org.id, NOW)).toBe(1);
    const [rit] = await h.db.select().from(reporterFeatures).where(eq(reporterFeatures.reporter, "RITURAJ"));
    expect(rit!.n).toBe(4);
    await refused(h.db.execute(sql`UPDATE reporter_features SET n = 99`), /never overwritten/);
    // Tomorrow: a new snapshot, and yesterday's leak-guarded posts now count
    expect(await snapshotReporterFeatures(h.db, s.org.id, new Date(NOW.getTime() + 86_400_000))).toBe(3);
    const rows = await h.db.select().from(reporterFeatures).where(eq(reporterFeatures.snapshotDate, "2026-11-14"));
    expect(rows.find((r) => r.reporter === "RITURAJ")!.n).toBe(9);
  });
});
