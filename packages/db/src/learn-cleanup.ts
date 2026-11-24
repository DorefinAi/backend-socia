// Undoes what the tag learning wrongly learned before the learning fix (25 Nov 2026), under the fixed rules (core
// learn.ts). Planned from a snapshot of handle_directory, hashtag_rules, the learning's audit rows and the drafts those
// rows name; the plan is pure, so it can be checked against exported JSON without a database
// (scripts/learn-cleanup.ts --from-json).
//
//   - Desk handles: the learning is RE-RUN with the same function the live learning uses (core PostedLearner.learnable)
//     over the drafts its audit rows (handle.keywords_learned after the row's last editor handle.update) name, counting
//     only drafts on which the desk typed the handle (item_outcomes desk_added). A learned alias that re-run does not
//     give goes; so cleanup and learning always agree (@jpr_rural keeps चौमूं, its desk-typed town, and loses Air India;
//     a local handle such as @ChaksuNews keeps its stories' own district and town; a person's keeps no place). An alias
//     an editor typed in Settings is explicit config and always stays, as does a keyword inside the handle string (core
//     ownHandleKeywords). verified_at is bumped: the worker's reload stamp.
//   - Junk handles (RETIRED_HANDLES: offered 100+ times, never taken, or a stub of a real handle) are retired the way
//     the directory marks a handle unusable: verified_at NULL (never suggested, never learned; the desk's add asks an
//     editor to verify it again). Their aliases are cleared.
//   - Typo twins (MERGED_HANDLES): the typo is retired. When the right handle is a verified desk row, the typo's aliases
//     that the right handle could learn itself move to it; when it is not (a data-file handle, @KhairthalPolice), the
//     typo is still retired and the plan says so. A typo the directory does not have is noted, never skipped silently.
//   - Learned hashtag rules (audit hashtag.rule_learned, no editor change since): a tag that is a handle typed with a
//     # is switched off and emptied; any other tag naming no known place or subject keeps only what the learning gives
//     it now (core tagRuleKeywords: its own words and the subjects named inside it), saved inactive, named after the
//     tag, when nothing is left. A known tag's rule (#Jaisalmer) is left alone.
//
// Every change is one audit row (actor "script:learn-cleanup"), with before (verified_at and verified_by included for a
// handle) and after. applyLearnCleanup runs in the caller's transaction: all or nothing.

import { LEARNED_RULE_PRIORITY, ownHandleKeywords, type LearnStory, type PostedLearner } from "@socia/core";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "./audit";
import type { Executor } from "./client";
import { handleDirectory, hashtagRules } from "./schema";

export const CLEANUP_ACTOR = "script:learn-cleanup";

/** Desk handles retired by name (bare, any case): junk the desk never took (@hbh 0/123, @nwr 0/124) or a stub (@forest) */
export const RETIRED_HANDLES: readonly { handle: string; reason: string }[] = [
  { handle: "hbh", reason: "junk handle: offered on almost every story, never taken" },
  { handle: "nwr", reason: "junk handle: offered on almost every story, never taken (a stub of @NWRailways)" },
  { handle: "forest", reason: "a stub of @forestRajasthan" },
];

/** Typo twins: the first is merged into the second (bare, any case) */
export const MERGED_HANDLES: readonly [string, string][] = [["Khirthalpolice", "khairthalpolice"]];

/** The snapshot rows, as the tables (and their JSON exports) name the columns */
export interface CleanupHandleRow {
  id: string;
  org_id: string;
  handle: string;
  aliases: string[];
  source: string;
  verified_at: string | Date | null;
  verified_by?: string | null;
  entity_type?: string | null;
}
export interface CleanupRuleRow {
  id: string;
  org_id: string;
  name: string;
  aliases: string[];
  hashtag_latin: string;
  hashtag_devanagari: string | null;
  priority: number;
  active: boolean;
}
export interface CleanupAuditRow {
  org_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  at: string | Date;
}
/** A draft a learned audit row names: its story, and the handles the desk typed on it (item_outcomes desk_added) */
export interface CleanupEvidenceRow {
  draft_id: string;
  headline: string | null;
  body: string | null;
  district: string | null;
  town: string | null;
  /** Lower-case, without the @ */
  typed: string[];
}
export interface CleanupSnapshot {
  handles: CleanupHandleRow[];
  rules: CleanupRuleRow[];
  /** handle.keywords_learned and hashtag.rule_learned rows, and the editors' handle.update and hashtag_rule.* rows */
  audit: CleanupAuditRow[];
  /** The drafts the handle.keywords_learned rows name; a draft missing here taught nothing the fixed learning keeps */
  evidence?: CleanupEvidenceRow[];
}

/** A handle's verification as it stood (kept in the audit row's `before`) */
export interface Verification {
  verifiedAt: string | null;
  verifiedBy: string | null;
}

export type CleanupChange =
  | { kind: "handle.keywords_restored"; orgId: string; id: string; handle: string; before: string[]; after: string[]; removed: string[]; prePollution: string[] | null; verification: Verification }
  | { kind: "handle.retired"; orgId: string; id: string; handle: string; aliases: string[]; reason: string; verification: Verification }
  | {
      kind: "handle.merged"; orgId: string; id: string; handle: string; aliases: string[]; verification: Verification;
      /** id null: the right handle is not a verified desk row (a data-file handle): only the typo is retired */
      into: { id: string | null; handle: string; before: string[]; after: string[]; verification: Verification | null };
    }
  | { kind: "hashtag.rule_cleaned"; orgId: string; id: string; tag: string; before: RuleState; after: RuleState; removed: string[] }
  | { kind: "hashtag.rule_deactivated"; orgId: string; id: string; tag: string; before: RuleState; after: RuleState; reason: string };

export interface RuleState {
  name: string;
  aliases: string[];
  active: boolean;
}

export interface CleanupPlan {
  changes: CleanupChange[];
  /** Handles that look like a typo or stub of another (info: only RETIRED_HANDLES / MERGED_HANDLES are acted on) */
  lookalikes: { orgId: string; handle: string; like: string }[];
  /** What a person should know that is not a change (a listed typo the directory does not have, missing evidence) */
  notes: string[];
}

const bare = (h: string) => h.trim().replace(/^[@#]+/, "");
const low = (h: string) => bare(h).toLowerCase();
const nfcKey = (s: string) => s.normalize("NFC").trim().toLowerCase();
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const at = (r: CleanupAuditRow) => new Date(r.at).getTime();
const verified = (h: CleanupHandleRow) => h.verified_at !== null && h.verified_at !== "";
const verificationOf = (h: CleanupHandleRow): Verification => ({
  verifiedAt: h.verified_at === null || h.verified_at === "" ? null : new Date(h.verified_at).toISOString(),
  verifiedBy: h.verified_by ?? null,
});
const storyOf = (e: CleanupEvidenceRow): LearnStory => ({ headline: e.headline, body: e.body, district: e.district, town: e.town });

/**
 * Which aliases a desk handle keeps: an editor's (not in `learnedAdded`), a keyword inside the handle string, and a
 * learned one only when re-running the learning on its evidence gives it (`relearned`, PostedLearner.learnable)
 */
export function keptAliases(handle: string, aliases: readonly string[], learnedAdded: ReadonlySet<string>, relearned: readonly string[], learner: Pick<PostedLearner, "candidates">): string[] {
  const inHandle = new Set(ownHandleKeywords(handle, learner.candidates).map(nfcKey));
  const again = new Set(relearned.map(nfcKey));
  return aliases.filter((a) => {
    const k = nfcKey(a);
    return !learnedAdded.has(k) || inHandle.has(k) || again.has(k);
  });
}

/** The plan for every org in the snapshot */
export function planLearnCleanup(snap: CleanupSnapshot, learner: PostedLearner): CleanupPlan {
  const changes: CleanupChange[] = [];
  const lookalikes: CleanupPlan["lookalikes"] = [];
  const notes: string[] = [];
  const evidence = new Map((snap.evidence ?? []).map((e) => [e.draft_id, e]));
  const orgs = [...new Set([...snap.handles.map((h) => h.org_id), ...snap.rules.map((r) => r.org_id)])].sort();
  for (const orgId of orgs) {
    const handles = snap.handles.filter((h) => h.org_id === orgId);
    const audit = snap.audit.filter((a) => a.org_id === orgId).sort((a, b) => at(a) - at(b));
    const directory = handles.map((h) => bare(h.handle));
    // Rows an editor verified in Settings (not desk adds): never a typo of anything
    const curated = handles.filter((h) => h.source !== "desk" && verified(h)).map((h) => bare(h.handle));
    const desk = handles.filter((h) => h.source === "desk" && verified(h));
    const reporters = handles.filter((h) => h.source === "reporter").map((h) => bare(h.handle));
    const done = new Set<string>();

    // Retired by name
    for (const r of RETIRED_HANDLES) {
      for (const h of desk.filter((x) => low(x.handle) === low(r.handle))) {
        changes.push({ kind: "handle.retired", orgId, id: h.id, handle: `@${bare(h.handle)}`, aliases: [...h.aliases], reason: r.reason, verification: verificationOf(h) });
        done.add(h.id);
      }
    }

    // What each desk handle would learn now from the drafts its learned rows name (the learning's own function)
    const relearned = new Map<string, string[]>();
    const missing = new Set<string>();
    const relearn = (h: CleanupHandleRow, learned: CleanupAuditRow[]) => {
      const drafts = [...new Set(learned.map((a) => (a.after as { draftId?: unknown } | null)?.draftId).filter((d): d is string => typeof d === "string"))];
      for (const d of drafts) if (!evidence.has(d)) missing.add(d);
      const stories = drafts.map((d) => evidence.get(d)).filter((e): e is CleanupEvidenceRow => !!e && e.typed.includes(low(h.handle))).map(storyOf);
      return learner.learnable(h.handle, stories, { directory, curated, reporters, type: h.entity_type ?? null }).names;
    };

    // Aliases: restore what the learning got wrong (before the merges, so the right handle is clean first)
    const after = new Map<string, string[]>();
    for (const h of desk) {
      if (done.has(h.id)) continue;
      // Learning before the row's last editor change in Settings is the editor's now (a PATCH saves the whole list)
      const edited = Math.max(-Infinity, ...audit.filter((a) => a.action === "handle.update" && a.entity_id === h.id).map(at));
      const learned = audit.filter((a) => a.action === "handle.keywords_learned" && a.entity_id === h.id && at(a) > edited);
      const learnedAdded = new Set(learned.flatMap((a) => strings((a.after as { added?: unknown } | null)?.added)).map(nfcKey));
      const again = relearn(h, learned);
      relearned.set(h.id, again);
      const kept = keptAliases(h.handle, h.aliases, learnedAdded, again, learner);
      after.set(h.id, kept);
      if (kept.length === h.aliases.length) continue;
      const first = learned[0];
      const prePollution = first ? strings((first.before as { aliases?: unknown } | null)?.aliases) : null;
      changes.push({
        kind: "handle.keywords_restored", orgId, id: h.id, handle: `@${bare(h.handle)}`, before: [...h.aliases], after: kept,
        removed: h.aliases.filter((a) => !kept.includes(a)), prePollution, verification: verificationOf(h),
      });
    }
    if (missing.size) notes.push(`${missing.size} draft(s) named by learned audit rows are not in the evidence: what they taught is not kept`);

    // Typo twins: the typo is always retired; its aliases move only to a verified desk row, and only what it could learn
    for (const [from, to] of MERGED_HANDLES) {
      const typos = desk.filter((x) => low(x.handle) === low(from) && !done.has(x.id));
      if (!typos.length) {
        notes.push(`merge @${from} -> @${to}: @${from} is not a verified desk row here; nothing to retire`);
        continue;
      }
      const target = desk.find((x) => low(x.handle) === low(to) && !done.has(x.id)) ?? null;
      if (!target) notes.push(`merge @${from} -> @${to}: @${to} is not a verified desk row (a data-file or other handle); only the typo is retired`);
      for (const h of typos) {
        const base = target ? (after.get(target.id) ?? target.aliases) : [];
        const incoming = (after.get(h.id) ?? h.aliases).filter((a) => !base.some((b) => nfcKey(b) === nfcKey(a)));
        const own = target ? new Set([...ownHandleKeywords(target.handle, learner.candidates), ...(relearned.get(target.id) ?? [])].map(nfcKey)) : new Set<string>();
        const merged = [...base, ...incoming.filter((a) => own.has(nfcKey(a)))].slice(0, 30);
        changes.push({
          kind: "handle.merged", orgId, id: h.id, handle: `@${bare(h.handle)}`, aliases: [...h.aliases], verification: verificationOf(h),
          into: { id: target?.id ?? null, handle: `@${bare(target?.handle ?? to)}`, before: [...base], after: merged, verification: target ? verificationOf(target) : null },
        });
        // A merge replaces any restore planned for the typo
        for (let i = changes.length - 1; i >= 0; i--) {
          const c = changes[i]!;
          if (c.kind === "handle.keywords_restored" && c.id === h.id) changes.splice(i, 1);
        }
        if (target) after.set(target.id, merged);
        done.add(h.id);
      }
    }

    // Lookalikes, for the record
    for (const h of desk) {
      const like = learner.handleLookalike(h.handle, directory.filter((d) => low(d) !== low(h.handle)), curated);
      if (like) lookalikes.push({ orgId, handle: `@${bare(h.handle)}`, like: `@${like}` });
    }

    // Learned hashtag rules no editor has changed since
    for (const r of snap.rules.filter((x) => x.org_id === orgId)) {
      const rows = audit.filter((a) => a.entity_type === "hashtag_rule" && a.entity_id === r.id);
      const learnedRule = rows.some((a) => a.action === "hashtag.rule_learned") && !rows.some((a) => a.action.startsWith("hashtag_rule."));
      if (!learnedRule || r.priority !== LEARNED_RULE_PRIORITY) continue;
      const tag = `#${bare(r.hashtag_latin || r.hashtag_devanagari || "")}`;
      const before: RuleState = { name: r.name, aliases: [...r.aliases], active: r.active };
      const empty: RuleState = { name: bare(tag), aliases: [], active: false };
      if (learner.tagIsHandle(tag, directory)) {
        if (before.active || before.aliases.length || nfcKey(before.name) !== nfcKey(empty.name)) {
          changes.push({ kind: "hashtag.rule_deactivated", orgId, id: r.id, tag, before, after: empty, reason: "a handle typed with a #, not a topic" });
        }
        continue;
      }
      if (learner.tagKnown(tag)) continue;
      const nameIsTag = !r.active && r.aliases.length === 0 && nfcKey(r.name) === nfcKey(bare(tag));
      const keywords = nameIsTag ? [] : [r.name, ...r.aliases];
      // Only what the learning gives this tag now: its own words, the subjects named inside it
      const allowed = new Set(learner.tagKeywords(tag).keywords.map(nfcKey));
      const kept = keywords.filter((k) => allowed.has(nfcKey(k)));
      if (kept.length === keywords.length) continue;
      const next: RuleState = kept.length ? { name: kept[0]!, aliases: kept.slice(1), active: r.active } : empty;
      changes.push({ kind: "hashtag.rule_cleaned", orgId, id: r.id, tag, before, after: next, removed: keywords.filter((k) => !kept.includes(k)) });
    }
  }
  return { changes, lookalikes, notes };
}

/**
 * Writes the plan, one audit row per change (a merge that also changes the right handle's aliases writes one for
 * each row). Run it in one transaction (the script does): all or nothing. Returns the audit rows written.
 */
export async function applyLearnCleanup(tx: Executor, plan: CleanupPlan, actor = CLEANUP_ACTOR): Promise<number> {
  let n = 0;
  const who = { actorId: null, actor };
  for (const c of plan.changes) {
    switch (c.kind) {
      case "handle.keywords_restored": {
        await tx.update(handleDirectory).set({ aliases: c.after, verifiedAt: sql`now()` }).where(and(eq(handleDirectory.id, c.id), eq(handleDirectory.orgId, c.orgId)));
        await audit(tx, {
          orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.id,
          before: { handle: c.handle, aliases: c.before, ...c.verification }, after: { handle: c.handle, aliases: c.after, removed: c.removed, prePollution: c.prePollution },
        });
        break;
      }
      case "handle.retired": {
        await tx.update(handleDirectory).set({ aliases: [], verifiedAt: null }).where(and(eq(handleDirectory.id, c.id), eq(handleDirectory.orgId, c.orgId)));
        await audit(tx, {
          orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.id,
          before: { handle: c.handle, aliases: c.aliases, verified: true, ...c.verification }, after: { handle: c.handle, aliases: [], verified: false, reason: c.reason },
        });
        break;
      }
      case "handle.merged": {
        await tx.update(handleDirectory).set({ aliases: [], verifiedAt: null }).where(and(eq(handleDirectory.id, c.id), eq(handleDirectory.orgId, c.orgId)));
        await audit(tx, {
          orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.id,
          before: { handle: c.handle, aliases: c.aliases, verified: true, ...c.verification },
          after: { handle: c.handle, aliases: [], verified: false, mergedInto: c.into.handle, intoDeskRow: c.into.id !== null },
        });
        if (c.into.id !== null && c.into.after.length !== c.into.before.length) {
          await tx.update(handleDirectory).set({ aliases: c.into.after, verifiedAt: sql`now()` }).where(and(eq(handleDirectory.id, c.into.id), eq(handleDirectory.orgId, c.orgId)));
          await audit(tx, {
            orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.into.id,
            before: { handle: c.into.handle, aliases: c.into.before, ...(c.into.verification ?? {}) }, after: { handle: c.into.handle, aliases: c.into.after, mergedFrom: c.handle },
          });
          n++;
        }
        break;
      }
      case "hashtag.rule_cleaned":
      case "hashtag.rule_deactivated": {
        await tx
          .update(hashtagRules)
          .set({ name: c.after.name, aliases: c.after.aliases, active: c.after.active, updatedAt: sql`now()` })
          .where(and(eq(hashtagRules.id, c.id), eq(hashtagRules.orgId, c.orgId)));
        await audit(tx, {
          orgId: c.orgId, ...who, action: c.kind, entityType: "hashtag_rule", entityId: c.id,
          before: { tag: c.tag, ...c.before }, after: { tag: c.tag, ...c.after, ...(c.kind === "hashtag.rule_cleaned" ? { removed: c.removed } : { reason: c.reason }) },
        });
        break;
      }
    }
    n++;
  }
  return n;
}

/** The plan as lines a person can check, one per change */
export function describeLearnCleanup(plan: CleanupPlan): string[] {
  const out: string[] = [];
  const by = <K extends CleanupChange["kind"]>(k: K) => plan.changes.filter((c): c is Extract<CleanupChange, { kind: K }> => c.kind === k);
  const restored = by("handle.keywords_restored");
  const retired = by("handle.retired");
  const merged = by("handle.merged");
  const cleaned = by("hashtag.rule_cleaned");
  const off = by("hashtag.rule_deactivated");
  out.push(`Changes: ${plan.changes.length} (handle aliases restored ${restored.length}, handles retired ${retired.length}, merged ${merged.length}, hashtag rules cleaned ${cleaned.length}, deactivated ${off.length})`);
  out.push("", `Handle aliases restored (${restored.length}):`);
  for (const c of restored) {
    out.push(`  ${c.handle}: ${c.before.length} -> ${c.after.length} aliases`);
    out.push(`    keep:   ${c.after.join(", ") || "(none)"}`);
    out.push(`    remove: ${c.removed.join(", ")}`);
    if (c.prePollution) out.push(`    (before its first learning: ${c.prePollution.join(", ") || "(none)"})`);
  }
  out.push("", `Handles retired, verified_at -> NULL (${retired.length}):`);
  for (const c of retired) out.push(`  ${c.handle}: ${c.reason}; aliases cleared (${c.aliases.join(", ") || "none"})`);
  out.push("", `Handles merged (${merged.length}):`);
  for (const c of merged) {
    out.push(c.into.id === null
      ? `  ${c.handle} -> ${c.into.handle}: typo retired; ${c.into.handle} is not a desk row, nothing moved`
      : `  ${c.handle} -> ${c.into.handle}: typo retired; ${c.into.handle} aliases ${c.into.before.length} -> ${c.into.after.length}`);
  }
  out.push("", `Hashtag rules cleaned (${cleaned.length}):`);
  for (const c of cleaned) out.push(`  ${c.tag}: remove ${c.removed.join(", ")}; keep ${[c.after.name, ...c.after.aliases].join(", ")}${c.after.active ? "" : " (inactive)"}`);
  out.push("", `Hashtag rules deactivated (${off.length}):`);
  for (const c of off) out.push(`  ${c.tag}: ${c.reason}; was ${c.before.active ? "active" : "inactive"} with ${[c.before.name, ...c.before.aliases].join(", ")}`);
  if (plan.notes.length) {
    out.push("", `Notes (${plan.notes.length}):`);
    for (const n of plan.notes) out.push(`  ${n}`);
  }
  out.push("", `Lookalike handles seen (info only; only the lists above are acted on): ${plan.lookalikes.length}`);
  for (const l of plan.lookalikes) out.push(`  ${l.handle} looks like ${l.like}`);
  return out;
}

/** A post_decisions row as exported (decisions_*.json): the fields the evidence needs */
export interface DecisionExportRow {
  draft_id: string;
  district: string | null;
  town?: string | null;
  draft_text?: string | null;
  final_text?: string | null;
  item_outcomes?: unknown;
}

/**
 * Evidence from exported post_decisions rows (--from-json): the post's first line stands for the headline, the rest
 * for the body, and the handles item_outcomes record as desk_added are the ones the desk typed. The database run reads
 * the story itself (scripts/learn-cleanup.ts).
 */
export function evidenceFromDecisions(rows: readonly DecisionExportRow[]): CleanupEvidenceRow[] {
  return rows.map((r) => {
    const text = r.final_text ?? r.draft_text ?? "";
    const [first = "", ...rest] = text.split("\n");
    const outcomes = Array.isArray(r.item_outcomes) ? r.item_outcomes : [];
    const typed = outcomes.flatMap((o) => {
      const x = o as { kind?: unknown; outcome?: unknown; item?: unknown } | null;
      return x && x.kind === "handle" && x.outcome === "desk_added" && typeof x.item === "string" ? [low(x.item)] : [];
    });
    return { draft_id: r.draft_id, headline: first, body: rest.join("\n"), district: r.district, town: r.town ?? null, typed };
  });
}
