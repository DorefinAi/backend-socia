// The learning fix's database half without a database: which handles a post teaches (typedHandles, rule 1) and the
// cleanup of what the old loop learned (src/learn-cleanup.ts, scripts/learn-cleanup.ts --from-json). The fixtures are
// shaped like the live rows the audit found, cut down.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlaceBook, PostedLearner, parseHandleRules, parsePlacesData, parseSubjectHandles } from "@socia/core";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/client";
import { typedHandles } from "../src/learn";
import {
  applyLearnCleanup, describeLearnCleanup, evidenceFromDecisions, planLearnCleanup, type CleanupAuditRow, type CleanupChange, type CleanupEvidenceRow, type CleanupSnapshot,
} from "../src/learn-cleanup";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const subjects = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
const learner = new PostedLearner({
  book: new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json"))),
  subjects,
  fileHandles: [...(parseHandleRules(json("../../../apps/worker/config/district-handles.json")).all ?? []), ...(subjects.handles ?? [])],
});

describe("rule 1: only the handles the desk typed teach", () => {
  const pick = (handles: string[], suggested: string[] = []) => ({
    cls: "other" as const, why: "", warnings: [], handles: handles.map((handle) => ({ handle, reason: "desk" as const })), suggested: suggested.map((handle) => ({ handle, reason: "desk" as const })),
  });
  it("never one the composer put on the post (@jpr_rural emitted) or offered and the desk took (@NitinNabin)", () => {
    const draft = { mentions: ["@jpr_rural", "@NitinNabin", "@forestRajasthan", "@ForestRajasthan"], handlePick: pick(["@jpr_rural"], ["@NitinNabin"]) };
    expect(typedHandles(draft)).toEqual(["forestrajasthan"]);
  });
  it("never one the decision log says was emitted or accepted, nor an accepted old mention suggestion", () => {
    const draft = { mentions: ["@JaipurDiscom1", "@JDAJaipur", "@BalotraPolice", "@KotaNewsDesk"], handlePick: pick([]), mentionSuggestions: [{ handleId: "h", entity: "JDA", handle: "@JDAJaipur", exact: true }] };
    expect(typedHandles(draft, [{ item: "@jaipurdiscom1", layer: "emit" }, { item: "@KotaNewsDesk", layer: "suggest" }])).toEqual(["balotrapolice"]);
  });
  it("an offered suggestion the desk did not post plays no part; malformed entries never throw", () => {
    const draft = { mentions: ["@BalotraPolice", 7 as unknown as string], handlePick: pick([], ["@Unposted"]) };
    expect(typedHandles(draft, [{ item: "@NotOnPost", layer: "suggest" }])).toEqual(["balotrapolice"]);
  });
  it("a draft with no handle pick: every mention it has is the desk's", () => {
    expect(typedHandles({ mentions: ["@a_b", "a_b"], handlePick: null })).toEqual(["a_b"]);
  });
});

// ─── The cleanup ─────────────────────────────────────────────────────────────

const ORG = "org-1";
const V = "2026-11-14T08:16:14.649Z";
const h = (id: string, handle: string, aliases: string[], source = "desk", verified: string | null = V, entityType: string | null = null) => ({
  id, org_id: ORG, handle, aliases, source, verified_at: verified, verified_by: verified ? "user-1" : null, entity_type: entityType,
});
const learned = (entityId: string, handle: string, before: string[], added: string[], at: string, draftId: string): CleanupAuditRow => ({
  org_id: ORG, action: "handle.keywords_learned", entity_type: "handle", entity_id: entityId, at,
  before: { handle, aliases: before }, after: { handle, aliases: [...before, ...added], added, draftId },
});
const ev = (draftId: string, headline: string, district: string | null, town: string | null, typed: string[], body = ""): CleanupEvidenceRow => ({ draft_id: draftId, headline, body, district, town, typed });
const rule = (id: string, tag: string, name: string, aliases: string[], active: boolean, priority = 1) => ({ id, org_id: ORG, name, aliases, hashtag_latin: tag, hashtag_devanagari: null, priority, active });
const ruleLearned = (id: string, at = "2026-11-21T06:49:22.104Z"): CleanupAuditRow => ({ org_id: ORG, action: "hashtag.rule_learned", entity_type: "hashtag_rule", entity_id: id, before: null, after: {}, at });

const JPR_ADDED_1 = ["Jaipur", "जयपुर", "बस्सी"];
const JPR_ADDED_2 = ["Air India", "एयर इंडिया", "Hyderabad", "हैदराबाद", "IndiGo", "इंडिगो"];
const JPR_ADDED_3 = ["Jhalawar", "झालावाड़", "जोबनेर"];
const DISCOM_BEFORE = ["Jaipur Discom", "जयपुर डिस्कॉम", "जेवीवीएनएल"];
const DISCOM_ADDED = ["Jaipur", "जयपुर", "Mumbai", "मुंबई", "IndiGo", "इंडिगो", "Jodhpur", "जोधपुर", "CMO Rajasthan"];
const NITIN_ADDED = ["Delhi", "दिल्ली", "Telangana", "तेलंगाना", "Punjab", "पंजाब", "Jaipur", "जयपुर", "Amit Shah"];
const CHAKSU_ADDED = ["Jaipur", "जयपुर", "चाकसू", "Mumbai", "मुंबई"];

const snapshot = (): CleanupSnapshot => ({
  handles: [
    h("jpr", "jpr_rural", [...JPR_ADDED_1, ...JPR_ADDED_2, ...JPR_ADDED_3]),
    h("discom", "JaipurDiscom1", [...DISCOM_BEFORE, ...DISCOM_ADDED]),
    h("nitin", "NitinNabin", NITIN_ADDED),
    // A local handle (no district in its name, not marked): keeps its desk-typed story's own district and town
    h("chaksu", "ChaksuNews", CHAKSU_ADDED),
    // Marked a person by an editor: keeps no place
    h("person", "SomePersonDesk", ["Jaipur", "जयपुर"], "desk", V, "person"),
    h("hbh", "hbh", ["Bundi", "बूंदी", "Jaipur", "जयपुर", "Kota", "कोटा"]),
    h("nwr", "nwr", ["Churu", "चूरू", "Kolkata", "कोलकाता"]),
    h("nwrailways", "NWRailways", []),
    h("forest", "forest", ["Tonk", "टोंक", "Jaipur", "जयपुर", "Forest Department"]),
    h("forestraj", "forestRajasthan", []),
    h("khirthal", "Khirthalpolice", []),
    h("khairthal", "khairthalpolice", []),
    // An editor typed Kota on it in Settings: explicit config, kept although it is outside Jhalawar
    h("jhalawar", "JhalawarUpdates", ["Jhalawar", "झालावाड़", "Kota"]),
    // Mumbai and Tonk were learned, then an editor saved the row in Settings with them: the editor's now
    h("kotadesk", "KotaNewsDesk", ["Kota", "कोटा", "Mumbai", "Tonk"]),
    h("rep", "@satyatv99", ["SATYA"], "reporter"),
    h("unverified", "OldDeskRow", ["Mumbai"], "desk", null),
  ],
  rules: [
    rule("panchayat", "RajasthanPanchayatElection2026", "Jaipur", ["जयपुर", "Hanumangarh", "हनुमानगढ़", "Panchayat", "Election", "Rahul Gandhi", "राहुल गांधी"], true),
    rule("balotra", "Balotrapolice", "Baran", ["बारां", "Balotra", "बालोतरा", "Balotrapolice"], false),
    rule("bbhbh", "bbhbh", "Bundi", ["बूंदी", "Kota"], false),
    rule("rajpolice", "RajasthanPolice", "Police", [], true),
    rule("jaisalmer", "Jaisalmer", "Jaisalmer", ["जैसलमेर"], true),
    rule("modi", "NarendraModi", "Narendra Modi", ["नरेंद्र मोदी"], true),
    rule("edited", "PanchayatChunav", "Jodhpur", ["जोधपुर", "Chunav"], true),
    rule("editor", "BombThreat", "Jaipur", ["बम की धमकी"], true, 8),
  ],
  audit: [
    learned("jpr", "@jpr_rural", [], JPR_ADDED_1, "2026-11-21T06:49:22.104Z", "d-jpr-1"),
    learned("jpr", "@jpr_rural", [...JPR_ADDED_1], JPR_ADDED_2, "2026-11-22T06:49:22.104Z", "d-jpr-2"),
    learned("jpr", "@jpr_rural", [...JPR_ADDED_1, ...JPR_ADDED_2], JPR_ADDED_3, "2026-11-23T06:49:22.104Z", "d-jpr-3"),
    learned("discom", "@JaipurDiscom1", DISCOM_BEFORE, DISCOM_ADDED, "2026-11-22T06:49:22.104Z", "d-discom"),
    learned("nitin", "@NitinNabin", [], NITIN_ADDED, "2026-11-22T06:49:22.104Z", "d-nitin"),
    learned("chaksu", "@ChaksuNews", [], CHAKSU_ADDED, "2026-11-22T06:49:22.104Z", "d-chaksu"),
    learned("person", "@SomePersonDesk", [], ["Jaipur", "जयपुर"], "2026-11-22T06:49:22.104Z", "d-chaksu"),
    learned("kotadesk", "@KotaNewsDesk", ["Kota", "कोटा"], ["Mumbai", "Tonk"], "2026-11-22T06:49:22.104Z", "d-missing"),
    { org_id: ORG, action: "handle.update", entity_type: "handle", entity_id: "kotadesk", before: null, after: null, at: "2026-11-23T00:00:00Z" },
    ruleLearned("panchayat"), ruleLearned("balotra"), ruleLearned("bbhbh"), ruleLearned("rajpolice"), ruleLearned("jaisalmer"), ruleLearned("modi"), ruleLearned("edited"),
    { org_id: ORG, action: "hashtag_rule.update", entity_type: "hashtag_rule", entity_id: "edited", before: null, after: null, at: "2026-11-23T00:00:00Z" },
  ],
  evidence: [
    // Typed by the desk on a Jaipur story with its town on the place line
    ev("d-jpr-1", "बस्सी में हादसा", "Jaipur", "बस्सी", ["jpr_rural"]),
    // The composer emitted @jpr_rural here (not typed): teaches nothing
    ev("d-jpr-2", "एयर इंडिया की उड़ान", "Jaipur", null, [], "हैदराबाद से IndiGo"),
    ev("d-jpr-3", "जोबनेर में मेला", "Jaipur", "जोबनेर", ["jpr_rural"], "झालावाड़ की टीम"),
    ev("d-discom", "JVVNL ने बिजली काटी", "Jaipur", null, ["jaipurdiscom1"], "मुंबई की IndiGo उड़ान, जोधपुर"),
    ev("d-nitin", "दिल्ली में बैठक", "Delhi", "दिल्ली", ["nitinnabin"], "तेलंगाना, पंजाब, जयपुर"),
    ev("d-chaksu", "चाकसू में हादसा", "Jaipur", null, ["chaksunews", "somepersondesk"], "मुंबई से आई टीम"),
  ],
});

const of = <K extends CleanupChange["kind"]>(changes: CleanupChange[], kind: K, id: string) => changes.find((c): c is Extract<CleanupChange, { kind: K }> => c.kind === kind && c.id === id);

describe("learn-cleanup: the plan", () => {
  const plan = planLearnCleanup(snapshot(), learner);

  it("re-runs the learning on @jpr_rural's desk-typed drafts: keeps Jaipur, बस्सी, जोबनेर; drops Air India, Hyderabad, Jhalawar", () => {
    const c = of(plan.changes, "handle.keywords_restored", "jpr")!;
    expect(c.after).toEqual(["Jaipur", "जयपुर", "बस्सी", "जोबनेर"]);
    expect(c.removed).toEqual(expect.arrayContaining(["Air India", "Hyderabad", "IndiGo", "Jhalawar", "झालावाड़"]));
    expect(c.prePollution).toEqual([]);
  });

  it("restores @JaipurDiscom1 to its pre-pollution names (a subject's handle keeps no place, not even Jaipur)", () => {
    expect(of(plan.changes, "handle.keywords_restored", "discom")!.after).toEqual(DISCOM_BEFORE);
  });

  it("empties @NitinNabin: typed only on a Delhi story, nothing from the body", () => {
    expect(of(plan.changes, "handle.keywords_restored", "nitin")!.after).toEqual([]);
  });

  it("a local handle keeps exactly what the learner gives on the same evidence (@ChaksuNews: Jaipur, चाकसू; not Mumbai)", () => {
    const c = of(plan.changes, "handle.keywords_restored", "chaksu")!;
    const story = snapshot().evidence!.find((e) => e.draft_id === "d-chaksu")!;
    const learnt = learner.learnable("ChaksuNews", [story], { directory: snapshot().handles.map((x) => x.handle) }).names;
    expect(learnt).toEqual(["Jaipur", "जयपुर", "चाकसू"]);
    expect(c.after).toEqual(learnt);
  });

  it("a handle an editor marked a person keeps no learned place, as the learner gives none", () => {
    expect(of(plan.changes, "handle.keywords_restored", "person")!.after).toEqual([]);
    const story = snapshot().evidence!.find((e) => e.draft_id === "d-chaksu")!;
    expect(learner.learnable("SomePersonDesk", [story], { type: "person" }).names).toEqual([]);
  });

  it("retires @hbh, @nwr and @forest; merges Khirthalpolice into khairthalpolice", () => {
    expect(plan.changes.filter((c) => c.kind === "handle.retired").map((c) => c.handle).sort()).toEqual(["@forest", "@hbh", "@nwr"]);
    const m = of(plan.changes, "handle.merged", "khirthal")!;
    expect(m.into).toMatchObject({ id: "khairthal", handle: "@khairthalpolice" });
    // A retired or merged handle gets no separate alias restore
    for (const id of ["hbh", "nwr", "forest", "khirthal"]) expect(of(plan.changes, "handle.keywords_restored", id)).toBeUndefined();
  });

  it("keeps an editor's aliases: typed in Settings, or learned and then saved by an editor (handle.update)", () => {
    expect(of(plan.changes, "handle.keywords_restored", "jhalawar")).toBeUndefined();
    expect(of(plan.changes, "handle.keywords_restored", "kotadesk")).toBeUndefined();
  });

  it("leaves clean, reporter and unverified rows alone", () => {
    for (const id of ["jhalawar", "kotadesk", "rep", "unverified", "forestraj", "nwrailways", "khairthal"]) expect(plan.changes.filter((c) => c.id === id && c.kind !== "handle.merged")).toEqual([]);
  });

  it("#RajasthanPanchayatElection2026 keeps only what the learning gives it: Panchayat, Election (no places, no Gandhi)", () => {
    const c = of(plan.changes, "hashtag.rule_cleaned", "panchayat")!;
    expect(c.after).toEqual({ name: "Panchayat", aliases: ["Election"], active: true });
    expect(c.removed).toEqual(["Jaipur", "जयपुर", "Hanumangarh", "हनुमानगढ़", "Rahul Gandhi", "राहुल गांधी"]);
  });

  it("switches off and empties #Balotrapolice (@BalotraPolice exists); never a topic like #RajasthanPolice", () => {
    expect(of(plan.changes, "hashtag.rule_deactivated", "balotra")!.after).toEqual({ name: "Balotrapolice", aliases: [], active: false });
    expect(plan.changes.filter((c) => c.id === "rajpolice")).toEqual([]);
    expect(of(plan.changes, "hashtag.rule_cleaned", "bbhbh")!.after).toEqual({ name: "bbhbh", aliases: [], active: false });
  });

  it("never touches a known tag's rule (#Jaisalmer, #NarendraModi), an editor-changed one, or an editor's own", () => {
    for (const id of ["jaisalmer", "modi", "edited", "editor"]) expect(plan.changes.filter((c) => c.id === id)).toEqual([]);
  });

  it("notes the lookalikes and the drafts it had no evidence for", () => {
    expect(plan.lookalikes).toEqual(expect.arrayContaining([
      { orgId: ORG, handle: "@forest", like: "@forestRajasthan" },
      { orgId: ORG, handle: "@nwr", like: "@NWRailways" },
      { orgId: ORG, handle: "@Khirthalpolice", like: "@khairthalpolice" },
    ]));
    expect(plan.notes).toEqual([]);
    // Without a learned row's draft, what it taught is not kept, and the plan says so
    const snap = snapshot();
    snap.evidence = snap.evidence!.filter((e) => e.draft_id !== "d-jpr-1");
    const thin = planLearnCleanup(snap, learner);
    expect(thin.notes).toEqual(["1 draft(s) named by learned audit rows are not in the evidence: what they taught is not kept"]);
    expect(of(thin.changes, "handle.keywords_restored", "jpr")!.after).toEqual(["Jaipur", "जयपुर", "जोबनेर"]);
  });

  it("describes every change for the dry run", () => {
    const text = describeLearnCleanup(plan).join("\n");
    expect(text).toContain("Changes: 12 (handle aliases restored 5, handles retired 3, merged 1, hashtag rules cleaned 2, deactivated 1)");
    expect(text).toContain("@jpr_rural: 12 -> 4 aliases");
  });

  it("is idempotent: planning again over the cleaned rows finds nothing", () => {
    const snap = snapshot();
    for (const c of plan.changes) {
      const row = snap.handles.find((x) => x.id === c.id);
      if (c.kind === "handle.keywords_restored" && row) row.aliases = c.after;
      if ((c.kind === "handle.retired" || c.kind === "handle.merged") && row) Object.assign(row, { aliases: [], verified_at: null });
      const r = snap.rules.find((x) => x.id === c.id);
      if ((c.kind === "hashtag.rule_cleaned" || c.kind === "hashtag.rule_deactivated") && r) Object.assign(r, c.after);
    }
    expect(planLearnCleanup(snap, learner).changes).toEqual([]);
  });
});

describe("learn-cleanup: a typo whose right handle is not a desk row", () => {
  it("still retires the typo and says so (KhairthalPolice is a data-file handle)", () => {
    const snap = snapshot();
    snap.handles = snap.handles.filter((x) => x.id !== "khairthal");
    const plan = planLearnCleanup(snap, learner);
    const m = of(plan.changes, "handle.merged", "khirthal")!;
    expect(m.into).toMatchObject({ id: null, handle: "@khairthalpolice", after: [] });
    expect(plan.notes.some((n) => n.includes("@khairthalpolice is not a verified desk row"))).toBe(true);
    expect(describeLearnCleanup(plan).join("\n")).toContain("@Khirthalpolice -> @khairthalpolice: typo retired; @khairthalpolice is not a desk row, nothing moved");
  });
  it("a listed typo the directory does not have is noted, never skipped silently", () => {
    const snap = snapshot();
    snap.handles = snap.handles.filter((x) => x.id !== "khirthal");
    expect(planLearnCleanup(snap, learner).notes).toContain("merge @Khirthalpolice -> @khairthalpolice: @Khirthalpolice is not a verified desk row here; nothing to retire");
  });
});

describe("learn-cleanup: applying the plan", () => {
  it("writes each change and one audit row per change (script actor, before with the old verification, after)", async () => {
    const plan = planLearnCleanup(snapshot(), learner);
    const updates: { set: Record<string, unknown> }[] = [];
    const audits: Record<string, unknown>[] = [];
    const fake = {
      update: () => ({ set: (set: Record<string, unknown>) => ({ where: async () => void updates.push({ set }) }) }),
      insert: () => ({ values: async (v: Record<string, unknown>) => void audits.push(v) }),
    } as unknown as Executor;
    const n = await applyLearnCleanup(fake, plan);
    expect(n).toBe(plan.changes.length);
    expect(audits).toHaveLength(plan.changes.length);
    expect(updates).toHaveLength(plan.changes.length);
    for (const a of audits) expect(a).toMatchObject({ orgId: ORG, actorId: null, actor: "script:learn-cleanup" });
    expect(audits.find((a) => a.entityId === "jpr")).toMatchObject({
      action: "handle.keywords_restored", entityType: "handle", before: { handle: "@jpr_rural", verifiedAt: V, verifiedBy: "user-1" }, after: { aliases: ["Jaipur", "जयपुर", "बस्सी", "जोबनेर"] },
    });
    expect(audits.find((a) => a.entityId === "hbh")).toMatchObject({ action: "handle.retired", before: { verifiedAt: V, verifiedBy: "user-1" }, after: { verified: false } });
    expect(audits.find((a) => a.entityId === "balotra")).toMatchObject({ action: "hashtag.rule_deactivated", entityType: "hashtag_rule" });
    // A retired handle is unverified (never suggested, the worker reloads); a restored one gets a fresh reload stamp
    expect(updates.filter((u) => u.set.verifiedAt === null)).toHaveLength(4);
  });
});

describe("evidence from a post_decisions export", () => {
  it("takes the post's first line as the headline and desk_added handles as typed", () => {
    expect(evidenceFromDecisions([{
      draft_id: "d", district: "Jaipur", town: null, final_text: "चाकसू में हादसा\n\nमुंबई की टीम\n\n@ChaksuNews @jpr_rural",
      item_outcomes: [{ item: "@ChaksuNews", kind: "handle", outcome: "desk_added" }, { item: "@jpr_rural", kind: "handle", outcome: "kept" }, { item: 3 }],
    }])).toEqual([{ draft_id: "d", headline: "चाकसू में हादसा", body: "\nमुंबई की टीम\n\n@ChaksuNews @jpr_rural", district: "Jaipur", town: null, typed: ["chaksunews"] }]);
  });
});

describe("scripts/learn-cleanup.ts --from-json", () => {
  it("prints the dry run of exported tables (with the decisions export as evidence) without a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-cleanup-"));
    try {
      const snap = snapshot();
      writeFileSync(join(dir, "handle_directory.json"), JSON.stringify(snap.handles));
      writeFileSync(join(dir, "hashtag_rules.json"), JSON.stringify(snap.rules));
      writeFileSync(join(dir, "audit_learning.json"), JSON.stringify(snap.audit));
      const decisions = snap.evidence!.map((e) => ({
        draft_id: e.draft_id, district: e.district, town: e.town, final_text: `${e.headline}\n${e.body}`,
        item_outcomes: e.typed.map((t) => ({ item: `@${t}`, kind: "handle", outcome: "desk_added" })),
      }));
      writeFileSync(join(dir, "decisions_test.json"), JSON.stringify(decisions));
      const script = fileURLToPath(new URL("../scripts/learn-cleanup.ts", import.meta.url));
      const env = { ...process.env, DATABASE_URL: "" };
      const out = execFileSync(process.execPath, ["--import", "tsx", script, "--from-json", dir], { encoding: "utf8", env, cwd: fileURLToPath(new URL("..", import.meta.url)) });
      expect(out).toContain("DRY RUN (nothing written)");
      expect(out).toContain("Changes: 12");
      expect(out).toContain("@jpr_rural: 12 -> 4 aliases");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
