// The decision log (reporter-prior brief §2) and the nightly reporter features (§7.1). The pure parts run
// anywhere; the rest needs TEST_DATABASE_URL (the database is wiped).

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import {
  LOG_LOCK_TIMEOUT, LOGIC_VERSION, editDistance, istDate, itemKey, itemOutcomes, minusDays, postItems, recordOutcome, recordProposal, reporterStatusReport, reworkBase, reworkRatio,
  setDecisionLogger, snapshotReporterFeatures, voidOutcome, type ProposalRecord,
} from "../src/decisions";
import { claimDraft, copyPosted, rejectDraft, restoreDraft, undoCopyPosted } from "../src/desk";
import { postDecisions, postDrafts, reporterFeatures, type LoggedProposal } from "../src/schema";
import { TEST_URL, freshDb, seed } from "./helpers";
import { and, eq } from "drizzle-orm";

/** Drizzle wraps the driver's error ("Failed query: ..."); the trigger's message is on its cause */
async function refused(p: Promise<unknown>, re: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { message: string; cause?: { message?: string } });
  expect(err, "expected the database to refuse").not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ""}`).toMatch(re);
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

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
  it("counts days back across a month", () => {
    expect(minusDays("2026-11-13", 90)).toBe("2026-08-15");
  });

  it("is the IST calendar day", () => {
    expect(istDate(new Date("2026-11-12T18:29:00Z"))).toBe("2026-11-12");
    expect(istDate(new Date("2026-11-12T18:31:00Z"))).toBe("2026-11-13");
  });
});

(TEST_URL ? describe : describe.skip)("decision log on Postgres", () => {
  let h: DbHandle;
  let s: Awaited<ReturnType<typeof seed>>;
  const logged: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => logged.filter((l) => l.level === level);

  beforeAll(async () => {
    h = await freshDb();
    s = await seed(h);
    setDecisionLogger({
      info: (obj, msg) => void logged.push({ level: "info", obj, msg }),
      warn: (obj, msg) => void logged.push({ level: "warn", obj, msg }),
      error: (obj, msg) => void logged.push({ level: "error", obj, msg }),
    });
  }, 60_000);
  afterAll(async () => h?.close());
  beforeEach(() => void (logged.length = 0));

  const proposalFor = (d: { id: string; storyId: string; bodyText: string }, extra: Partial<ProposalRecord> = {}): ProposalRecord => ({
    orgId: s.org.id, draftId: d.id, storyId: d.storyId, filenameRaw: "BTN_RJ_BREAKING_29OCT_NDR_Bhanwar_BIG.txt", slotRaw: "Bhanwar",
    reporterToken: "BHANWAR", bureauCode: null, bureauDistrict: null, reporterHandle: "BhanwarJ", reporterStatus: "matched",
    storyClass: "incident", district: "Jaipur", districtFrom: "place_line", composeVersion: "test",
    draftText: `${d.bodyText}\n\n#Jaipur @JDAJaipur`,
    proposals: [P("#Jaipur", "emit", "district.place_line"), P("@JDAJaipur", "suggest", "subject")],
    explore: false, ...extra,
  });
  const propose = (d: { id: string; storyId: string; bodyText: string }, extra: Partial<ProposalRecord> = {}) =>
    recordProposal(h.db, { orgId: s.org.id, draftId: d.id }, proposalFor(d, extra));
  const row = async (draftId: string) => (await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, draftId)))[0]!;
  /** A breaking draft: one with a handle_pick, so a missing log row is worth a warning */
  const breaking = async (headline: string) => {
    const d = await s.draft(headline);
    await h.db.update(postDrafts).set({ handlePick: { cls: "other", why: "", warnings: [], handles: [] } }).where(eq(postDrafts.id, d.id));
    return d;
  };
  const version = async (id: string) => (await h.db.select({ v: postDrafts.version }).from(postDrafts).where(eq(postDrafts.id, id)))[0]!.v;

  it("writes the proposal half with the logic version; explore marks every item", async () => {
    const d = await s.draft("जयपुर मेट्रो फेज-2 को मंजूरी");
    expect(await propose(d, { explore: true })).toBe("written");
    const r = await row(d.id);
    expect(r).toMatchObject({ logicVersion: LOGIC_VERSION, reporterStatus: "matched", explore: true, proposalRev: 1, decidedAt: null });
    expect(r.proposals.every((p) => p.explore === true)).toBe(true);
    // A re-saved file refreshes an undecided proposal and keeps the first explore roll
    expect(await propose(d, { explore: false, draftText: "new" })).toBe("written");
    expect(await row(d.id)).toMatchObject({ proposalRev: 2, explore: true, draftText: "new" });
  });

  it("D1: everything the builder does runs in the savepoint; a throw there never touches the caller's transaction", async () => {
    const d = await s.draft("बिल्डर");
    const status = await h.db.transaction(async (tx) => {
      const st = await recordProposal(tx, { orgId: s.org.id, draftId: d.id }, async (sp) => {
        // A real read that succeeds, then a failure: both are rolled back to the savepoint
        await sp.select().from(postDrafts).where(eq(postDrafts.id, d.id));
        throw new Error("lookup broke");
      });
      await tx.update(postDrafts).set({ bodyText: "still saved" }).where(eq(postDrafts.id, d.id));
      return st;
    });
    expect(status).toBe("failed");
    expect(at("error")).toHaveLength(1);
    expect(at("error")[0]!.obj).toMatchObject({ op: "proposal", orgId: s.org.id, draftId: d.id });
    expect((await h.db.select().from(postDrafts).where(eq(postDrafts.id, d.id)))[0]!.bodyText).toBe("still saved");
    // A failed SQL statement inside (no such org) is the same
    const d2 = await s.draft("टूटी लॉग पंक्ति");
    expect(await propose(d2, { orgId: "00000000-0000-0000-0000-000000000000" })).toBe("failed");
  });

  it("D9: a log write waits about 500ms on a row lock, then gives up; the caller's own lock timeout comes back afterwards", async () => {
    const d = await s.draft("ताला");
    await propose(d);
    const other = await h.pool.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT 1 FROM post_decisions WHERE draft_id = $1 FOR UPDATE", [d.id]);
      const started = Date.now();
      const [status, after] = await h.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '7s'`);
        const st = await recordOutcome(tx, { orgId: s.org.id, draftId: d.id, decision: "rejected", finalText: "x", decidedBy: s.amit.id });
        const lt = (await tx.execute(sql`SELECT current_setting('lock_timeout') AS lt`)).rows[0] as { lt: string };
        return [st, lt.lt] as const;
      });
      const waited = Date.now() - started;
      expect(status).toBe("failed");
      // LOG_LOCK_TIMEOUT (500ms), not the caller's 7s and not at once
      expect(LOG_LOCK_TIMEOUT).toBe("500ms");
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(1500);
      expect(after).toBe("7s");
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
    // And a successful write restores it too
    const lt = await h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '7s'`);
      expect(await recordOutcome(tx, { orgId: s.org.id, draftId: d.id, decision: "rejected", finalText: "x", decidedBy: s.amit.id })).toBe("written");
      return ((await tx.execute(sql`SELECT current_setting('lock_timeout') AS lt`)).rows[0] as { lt: string }).lt;
    });
    expect(lt).toBe("7s");
  });

  it("Copy & Posted writes the outcome once; the decided row is append-only; undo voids it whole", async () => {
    const d = await s.draft("जयपुर मेट्रो फेज-2 को मंजूरी");
    await propose(d);
    // The desk edits the words and the tags, then copies it
    await h.db.update(postDrafts).set({ bodyText: "जयपुर मेट्रो फेज-2 मंजूर", hashtags: ["#Jaipur", "#Metro"], mentions: ["@JDAJaipur"] }).where(eq(postDrafts.id, d.id));
    const posted = await copyPosted(h.db, s.priya, d.id, await version(d.id));
    const r = await row(d.id);
    expect(r).toMatchObject({ decision: "copy_posted", decidedBy: s.priya.id, finalText: posted.text, finalHashtags: ["#Jaipur", "#Metro"], finalHandles: ["@JDAJaipur"] });
    expect(r.itemOutcomes).toEqual([
      { item: "#Jaipur", kind: "hashtag", layer: "emit", source: "district.place_line", outcome: "kept" },
      { item: "@JDAJaipur", kind: "handle", layer: "suggest", source: "subject", outcome: "accepted" },
      { item: "#Metro", kind: "hashtag", layer: null, source: "desk", outcome: "desk_added" },
    ]);
    expect(r.reworkRatio).toBeCloseTo(reworkRatio(r.draftText, posted.text)!, 5);
    expect(r.reworkRatio).toBeGreaterThan(0);

    // The same decision again is a repeat; a re-saved file only marks it stale
    expect(await recordOutcome(h.db, { orgId: s.org.id, draftId: d.id, decision: "copy_posted", finalText: posted.text, decidedBy: s.priya.id })).toBe("already_decided");
    expect(await propose(d, { draftText: "changed" })).toBe("already_decided");
    expect(at("info").map((l) => l.msg).join(" ")).toMatch(/marked stale/);
    expect(await row(d.id)).toMatchObject({ decision: "copy_posted", draftText: r.draftText, proposalRev: 1, proposalStale: true });
    // The database itself refuses a rewrite
    await refused(h.db.execute(sql`UPDATE post_decisions SET final_text = 'forged' WHERE draft_id = ${d.id}`), /append-only/);
    await refused(h.db.execute(sql`UPDATE post_decisions SET proposals = '[]'::jsonb WHERE draft_id = ${d.id}`), /append-only/);
    await refused(h.db.execute(sql`UPDATE post_decisions SET proposal_stale = false WHERE draft_id = ${d.id}`), /append-only/);

    // Undo inside the window voids the outcome: every outcome column and the proposal it was measured against
    await undoCopyPosted(h.db, s.priya, d.id, false);
    const voided = await row(d.id);
    expect(voided).toMatchObject({ decision: null, decidedAt: null, finalText: null, finalHashtags: null, itemOutcomes: null });
    expect(voided.voided).toHaveLength(1);
    expect(voided.voided[0]).toMatchObject({
      late: false, voided_by: s.priya.id,
      outcome: { decision: "copy_posted", decided_by: s.priya.id, reject_reason: null, final_text: posted.text, final_hashtags: ["#Jaipur", "#Metro"], final_handles: ["@JDAJaipur"], item_outcomes: r.itemOutcomes },
      proposal: { draft_text: r.draftText, proposal_rev: 1, proposal_stale: true, proposals: r.proposals },
    });
    expect(voided.voided[0]!.outcome.rework_ratio).toBeCloseTo(r.reworkRatio!, 5);
    // Posting again is the new outcome; voided only ever grows
    await copyPosted(h.db, s.amit, d.id, await version(d.id));
    expect(await row(d.id)).toMatchObject({ decision: "copy_posted", decidedBy: s.amit.id, itemOutcomes: null, reworkRatio: null });
    await refused(h.db.execute(sql`UPDATE post_decisions SET voided = '[]'::jsonb, decision = NULL, decided_at = NULL WHERE draft_id = ${d.id}`), /append-only/);
    expect(at("error")).toEqual([]);
  });

  it("the trigger refuses a void that keeps, drops or forges any part of the outcome", async () => {
    const d = await s.draft("जोधपुर");
    await propose(d);
    await recordOutcome(h.db, { orgId: s.org.id, draftId: d.id, decision: "rejected", finalText: "real #T", decidedBy: s.priya.id, rejectReason: "other" });
    const clear = sql`decision = NULL, decided_at = NULL, decided_by = NULL, reject_reason = NULL, final_text = NULL, final_hashtags = NULL, final_handles = NULL, item_outcomes = NULL, rework_ratio = NULL`;
    const entry = (outcome: ReturnType<typeof sql>) => sql`jsonb_build_array(jsonb_build_object('outcome', ${outcome},
      'proposal', jsonb_build_object('proposals', proposals, 'draft_text', draft_text, 'proposal_rev', proposal_rev, 'proposal_stale', proposal_stale)))`;
    const real = sql`jsonb_build_object('decision', decision, 'decided_at', decided_at, 'decided_by', decided_by, 'reject_reason', reject_reason,
      'final_text', final_text, 'final_hashtags', final_hashtags, 'final_handles', final_handles, 'item_outcomes', item_outcomes, 'rework_ratio', rework_ratio)`;
    // The outcome kept on the row
    await refused(h.db.execute(sql`UPDATE post_decisions SET decision = NULL, decided_at = NULL, voided = voided || ${entry(real)} WHERE draft_id = ${d.id}`), /append-only/);
    // The reject reason dropped from the entry
    await refused(h.db.execute(sql`UPDATE post_decisions SET ${clear}, voided = voided || ${entry(sql`${real} - 'reject_reason'`)} WHERE draft_id = ${d.id}`), /append-only/);
    // A forged final text in the entry
    await refused(h.db.execute(sql`UPDATE post_decisions SET ${clear}, voided = voided || ${entry(sql`${real} || '{"final_text":"forged"}'::jsonb`)} WHERE draft_id = ${d.id}`), /append-only/);
    expect(await voidOutcome(h.db, { orgId: s.org.id, draftId: d.id, voidedBy: s.priya.id })).toBe("written");
    expect((await row(d.id)).voided[0]!.outcome).toMatchObject({ decision: "rejected", reject_reason: "other", final_text: "real #T", final_hashtags: ["#T"] });
    expect(await voidOutcome(h.db, { orgId: s.org.id, draftId: d.id, voidedBy: s.priya.id })).toBe("not_decided");
  });

  it("no row of the log is ever deleted, unless a maintainer says so", async () => {
    const d = await s.draft("मिटाना");
    await propose(d);
    await refused(h.db.execute(sql`DELETE FROM post_decisions WHERE draft_id = ${d.id}`), /never deleted/);
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL socia.allow_decision_delete = 'on'`);
      await tx.execute(sql`DELETE FROM post_decisions WHERE draft_id = ${d.id}`);
    });
    expect(await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, d.id))).toEqual([]);
  });

  it("Reject writes the outcome with its reason; restore voids it", async () => {
    const d = await s.draft("कोटा में बारिश");
    await propose(d);
    await claimDraft(h.db, s.amit, d.id);
    await rejectDraft(h.db, s.amit, d.id, "duplicate", null);
    expect(await row(d.id)).toMatchObject({ decision: "rejected", rejectReason: "duplicate", decidedBy: s.amit.id });
    await restoreDraft(h.db, s.amit, d.id);
    expect(await row(d.id)).toMatchObject({ decision: null, rejectReason: null });
    expect((await row(d.id)).voided[0]).toMatchObject({ late: false, outcome: { decision: "rejected", reject_reason: "duplicate" } });
  });

  it("D3: a withdrawn decision still in place (its void failed) is voided late, and the new one written", async () => {
    const d = await breaking("बाड़मेर");
    await propose(d);
    await claimDraft(h.db, s.amit, d.id);
    await rejectDraft(h.db, s.amit, d.id, "other", null);
    // Restore with the log's void failing: the draft is restored, the log still says rejected
    await h.db.execute(sql`ALTER TABLE post_decisions ADD CONSTRAINT test_no_void CHECK (decision IS NOT NULL OR jsonb_array_length(voided) = 0) NOT VALID`);
    try {
      await restoreDraft(h.db, s.amit, d.id);
    } finally {
      await h.db.execute(sql`ALTER TABLE post_decisions DROP CONSTRAINT test_no_void`);
    }
    expect(at("error").map((l) => l.obj.op)).toEqual(["void"]);
    expect(at("warn").map((l) => l.msg).join(" ")).toMatch(/not logged \(the write failed\)/);
    expect(await row(d.id)).toMatchObject({ decision: "rejected" });

    logged.length = 0;
    const posted = await copyPosted(h.db, s.priya, d.id, await version(d.id));
    const r = await row(d.id);
    expect(r).toMatchObject({ decision: "copy_posted", finalText: posted.text, decidedBy: s.priya.id });
    expect(r.voided).toHaveLength(1);
    expect(r.voided[0]).toMatchObject({ late: true, voided_by: s.priya.id, outcome: { decision: "rejected" } });
    expect(at("warn").map((l) => l.msg).join(" ")).toMatch(/voided it now, late/);
  });

  it("a re-save after the decision marks the proposal stale: the next outcome keeps the post, not item outcomes", async () => {
    const d = await s.draft("बाड़मेर में हादसा");
    await propose(d);
    await claimDraft(h.db, s.amit, d.id);
    await rejectDraft(h.db, s.amit, d.id, "other", null);
    expect(await propose(d, { draftText: "rewritten" })).toBe("already_decided");
    expect(await row(d.id)).toMatchObject({ proposalStale: true, decision: "rejected" });
    await restoreDraft(h.db, s.amit, d.id);
    const posted = await copyPosted(h.db, s.priya, d.id, await version(d.id));
    expect(await row(d.id)).toMatchObject({ decision: "copy_posted", finalText: posted.text, itemOutcomes: null, reworkRatio: null, proposalStale: true });
  });

  it("D2: a breaking draft with no proposal row is warned about; any other draft logs nothing", async () => {
    const plain = await s.draft("बिना प्रस्ताव");
    await copyPosted(h.db, s.priya, plain.id, await version(plain.id));
    expect(await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, plain.id))).toEqual([]);
    expect(logged).toEqual([]);
    const b = await breaking("बिना प्रस्ताव, ब्रेकिंग");
    await copyPosted(h.db, s.priya, b.id, await version(b.id));
    expect(at("warn")).toHaveLength(1);
    expect(at("warn")[0]).toMatchObject({ obj: { orgId: s.org.id, draftId: b.id, op: "copy_posted" }, msg: expect.stringMatching(/no proposal row/) });
  });

  it("a logger that throws falls back to the console and never fails the write", async () => {
    setDecisionLogger({ info: () => {}, warn: () => {}, error: () => { throw new Error("logger down"); } });
    try {
      const d = await s.draft("लॉगर");
      expect(await propose(d, { orgId: "00000000-0000-0000-0000-000000000000" })).toBe("failed");
    } finally {
      setDecisionLogger({
        info: (obj, msg) => void logged.push({ level: "info", obj, msg }),
        warn: (obj, msg) => void logged.push({ level: "warn", obj, msg }),
        error: (obj, msg) => void logged.push({ level: "error", obj, msg }),
      });
    }
  });

  it("the weekly report lists unknown tokens, collisions and unknown bureau codes, with the log's coverage", async () => {
    await h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL socia.allow_decision_delete = 'on'`);
      await tx.execute(sql`DELETE FROM post_decisions`);
    });
    const mk = async (status: string, token: string | null, code: string | null, file: string) => {
      const d = await breaking("रिपोर्ट");
      await propose(d, { reporterStatus: status, reporterToken: token, bureauCode: code, filenameRaw: file, reporterHandle: null });
    };
    await mk("unknown_token", "RAMESH", null, "a_RAMESH.txt");
    await mk("unknown_token", "RAMESH", null, "b_RAMESH.txt");
    await mk("unknown_token", "SURESH", null, "c_SURESH.txt");
    await mk("collision", "PK", null, "d_PK.txt");
    await mk("unknown_bureau_code", null, "XYZ", "e_XYZ9.txt");
    // No token to show: counted as left out
    await mk("unknown_token", null, null, "f.txt");
    // A breaking draft the log missed
    await breaking("छूटा");
    // breaking() sets the handle_pick only; mark the stories breaking for the coverage count
    await h.db.execute(sql`UPDATE stories SET layout = 'breaking' WHERE id IN (SELECT story_id FROM post_drafts WHERE handle_pick IS NOT NULL)`);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const report = await reporterStatusReport(h.db, s.org.id, { since });
    expect(report.rows.map((r) => [r.status, r.value, r.files])).toEqual([
      ["unknown_token", "RAMESH", 2],
      ["collision", "PK", 1],
      ["unknown_token", "SURESH", 1],
      ["unknown_bureau_code", "XYZ", 1],
    ]);
    expect(report.rows[0]!.example).toBe("b_RAMESH.txt");
    expect(report.dropped).toBe(1);
    // Three breaking drafts with no row: the two from the tests above (their rows were deleted here, or never
    // written) and the one the log missed
    expect(report.coverage.breakingDrafts - report.coverage.logged).toBe(3);
    expect((await reporterStatusReport(h.db, s.org.id, { since, limit: 1 })).rows).toHaveLength(3);
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

  /** A posted decision for the reporter with `handle` decided at `at`, with `items` on the final post */
  async function decided(
    handle: string | null, at: Date, items: string[], decision: "copy_posted" | "rejected" | "approved" = "copy_posted",
    outcomes: { source: string; outcome: string }[] = [], reporterStatus = "matched", token = handle?.toUpperCase() ?? "X",
  ) {
    const d = await s.draft("x");
    await h.db.insert(postDecisions).values({
      orgId: s.org.id, draftId: d.id, storyId: d.storyId, reporterToken: token, reporterHandle: handle, reporterStatus, logicVersion: LOGIC_VERSION,
      composeVersion: "t", draftText: "x", proposals: [], decision, decidedAt: at, finalText: items.join(" ") || "x",
      finalHashtags: items.filter((i) => i.startsWith("#")), finalHandles: items.filter((i) => i.startsWith("@")),
      itemOutcomes: outcomes.map((o) => ({ item: "@X", kind: "handle" as const, layer: "suggest" as const, source: o.source, outcome: o.outcome as "accepted" })),
      reworkRatio: 0.1,
    });
  }

  it("keyed by handle, smoothed toward the desk's rate with m = 20, from posted decisions in the 90 days before today (L5)", async () => {
    const yesterday = new Date("2026-11-12T10:00:00Z");
    // rituraj files under two tokens: one profile
    for (let i = 0; i < 2; i++) await decided("@Rituraj", yesterday, ["#Jaipur", "@RajGovOfficial"], "copy_posted", [{ source: "reporter_prior", outcome: "accepted" }], "matched", "RITURAJ");
    await decided("rituraj", yesterday, ["#Jaipur", "@RajGovOfficial"], "copy_posted", [{ source: "reporter_prior", outcome: "accepted" }], "matched", "RITU");
    await decided("@Rituraj", yesterday, ["#Jaipur"], "copy_posted", [{ source: "reporter_prior", outcome: "ignored" }], "matched", "RITURAJ");
    for (let i = 0; i < 6; i++) await decided("amit", yesterday, ["#Kota"]);
    // L5: decided after today began, so it must not count, however many
    for (let i = 0; i < 5; i++) await decided("rituraj", new Date(TODAY_START.getTime() + 60_000), ["@Leak"]);
    // Outside the 90-day window
    await decided("rituraj", new Date(TODAY_START.getTime() - 91 * 86_400_000), ["@Ancient"]);
    // A rejection says nothing about the tags the desk wanted
    await decided("rituraj", yesterday, ["@Rejected"], "rejected");
    // A token that names nobody (or two people) is no reporter's profile
    await decided(null, yesterday, ["#Kota"], "copy_posted", [], "unknown_token", "REPORTER");
    await decided(null, yesterday, ["#Kota"], "copy_posted", [], "collision", "DINESH");
    // An API post that never went out (no published_posts row) did not reach X
    await decided("rituraj", yesterday, ["@NeverSent"], "approved");

    const snap = await snapshotReporterFeatures(h.pool, s.org.id, NOW);
    expect(snap).toEqual({ day: "2026-11-13", written: 2, reporters: 2, pruned: 0 });
    const [rit] = await h.db.select().from(reporterFeatures).where(eq(reporterFeatures.reporter, "rituraj"));
    expect(rit).toMatchObject({ snapshotDate: "2026-11-13", n: 4 });
    const f = rit!.features;
    expect(f).toMatchObject({ m: 20, cutoff: TODAY_START.toISOString(), since: new Date(TODAY_START.getTime() - 90 * 86_400_000).toISOString(), itemsDropped: 0, reworkMean: 0.1 });
    // base 3/10; smoothed (3 + 20·0.3) / (4 + 20) = 0.375
    expect(f.items["@rajgovofficial"]).toEqual({ kind: "handle", count: 3, rate: 0.75, base: 0.3, smoothed: 0.375 });
    for (const k of ["@leak", "@ancient", "@rejected", "@neversent"]) expect(f.items[k]).toBeUndefined();
    // reporter_prior: 3 of 4 taken, desk-wide also 3/4 → smoothed stays 0.75
    expect(f.sources.reporter_prior).toEqual({ proposed: 4, taken: 3, rate: 0.75, base: 0.75, smoothed: 0.75 });
    expect((await h.db.select().from(reporterFeatures)).map((r) => r.reporter).sort()).toEqual(["amit", "rituraj"]);
  });

  it("caps a reporter at 200 items by count", async () => {
    const yesterday = new Date("2026-11-12T11:00:00Z");
    const many = Array.from({ length: 205 }, (_, i) => `#T${i}`);
    await decided("prolific", yesterday, many);
    await decided("prolific", yesterday, ["#T0", "#T1"]);
    const snap = await snapshotReporterFeatures(h.pool, s.org.id, new Date(NOW.getTime() + 86_400_000));
    expect(snap.written).toBe(3);
    const [p] = await h.db.select().from(reporterFeatures).where(and(eq(reporterFeatures.reporter, "prolific"), eq(reporterFeatures.snapshotDate, "2026-11-14")));
    expect(Object.keys(p!.features.items)).toHaveLength(200);
    expect(p!.features.itemsDropped).toBe(5);
    expect(p!.features.items["#t0"]!.count).toBe(2);
  });

  it("never overwrites a day's snapshot; keeps 90 days; an UPDATE is refused", async () => {
    await decided("newcomer", new Date("2026-11-12T11:00:00Z"), ["#Ajmer"]);
    // Same day as the first test: the existing rows are kept; only the reporters who had none get one
    const again = await snapshotReporterFeatures(h.pool, s.org.id, NOW);
    expect(again).toMatchObject({ written: 2, reporters: 4 });
    const [rit] = await h.db.select().from(reporterFeatures).where(and(eq(reporterFeatures.reporter, "rituraj"), eq(reporterFeatures.snapshotDate, "2026-11-13")));
    expect(rit!.n).toBe(4);
    await refused(h.db.execute(sql`UPDATE reporter_features SET n = 99`), /never overwritten/);
    // 91 days on, the 2026-11-13 snapshot is past the retention and goes
    const later = await snapshotReporterFeatures(h.pool, s.org.id, new Date(NOW.getTime() + 91 * 86_400_000));
    expect(later.pruned).toBeGreaterThan(0);
    expect(await h.db.select().from(reporterFeatures).where(eq(reporterFeatures.snapshotDate, "2026-11-13"))).toEqual([]);
  });

  it("two runs at once take turns (advisory lock) and write each row once", async () => {
    await decided("racer", new Date("2026-11-12T12:00:00Z"), ["#Race"]);
    const day = new Date(NOW.getTime() + 2 * 86_400_000);
    const [a, b] = await Promise.all([snapshotReporterFeatures(h.pool, s.org.id, day), snapshotReporterFeatures(h.pool, s.org.id, day)]);
    expect(a.written + b.written).toBe(a.reporters);
    expect(a.reporters).toBe(b.reporters);
  });

  it("counts a Devanagari tag stored in NFC and in NFD as one item (normalize NFC, then lower case)", async () => {
    const yesterday = new Date("2026-11-14T10:00:00Z");
    // क़ (U+0958) precomposed and क + nukta; ऩ (U+0929) composed and न + nukta
    const qanoon = "#क़ानून";
    const qanoonNfd = qanoon.normalize("NFD");
    const naya = "#ऩया";
    const nayaNfd = naya.normalize("NFD");
    expect(qanoonNfd).not.toBe(qanoon);
    expect(nayaNfd).not.toBe(naya);
    await decided("unicode", yesterday, [qanoon, naya]);
    await decided("unicode", yesterday, [qanoonNfd, nayaNfd, "#UPPER"]);
    await decided("unicode", yesterday, ["#upper"]);
    await snapshotReporterFeatures(h.pool, s.org.id, new Date(NOW.getTime() + 2 * 86_400_000 + 86_400_000));
    const [u] = await h.db.select().from(reporterFeatures).where(and(eq(reporterFeatures.reporter, "unicode"), eq(reporterFeatures.snapshotDate, "2026-11-16")));
    expect(u!.n).toBe(3);
    const keys = Object.keys(u!.features.items).sort();
    expect(keys).toEqual([itemKey(qanoon), itemKey(naya), "#upper"].sort());
    // The key is the one itemKey() gives the post text, whichever form was stored
    expect(itemKey(qanoonNfd)).toBe(itemKey(qanoon));
    expect(u!.features.items[itemKey(qanoon)]).toMatchObject({ count: 2, rate: round4(2 / 3) });
    expect(u!.features.items[itemKey(naya)]).toMatchObject({ count: 2 });
    expect(u!.features.items["#upper"]).toMatchObject({ count: 2 });
  });

  it("is one consistent snapshot: a decision committed between its reads is in none of its numbers", async () => {
    // Two reporters with known rows, decided before the snapshot's day (2026-11-18 IST) began
    const before = new Date("2026-11-17T08:00:00Z");
    for (let i = 0; i < 3; i++) await decided("iso_a", before, ["#IsoOnly", "@IsoHandle"], "copy_posted", [{ source: "iso_rule", outcome: "accepted" }]);
    await decided("iso_a", before, ["#IsoOther"], "copy_posted", [{ source: "iso_rule", outcome: "ignored" }]);
    await decided("iso_b", before, ["#IsoOther"]);
    const day = new Date("2026-11-18T04:30:00Z");

    let committed = 0;
    const snap = await snapshotReporterFeatures(h.pool, s.org.id, day, 20, {
      betweenReads: async () => {
        // On another connection, committed: more of iso_a's items and outcomes, and a reporter who was not there
        for (let i = 0; i < 4; i++) await decided("iso_a", before, ["#IsoOnly", "@IsoHandle", "#IsoLate"], "copy_posted", [{ source: "iso_rule", outcome: "ignored" }]);
        await decided("iso_new", before, ["#IsoOnly", "#IsoOther"], "copy_posted", [{ source: "iso_rule", outcome: "accepted" }]);
        committed = (await h.db.select().from(postDecisions).where(eq(postDecisions.reporterHandle, "iso_a"))).length;
      },
    });
    // The rows were really there, committed, while the snapshot read
    expect(committed).toBe(8);

    const rows = await h.db.select().from(reporterFeatures).where(eq(reporterFeatures.snapshotDate, "2026-11-18"));
    expect(snap.written).toBe(rows.length);
    expect(rows.map((r) => r.reporter)).not.toContain("iso_new");
    const total = rows.reduce((a, r) => a + r.n, 0);
    const a = rows.find((r) => r.reporter === "iso_a")!;
    expect(a.n).toBe(4);
    const f = a.features;
    // iso_a's own counts are those of its 4 rows; nothing from the 5 committed between the reads
    expect(f.items["#isoonly"]).toEqual({ kind: "hashtag", count: 3, rate: 0.75, base: round4(3 / total), smoothed: round4((3 + 20 * (3 / total)) / (4 + 20)) });
    expect(f.items["@isohandle"]).toMatchObject({ count: 3 });
    expect(f.items["#isoother"]).toMatchObject({ count: 1, base: round4(2 / total) });
    expect(f.items["#isolate"]).toBeUndefined();
    expect(f.sources.iso_rule).toEqual({ proposed: 4, taken: 3, rate: 0.75, base: 0.75, smoothed: 0.75 });
    // Every reporter's numbers agree with the reporters read: no item counted more often than its reporter posted
    for (const r of rows) for (const it of Object.values(r.features.items)) expect(it.count).toBeLessThanOrEqual(r.n);

    // The next day's snapshot sees them all
    await snapshotReporterFeatures(h.pool, s.org.id, new Date(day.getTime() + 86_400_000));
    const [next] = await h.db.select().from(reporterFeatures).where(and(eq(reporterFeatures.reporter, "iso_a"), eq(reporterFeatures.snapshotDate, "2026-11-19")));
    expect(next!.n).toBe(8);
    expect(next!.features.items["#isolate"]).toMatchObject({ count: 4 });
    expect(next!.features.sources.iso_rule).toMatchObject({ proposed: 8, taken: 3 });
    expect((await h.db.select().from(reporterFeatures).where(and(eq(reporterFeatures.reporter, "iso_new"), eq(reporterFeatures.snapshotDate, "2026-11-19")))).length).toBe(1);
  });
});
