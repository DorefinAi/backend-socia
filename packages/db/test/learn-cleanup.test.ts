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
import { applyLearnCleanup, describeLearnCleanup, planLearnCleanup, type CleanupAuditRow, type CleanupChange, type CleanupSnapshot } from "../src/learn-cleanup";

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
  it("never one the decision log proposed, nor an old mention suggestion", () => {
    const draft = { mentions: ["@JaipurDiscom1", "@JDAJaipur", "@BalotraPolice"], handlePick: pick([]), mentionSuggestions: [{ handleId: "h", entity: "JDA", handle: "@JDAJaipur", exact: true }] };
    expect(typedHandles(draft, ["@jaipurdiscom1"])).toEqual(["balotrapolice"]);
  });
  it("a draft with no handle pick: every mention it has is the desk's", () => {
    expect(typedHandles({ mentions: ["@a_b", "a_b"], handlePick: null })).toEqual(["a_b"]);
  });
});

// ─── The cleanup ─────────────────────────────────────────────────────────────

const ORG = "org-1";
const V = "2026-11-14T08:16:14.649Z";
const h = (id: string, handle: string, aliases: string[], source = "desk", verified: string | null = V) => ({ id, org_id: ORG, handle, aliases, source, verified_at: verified });
const learned = (entityId: string, handle: string, before: string[], added: string[], at: string): CleanupAuditRow => ({
  org_id: ORG, action: "handle.keywords_learned", entity_type: "handle", entity_id: entityId, at,
  before: { handle, aliases: before }, after: { handle, aliases: [...before, ...added], added, draftId: "d" },
});
const rule = (id: string, tag: string, name: string, aliases: string[], active: boolean, priority = 1) => ({ id, org_id: ORG, name, aliases, hashtag_latin: tag, hashtag_devanagari: null, priority, active });
const ruleLearned = (id: string, at = "2026-11-21T06:49:22.104Z"): CleanupAuditRow => ({ org_id: ORG, action: "hashtag.rule_learned", entity_type: "hashtag_rule", entity_id: id, before: null, after: {}, at });

const JPR_BEFORE: string[] = [];
const JPR_ADDED_1 = ["Jaipur", "जयपुर", "बस्सी"];
const JPR_ADDED_2 = ["Air India", "एयर इंडिया", "Hyderabad", "हैदराबाद", "IndiGo", "इंडिगो"];
const JPR_ADDED_3 = ["Jhalawar", "झालावाड़", "जोबनेर"];
const DISCOM_BEFORE = ["Jaipur Discom", "जयपुर डिस्कॉम", "जेवीवीएनएल"];
const DISCOM_ADDED = ["Jaipur", "जयपुर", "Mumbai", "मुंबई", "IndiGo", "इंडिगो", "Jodhpur", "जोधपुर", "CMO Rajasthan"];
const NITIN_ADDED = ["Delhi", "दिल्ली", "Telangana", "तेलंगाना", "Punjab", "पंजाब", "Jaipur", "जयपुर", "Amit Shah"];

const snapshot = (): CleanupSnapshot => ({
  handles: [
    h("jpr", "jpr_rural", [...JPR_BEFORE, ...JPR_ADDED_1, ...JPR_ADDED_2, ...JPR_ADDED_3]),
    h("discom", "JaipurDiscom1", [...DISCOM_BEFORE, ...DISCOM_ADDED]),
    h("nitin", "NitinNabin", NITIN_ADDED),
    h("hbh", "hbh", ["Bundi", "बूंदी", "Jaipur", "जयपुर", "Kota", "कोटा"]),
    h("nwr", "nwr", ["Churu", "चूरू", "Kolkata", "कोलकाता"]),
    h("nwrailways", "NWRailways", []),
    h("forest", "forest", ["Tonk", "टोंक", "Jaipur", "जयपुर", "Forest Department"]),
    h("forestraj", "forestRajasthan", []),
    h("khirthal", "Khirthalpolice", []),
    h("khairthal", "khairthalpolice", []),
    h("jhalawar", "JhalawarUpdates", ["Jhalawar", "झालावाड़"]),
    h("rep", "@satyatv99", ["SATYA"], "reporter"),
    h("unverified", "OldDeskRow", ["Mumbai"], "desk", null),
  ],
  rules: [
    rule("panchayat", "RajasthanPanchayatElection2026", "Jaipur", ["जयपुर", "Hanumangarh", "हनुमानगढ़", "Panchayat", "Election", "Rahul Gandhi", "राहुल गांधी"], true),
    rule("balotra", "Balotrapolice", "Baran", ["बारां", "Balotra", "बालोतरा", "Balotrapolice"], false),
    rule("bbhbh", "bbhbh", "Bundi", ["बूंदी", "Kota"], false),
    rule("jaisalmer", "Jaisalmer", "Jaisalmer", ["जैसलमेर"], true),
    rule("modi", "NarendraModi", "Narendra Modi", ["नरेंद्र मोदी"], true),
    rule("edited", "PanchayatChunav", "Jodhpur", ["जोधपुर", "Chunav"], true),
    rule("editor", "BombThreat", "Jaipur", ["बम की धमकी"], true, 8),
  ],
  audit: [
    learned("jpr", "@jpr_rural", JPR_BEFORE, JPR_ADDED_1, "2026-11-21T06:49:22.104Z"),
    learned("jpr", "@jpr_rural", [...JPR_ADDED_1], JPR_ADDED_2, "2026-11-22T06:49:22.104Z"),
    learned("jpr", "@jpr_rural", [...JPR_ADDED_1, ...JPR_ADDED_2], JPR_ADDED_3, "2026-11-23T06:49:22.104Z"),
    learned("discom", "@JaipurDiscom1", DISCOM_BEFORE, DISCOM_ADDED, "2026-11-22T06:49:22.104Z"),
    learned("nitin", "@NitinNabin", [], NITIN_ADDED, "2026-11-22T06:49:22.104Z"),
    ruleLearned("panchayat"), ruleLearned("balotra"), ruleLearned("bbhbh"), ruleLearned("jaisalmer"), ruleLearned("modi"), ruleLearned("edited"),
    { org_id: ORG, action: "hashtag_rule.update", entity_type: "hashtag_rule", entity_id: "edited", before: null, after: null, at: "2026-11-23T00:00:00Z" },
  ],
});

const of = <K extends CleanupChange["kind"]>(changes: CleanupChange[], kind: K, id: string) => changes.find((c): c is Extract<CleanupChange, { kind: K }> => c.kind === kind && c.id === id);

describe("learn-cleanup: the plan", () => {
  const plan = planLearnCleanup(snapshot(), learner);

  it("restores @jpr_rural to its own Jaipur names: drops Air India, Hyderabad, IndiGo and Jhalawar, keeps जोबनेर", () => {
    const c = of(plan.changes, "handle.keywords_restored", "jpr")!;
    expect(c.after).toEqual(["Jaipur", "जयपुर", "बस्सी", "जोबनेर"]);
    expect(c.removed).toEqual(expect.arrayContaining(["Air India", "Hyderabad", "IndiGo", "Jhalawar", "झालावाड़"]));
    expect(c.prePollution).toEqual([]);
  });

  it("restores @JaipurDiscom1 to its pre-pollution names (a subject's handle keeps no place, not even Jaipur)", () => {
    expect(of(plan.changes, "handle.keywords_restored", "discom")!.after).toEqual(DISCOM_BEFORE);
  });

  it("empties @NitinNabin: a person's handle keeps no place and no one else's name", () => {
    expect(of(plan.changes, "handle.keywords_restored", "nitin")!.after).toEqual([]);
  });

  it("retires @hbh, @nwr and @forest; merges Khirthalpolice into khairthalpolice", () => {
    expect(plan.changes.filter((c) => c.kind === "handle.retired").map((c) => c.handle).sort()).toEqual(["@forest", "@hbh", "@nwr"]);
    const m = of(plan.changes, "handle.merged", "khirthal")!;
    expect(m.into).toMatchObject({ id: "khairthal", handle: "@khairthalpolice" });
    // A retired or merged handle gets no separate alias restore
    for (const id of ["hbh", "nwr", "forest", "khirthal"]) expect(of(plan.changes, "handle.keywords_restored", id)).toBeUndefined();
  });

  it("leaves clean, reporter and unverified rows alone", () => {
    for (const id of ["jhalawar", "rep", "unverified", "forestraj", "nwrailways", "khairthal"]) expect(plan.changes.filter((c) => c.id === id && c.kind !== "handle.merged")).toEqual([]);
  });

  it("takes the places out of #RajasthanPanchayatElection2026 and keeps it on with its own words", () => {
    const c = of(plan.changes, "hashtag.rule_cleaned", "panchayat")!;
    expect(c.after).toEqual({ name: "Panchayat", aliases: ["Election", "Rahul Gandhi", "राहुल गांधी"], active: true });
    expect(c.removed).toEqual(["Jaipur", "जयपुर", "Hanumangarh", "हनुमानगढ़"]);
  });

  it("switches off and empties #Balotrapolice; a learned tag left with nothing is saved inactive under its own name", () => {
    expect(of(plan.changes, "hashtag.rule_deactivated", "balotra")!.after).toEqual({ name: "Balotrapolice", aliases: [], active: false });
    expect(of(plan.changes, "hashtag.rule_cleaned", "bbhbh")!.after).toEqual({ name: "bbhbh", aliases: [], active: false });
  });

  it("never touches a known tag's rule (#Jaisalmer, #NarendraModi), an editor-changed one, or an editor's own", () => {
    for (const id of ["jaisalmer", "modi", "edited", "editor"]) expect(plan.changes.filter((c) => c.id === id)).toEqual([]);
  });

  it("notes the lookalikes it sees", () => {
    expect(plan.lookalikes).toEqual(expect.arrayContaining([
      { orgId: ORG, handle: "@forest", like: "@forestRajasthan" },
      { orgId: ORG, handle: "@nwr", like: "@NWRailways" },
      { orgId: ORG, handle: "@Khirthalpolice", like: "@khairthalpolice" },
    ]));
  });

  it("describes every change for the dry run", () => {
    const text = describeLearnCleanup(plan).join("\n");
    expect(text).toContain("Changes: 10 (handle aliases restored 3, handles retired 3, merged 1, hashtag rules cleaned 2, deactivated 1)");
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

describe("learn-cleanup: applying the plan", () => {
  it("writes each change and one audit row per change (handle.*/hashtag.* actions, script actor, before and after)", async () => {
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
    expect(audits.find((a) => a.entityId === "jpr")).toMatchObject({ action: "handle.keywords_restored", entityType: "handle", before: { handle: "@jpr_rural" }, after: { aliases: ["Jaipur", "जयपुर", "बस्सी", "जोबनेर"] } });
    expect(audits.find((a) => a.entityId === "hbh")).toMatchObject({ action: "handle.retired", after: { verified: false } });
    expect(audits.find((a) => a.entityId === "balotra")).toMatchObject({ action: "hashtag.rule_deactivated", entityType: "hashtag_rule" });
    // A retired handle is unverified (never suggested, the worker reloads); a restored one gets a fresh reload stamp
    expect(updates.filter((u) => u.set.verifiedAt === null)).toHaveLength(4);
  });
});

describe("scripts/learn-cleanup.ts --from-json", () => {
  it("prints the dry run of exported tables without a database", () => {
    const dir = mkdtempSync(join(tmpdir(), "learn-cleanup-"));
    try {
      const snap = snapshot();
      writeFileSync(join(dir, "handle_directory.json"), JSON.stringify(snap.handles));
      writeFileSync(join(dir, "hashtag_rules.json"), JSON.stringify(snap.rules));
      writeFileSync(join(dir, "audit_learning.json"), JSON.stringify(snap.audit));
      const script = fileURLToPath(new URL("../scripts/learn-cleanup.ts", import.meta.url));
      const env = { ...process.env, DATABASE_URL: "" };
      const out = execFileSync(process.execPath, ["--import", "tsx", script, "--from-json", dir], { encoding: "utf8", env, cwd: fileURLToPath(new URL("..", import.meta.url)) });
      expect(out).toContain("DRY RUN (nothing written)");
      expect(out).toContain("Changes: 10");
      expect(out).toContain("@hbh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
