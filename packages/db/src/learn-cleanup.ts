// Undoes what the tag learning wrongly learned before the learning fix (25 Nov 2026), under the fixed rules (core
// learn.ts). Planned from a snapshot of handle_directory, hashtag_rules and the learning's audit rows; the plan is
// pure, so it can be checked against exported JSON without a database (scripts/learn-cleanup.ts --from-json).
//
//   - Desk handles: every alias the learning added (audit handle.keywords_learned after the row's last editor
//     handle.update) that is not the handle's own (a place in its own district, or its own subject: core
//     handleStoryNames' rule; a person's, party's, national or institution's handle keeps no learned place) goes. An
//     alias an editor typed in Settings is explicit config and always stays, as does a keyword inside the handle
//     string (core ownHandleKeywords). What is left is the pre-pollution value plus the learning that was right
//     (@jpr_rural keeps जोबनेर, loses Air India). verified_at is bumped: the worker's reload stamp.
//   - Junk handles (RETIRED_HANDLES: offered 100+ times, never taken, or a stub of a real handle) are retired the way
//     the directory marks a handle unusable: verified_at NULL (never suggested, never learned; the desk's add asks an
//     editor to verify it again). Their aliases are cleared.
//   - Typo twins (MERGED_HANDLES) are merged: the typo's aliases move to the right handle, the typo is retired.
//   - Learned hashtag rules (audit hashtag.rule_learned, no editor change since): a tag that is a handle typed with a
//     # is switched off and emptied; a tag naming no known place or subject loses every place keyword (saved
//     inactive, named after the tag, when nothing is left). A known tag's rule (#Jaisalmer) is left alone.
//
// Every change is one audit row (actor "script:learn-cleanup"), with before and after. applyLearnCleanup runs in the
// caller's transaction: all or nothing.

import { LEARNED_RULE_PRIORITY, ownHandleKeywords, placeDistricts, type PostedLearner } from "@socia/core";
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
export interface CleanupSnapshot {
  handles: CleanupHandleRow[];
  rules: CleanupRuleRow[];
  /** handle.keywords_learned and hashtag.rule_learned rows, and the editors' handle.update and hashtag_rule.* rows */
  audit: CleanupAuditRow[];
}

export type CleanupChange =
  | { kind: "handle.keywords_restored"; orgId: string; id: string; handle: string; before: string[]; after: string[]; removed: string[]; prePollution: string[] | null }
  | { kind: "handle.retired"; orgId: string; id: string; handle: string; aliases: string[]; reason: string }
  | { kind: "handle.merged"; orgId: string; id: string; handle: string; aliases: string[]; into: { id: string; handle: string; before: string[]; after: string[] } }
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
}

const bare = (h: string) => h.trim().replace(/^[@#]+/, "");
const low = (h: string) => bare(h).toLowerCase();
const nfcKey = (s: string) => s.normalize("NFC").trim().toLowerCase();
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const at = (r: CleanupAuditRow) => new Date(r.at).getTime();
const verified = (h: CleanupHandleRow) => h.verified_at !== null && h.verified_at !== "";

/** Which aliases a desk handle keeps under the fixed rules, and the learned names that are its own */
export function keptAliases(
  handle: string,
  aliases: readonly string[],
  learnedAdded: ReadonlySet<string>,
  learner: Pick<PostedLearner, "book" | "candidates" | "ownSubjectNames" | "placeOutside">,
): string[] {
  const inHandle = new Set(ownHandleKeywords(handle, learner.candidates).map(nfcKey));
  const ownSubject = new Set(learner.ownSubjectNames(handle).map(nfcKey));
  return aliases.filter((a) => {
    const k = nfcKey(a);
    if (inHandle.has(k)) return true;
    // Not learned: an editor's alias (or the desk add's), explicit config
    if (!learnedAdded.has(k)) return true;
    if (learner.placeOutside(handle, a)) return false;
    // Learned: only a place in its own district (not outside, checked above) or its own subject
    return placeDistricts(a, learner.book) !== null || ownSubject.has(k);
  });
}

/** The plan for every org in the snapshot */
export function planLearnCleanup(snap: CleanupSnapshot, learner: PostedLearner): CleanupPlan {
  const changes: CleanupChange[] = [];
  const lookalikes: CleanupPlan["lookalikes"] = [];
  const orgs = [...new Set([...snap.handles.map((h) => h.org_id), ...snap.rules.map((r) => r.org_id)])].sort();
  for (const orgId of orgs) {
    const handles = snap.handles.filter((h) => h.org_id === orgId);
    const audit = snap.audit.filter((a) => a.org_id === orgId).sort((a, b) => at(a) - at(b));
    const directory = handles.map((h) => bare(h.handle));
    // Rows an editor verified in Settings (not desk adds): never a typo of anything
    const curated = handles.filter((h) => h.source !== "desk" && verified(h)).map((h) => bare(h.handle));
    const desk = handles.filter((h) => h.source === "desk" && verified(h));
    const done = new Set<string>();

    // Retired by name
    for (const r of RETIRED_HANDLES) {
      for (const h of desk.filter((x) => low(x.handle) === low(r.handle))) {
        changes.push({ kind: "handle.retired", orgId, id: h.id, handle: `@${bare(h.handle)}`, aliases: [...h.aliases], reason: r.reason });
        done.add(h.id);
      }
    }

    // Aliases: restore what the learning got wrong (before the merges, so the right handle is clean first)
    const after = new Map<string, string[]>();
    for (const h of desk) {
      if (done.has(h.id)) continue;
      // Learning before the row's last editor change in Settings is the editor's now (a PATCH saves the whole list)
      const edited = Math.max(-Infinity, ...audit.filter((a) => a.action === "handle.update" && a.entity_id === h.id).map(at));
      const learned = audit.filter((a) => a.action === "handle.keywords_learned" && a.entity_id === h.id && at(a) > edited);
      const learnedAdded = new Set(learned.flatMap((a) => strings((a.after as { added?: unknown } | null)?.added)).map(nfcKey));
      const kept = keptAliases(h.handle, h.aliases, learnedAdded, learner);
      after.set(h.id, kept);
      if (kept.length === h.aliases.length) continue;
      const first = learned[0];
      const prePollution = first ? strings((first.before as { aliases?: unknown } | null)?.aliases) : null;
      changes.push({
        kind: "handle.keywords_restored", orgId, id: h.id, handle: `@${bare(h.handle)}`, before: [...h.aliases], after: kept,
        removed: h.aliases.filter((a) => !kept.includes(a)), prePollution,
      });
    }

    // Typo twins
    for (const [from, to] of MERGED_HANDLES) {
      const target = desk.find((x) => low(x.handle) === low(to) && !done.has(x.id));
      if (!target) continue;
      for (const h of desk.filter((x) => low(x.handle) === low(from) && !done.has(x.id))) {
        const base = after.get(target.id) ?? target.aliases;
        const incoming = (after.get(h.id) ?? h.aliases).filter((a) => !base.some((b) => nfcKey(b) === nfcKey(a)));
        // The typo's aliases are new to the right handle: kept only when they are its own, like learned ones
        const moved = keptAliases(target.handle, incoming, new Set(incoming.map(nfcKey)), learner);
        const merged = [...base, ...moved].slice(0, 30);
        changes.push({
          kind: "handle.merged", orgId, id: h.id, handle: `@${bare(h.handle)}`, aliases: [...h.aliases],
          into: { id: target.id, handle: `@${bare(target.handle)}`, before: [...base], after: merged },
        });
        // A merge replaces any restore planned for the typo
        for (let i = changes.length - 1; i >= 0; i--) {
          const c = changes[i]!;
          if (c.kind === "handle.keywords_restored" && c.id === h.id) changes.splice(i, 1);
        }
        after.set(target.id, merged);
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
      const kept = keywords.filter((k) => placeDistricts(k, learner.book) === null);
      if (kept.length === keywords.length) continue;
      const next: RuleState = kept.length ? { name: kept[0]!, aliases: kept.slice(1), active: r.active } : empty;
      changes.push({ kind: "hashtag.rule_cleaned", orgId, id: r.id, tag, before, after: next, removed: keywords.filter((k) => !kept.includes(k)) });
    }
  }
  return { changes, lookalikes };
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
          before: { handle: c.handle, aliases: c.before }, after: { handle: c.handle, aliases: c.after, removed: c.removed, prePollution: c.prePollution },
        });
        break;
      }
      case "handle.retired": {
        await tx.update(handleDirectory).set({ aliases: [], verifiedAt: null }).where(and(eq(handleDirectory.id, c.id), eq(handleDirectory.orgId, c.orgId)));
        await audit(tx, {
          orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.id,
          before: { handle: c.handle, aliases: c.aliases, verified: true }, after: { handle: c.handle, aliases: [], verified: false, reason: c.reason },
        });
        break;
      }
      case "handle.merged": {
        await tx.update(handleDirectory).set({ aliases: [], verifiedAt: null }).where(and(eq(handleDirectory.id, c.id), eq(handleDirectory.orgId, c.orgId)));
        await audit(tx, {
          orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.id,
          before: { handle: c.handle, aliases: c.aliases, verified: true }, after: { handle: c.handle, aliases: [], verified: false, mergedInto: c.into.handle },
        });
        if (c.into.after.length !== c.into.before.length) {
          await tx.update(handleDirectory).set({ aliases: c.into.after, verifiedAt: sql`now()` }).where(and(eq(handleDirectory.id, c.into.id), eq(handleDirectory.orgId, c.orgId)));
          await audit(tx, {
            orgId: c.orgId, ...who, action: c.kind, entityType: "handle", entityId: c.into.id,
            before: { handle: c.into.handle, aliases: c.into.before }, after: { handle: c.into.handle, aliases: c.into.after, mergedFrom: c.handle },
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
  for (const c of merged) out.push(`  ${c.handle} -> ${c.into.handle}: typo retired; ${c.into.handle} aliases ${c.into.before.length} -> ${c.into.after.length}`);
  out.push("", `Hashtag rules cleaned (${cleaned.length}):`);
  for (const c of cleaned) out.push(`  ${c.tag}: remove ${c.removed.join(", ")}; keep ${[c.after.name, ...c.after.aliases].join(", ")}${c.after.active ? "" : " (inactive)"}`);
  out.push("", `Hashtag rules deactivated (${off.length}):`);
  for (const c of off) out.push(`  ${c.tag}: ${c.reason}; was ${c.before.active ? "active" : "inactive"} with ${[c.before.name, ...c.before.aliases].join(", ")}`);
  out.push("", `Lookalike handles seen (info only; only the lists above are acted on): ${plan.lookalikes.length}`);
  for (const l of plan.lookalikes) out.push(`  ${l.handle} looks like ${l.like}`);
  return out;
}
