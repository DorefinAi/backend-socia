// The breaking draft's suggestions as the desk receives them (reporter-prior brief §2.3, UI contract): each item
// may carry the stable rule id (`source`), the reason line (`reason`), core's `detail` and, for the reporter
// prior, `score` and `n`. Old clients read only the fields they always had.
//
// - mentionSuggestions: the stored items, passed through. Items stored before the rule ids existed get a
//   `source` derived from the reason code in their handleId ("rule:police:..." → "district.police"), as core does,
//   marked `sourceDerived: true`. An old office suggestion ("suggest:office:...") gets the rule id of the office
//   whose handles include it, read from subject-handles.json `offices`; none when no office (or two) lists it.
// - hashtagSuggestions: plain strings, except a tag whose rule is known (handle_pick.tagSuggestions), which goes
//   out as { tag, source, reason, score?, n? }. Reporter and policy tags always have one.
//
// A stored item that is not usable is left out and reported once per draft and view; anything unexpected while
// mapping falls back to the well-formed items alone (never raw ones), so a draft always opens.

import { handleSource, PROPOSAL_SOURCES, type OfficeRuleId, type RuleHandlePick } from "@socia/core";
import type { DraftHandlePick } from "@socia/db";
import { readFileSync, statSync } from "node:fs";
import { SUBJECT_HANDLES_FILE } from "./handle-keywords";

export interface MentionSuggestionView {
  handleId: string;
  /** As stored; absent when the stored item had none */
  entity?: string;
  handle: string;
  exact: boolean;
  source?: string;
  /** True when `source` was worked out from the handleId of an item stored before rule ids existed */
  sourceDerived?: true;
  reason?: string;
  /** The prior's "why" line from core (HandlePick.detail), when it has one */
  detail?: string;
  score?: number;
  n?: number;
}

export type HashtagSuggestionView = string | { tag: string; source?: string; reason?: string; score?: number; n?: number };

/** pino-compatible */
export interface SuggestionLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}
let logger: SuggestionLogger | null = null;
/** The API passes its logger (app.ts) */
export function setSuggestionLogger(next: SuggestionLogger): void {
  logger = next;
}

type View = "mention" | "hashtag";

/**
 * Draft views already reported ("<draftId>:mention", "<draftId>:hashtag"), so a draft opened all day is reported
 * once per view and a problem in one view never hides one in the other (bounded). Without a draft id there is
 * nothing to tell drafts apart by, so each problem is reported.
 */
const reported = new Set<string>();
function report(draftId: string | undefined, view: View, obj: Record<string, unknown>, msg: string): void {
  if (draftId !== undefined) {
    const key = `${draftId}:${view}`;
    if (reported.has(key)) return;
    if (reported.size >= 5000) reported.clear();
    reported.add(key);
  }
  try {
    logger?.warn({ draftId: draftId ?? null, view, ...obj }, msg);
  } catch {
    // a broken logger never breaks a draft view
  }
}

// --- Offices: the rule id of an old office suggestion ---

/** handle (lower case, no @) -> the rule id of the office listing it; null when two offices list it */
export type OfficeSources = ReadonlyMap<string, OfficeRuleId | null>;

/** The handles of subject-handles.json `offices`, each with its office's rule id ("office_alias.rajasthan_cs") */
export function officeSourcesFrom(json: unknown): Map<string, OfficeRuleId | null> {
  const out = new Map<string, OfficeRuleId | null>();
  const offices = json && typeof json === "object" ? (json as { offices?: unknown }).offices : undefined;
  if (!offices || typeof offices !== "object" || Array.isArray(offices)) return out;
  for (const [key, office] of Object.entries(offices as Record<string, unknown>)) {
    if (key.startsWith("_") || !office || typeof office !== "object") continue;
    const handles = (office as { handles?: unknown }).handles;
    if (!Array.isArray(handles)) continue;
    const source: OfficeRuleId = `office_alias.${key}`;
    for (const h of handles) {
      if (typeof h !== "string") continue;
      const k = h.trim().replace(/^@/, "").toLowerCase();
      if (k) out.set(k, out.has(k) && out.get(k) !== source ? null : source);
    }
  }
  return out;
}

const OFFICES_RECHECK_MS = 60_000;
const officeFile: { sources: OfficeSources | null; path: string; mtimeMs: number; checkedAt: number } = { sources: null, path: "", mtimeMs: -1, checkedAt: 0 };

/**
 * The offices of the worker's subject-handles.json (SUBJECT_HANDLES_FILE overrides it, as for the desk handles),
 * read again when it changes, checked at most once a minute. A file that cannot be read keeps the last good copy;
 * until one is read no office is known.
 */
function officeSources(now = Date.now()): OfficeSources | null {
  const path = process.env.SUBJECT_HANDLES_FILE ?? SUBJECT_HANDLES_FILE;
  if (path === officeFile.path && now - officeFile.checkedAt < OFFICES_RECHECK_MS) return officeFile.sources;
  officeFile.checkedAt = now;
  try {
    const { mtimeMs } = statSync(path);
    if (path !== officeFile.path || mtimeMs !== officeFile.mtimeMs || officeFile.sources === null) {
      officeFile.sources = officeSourcesFrom(JSON.parse(readFileSync(path, "utf8")));
      officeFile.mtimeMs = mtimeMs;
    }
  } catch (err) {
    try {
      logger?.warn({ err, path }, "subject-handles.json unreadable; old office suggestions get no rule id from it");
    } catch {
      // a broken logger never breaks a draft view
    }
  }
  officeFile.path = path;
  return officeFile.sources;
}

/** Tests: forget the offices read so far */
export function resetOfficeSources(): void {
  Object.assign(officeFile, { sources: null, path: "", mtimeMs: -1, checkedAt: 0 });
}

/** The rule id of the office listing `handle` ("@svoruganti1466" -> "office_alias.rajasthan_cs"); undefined when unknown */
function officeSourceOf(handle: string): OfficeRuleId | undefined {
  return officeSources()?.get(handle.trim().replace(/^@/, "").toLowerCase()) ?? undefined;
}

const REASONS: ReadonlySet<string> = new Set(["cm", "police", "collector", "government", "state_police", "subject", "desk", "party", "reporter", "prior", "beat", "office"]);

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

/** One stored mention suggestion, checked, with its rule id filled in when the row predates it; null when unusable */
function mentionView(raw: unknown): { view: MentionSuggestionView | null; malformed: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { view: null, malformed: ["item"] };
  const m = raw as Record<string, unknown>;
  if (typeof m.handle !== "string" || typeof m.handleId !== "string") return { view: null, malformed: ["handle"] };
  const malformed: string[] = [];
  for (const k of ["score", "n"] as const) if (m[k] !== undefined && num(m[k]) === undefined) malformed.push(k);
  for (const k of ["source", "reason", "detail"] as const) if (m[k] !== undefined && str(m[k]) === undefined) malformed.push(k);
  // "rule:<reason>:<handle>" / "suggest:<reason>:<handle>": the reason code the rule id falls back to
  const code = /^(?:rule|suggest):([a-z_]+):/.exec(m.handleId)?.[1];
  const stored = str(m.source);
  // A prior pick's rule id is fixed (core's PriorHandlePick needs score and n, which an old row may lack). An
  // office's is the office listing the handle: core's fallback for "office" is always the CM's office, which
  // would mislabel the Chief Secretary's; a handle no office lists gets none rather than a guess.
  const derived =
    !stored && code && REASONS.has(code)
      ? code === "prior" ? PROPOSAL_SOURCES.reporterPrior
        : code === "office" ? officeSourceOf(m.handle)
        : handleSource({ handle: m.handle, reason: code as RuleHandlePick["reason"] })
      : undefined;
  const reason = str(m.reason);
  const detail = str(m.detail);
  const score = num(m.score);
  const n = num(m.n);
  // Any other stored field passes through as it always did; the contract's own fields only when well-formed
  const { source: _s, reason: _r, detail: _d, score: _sc, n: _n, entity, ...rest } = m;
  const view: MentionSuggestionView = {
    ...rest, handleId: m.handleId, handle: m.handle, exact: m.exact === true,
    ...(typeof entity === "string" && { entity }),
    ...(stored ? { source: stored } : derived ? { source: derived, sourceDerived: true as const } : {}),
    ...(reason && { reason }), ...(detail && { detail }), ...(score !== undefined && { score }), ...(n !== undefined && { n }),
  };
  return { view, malformed };
}

/** One stored item rebuilt from its well-formed contract fields only (never passed on raw); null when unusable. Never throws. */
function wellFormedMention(raw: unknown): MentionSuggestionView | null {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.handle !== "string" || typeof m.handleId !== "string") return null;
    const entity = typeof m.entity === "string" ? m.entity : undefined;
    const source = str(m.source);
    const reason = str(m.reason);
    const detail = str(m.detail);
    const score = num(m.score);
    const n = num(m.n);
    return {
      handleId: m.handleId, handle: m.handle, exact: m.exact === true,
      ...(entity !== undefined && { entity }), ...(source && { source }), ...(reason && { reason }), ...(detail && { detail }),
      ...(score !== undefined && { score }), ...(n !== undefined && { n }),
    };
  } catch {
    // an item that cannot even be read is left out
    return null;
  }
}

/**
 * The fallback when mapping failed: only the items that are objects with a string handle and handleId, each
 * rebuilt from its well-formed contract fields (never passed on raw); [] when the value is not a list. Never throws.
 */
function wellFormedMentions(stored: unknown): MentionSuggestionView[] {
  const out: MentionSuggestionView[] = [];
  try {
    if (!Array.isArray(stored)) return out;
    for (const raw of stored) {
      const view = wellFormedMention(raw);
      if (view) out.push(view);
    }
  } catch {
    // a list that cannot be walked: whatever was rebuilt before it broke
  }
  return out;
}

/** A tag as the desk sees it: one Unicode form (NFC), so a Hindi tag typed two ways is one tag */
const nfc = (tag: string) => tag.normalize("NFC");
/** The key a tag is matched to its rule by: NFC, lower case */
const tagKey = (tag: string) => nfc(tag).toLowerCase();

/** The stored tags that are strings, in NFC, each once, in order; [] when the value is not a list. Never throws. */
function wellFormedTags(tags: unknown): string[] {
  const out: string[] = [];
  try {
    if (!Array.isArray(tags)) return out;
    const seen = new Set<string>();
    for (const t of tags) {
      try {
        if (typeof t !== "string") continue;
        const tag = nfc(t);
        if (!seen.has(tag)) {
          seen.add(tag);
          out.push(tag);
        }
      } catch {
        // a tag that cannot be normalised is left out
      }
    }
  } catch {
    // a list that cannot be walked: whatever was read before it broke
  }
  return out;
}

export function mentionSuggestionsView(stored: unknown, draftId?: string): MentionSuggestionView[] {
  try {
    if (!Array.isArray(stored)) {
      if (stored !== null && stored !== undefined) report(draftId, "mention", { type: typeof stored }, "mention suggestions are not a list; none shown");
      return [];
    }
    const out: MentionSuggestionView[] = [];
    let dropped = 0;
    const fields = new Set<string>();
    for (const raw of stored) {
      // One item that breaks while being mapped costs only itself: it goes out rebuilt from its well-formed
      // fields (no derived rule id), or not at all
      let mapped: ReturnType<typeof mentionView>;
      try {
        mapped = mentionView(raw);
      } catch {
        const view = wellFormedMention(raw);
        mapped = { view, malformed: [view ? "unreadable" : "item"] };
      }
      const { view, malformed } = mapped;
      if (view) out.push(view);
      else dropped++;
      for (const f of malformed) fields.add(f);
    }
    if (dropped || fields.size) report(draftId, "mention", { dropped, malformedFields: [...fields] }, "mention suggestions: unusable items left out or malformed fields dropped");
    return out;
  } catch (err) {
    const out = wellFormedMentions(stored);
    report(draftId, "mention", { err, kept: out.length }, "mention suggestions could not be mapped; only the well-formed items sent");
    return out;
  }
}

/** handle_pick.tagSuggestions by tag key (NFC, lower case), the first rule of a tag winning. Never throws. */
function tagRules(pick: DraftHandlePick | null | undefined, draftId: string | undefined): Map<string, Record<string, unknown>> {
  const byTag = new Map<string, Record<string, unknown>>();
  let items: unknown;
  try {
    items = pick?.tagSuggestions;
  } catch (err) {
    report(draftId, "hashtag", { err }, "handle_pick.tagSuggestions could not be read; tags sent as plain strings");
    return byTag;
  }
  if (items === undefined || items === null) return byTag;
  if (!Array.isArray(items)) {
    report(draftId, "hashtag", {}, "handle_pick.tagSuggestions is not a list; tags sent as plain strings");
    return byTag;
  }
  let bad = 0;
  try {
    for (const it of items as unknown[]) {
      try {
        const tag = it && typeof it === "object" ? (it as { tag?: unknown }).tag : undefined;
        if (typeof tag !== "string") {
          bad++;
          continue;
        }
        const key = tagKey(tag);
        if (!byTag.has(key)) byTag.set(key, it as Record<string, unknown>);
      } catch {
        bad++;
      }
    }
  } catch {
    bad++; // a list that cannot be walked: the rules read before it broke
  }
  if (bad) report(draftId, "hashtag", { dropped: bad }, "hashtag suggestion rules: unusable items left out");
  return byTag;
}

/** One tag (already NFC) with its rule when known; the bare tag when the rule cannot be read. Never throws. */
function tagView(tag: string, it: Record<string, unknown> | undefined): HashtagSuggestionView {
  if (!it) return tag;
  try {
    const source = str(it.source);
    if (!source) return tag;
    const reason = str(it.reason);
    const score = num(it.score);
    const n = num(it.n);
    return { tag, source, ...(reason && { reason }), ...(score !== undefined && { score }), ...(n !== undefined && { n }) };
  } catch {
    return tag;
  }
}

/**
 * The hashtag suggestions, each tag with its rule when handle_pick knows it, in stored order. Tags go out in NFC
 * and are matched to their rule by NFC + lower case, so one tag stored in two Unicode forms shows once, with its
 * rule. A tag that is not a string is left out; a rule that cannot be read costs only its own tag's reason.
 */
export function hashtagSuggestionsView(tags: readonly string[], pick: DraftHandlePick | null | undefined, draftId?: string): HashtagSuggestionView[] {
  try {
    if (!Array.isArray(tags)) {
      if (tags !== null && tags !== undefined) report(draftId, "hashtag", { type: typeof tags }, "hashtag suggestions are not a list; none shown");
      return [];
    }
    const byTag = tagRules(pick, draftId);
    const out: HashtagSuggestionView[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const raw of tags as readonly unknown[]) {
      try {
        if (typeof raw !== "string") {
          dropped++;
          continue;
        }
        const tag = nfc(raw);
        if (seen.has(tag)) continue;
        seen.add(tag);
        out.push(tagView(tag, byTag.get(tag.toLowerCase())));
      } catch {
        dropped++;
      }
    }
    if (dropped) report(draftId, "hashtag", { dropped }, "hashtag suggestions: tags that are not strings left out");
    return out;
  } catch (err) {
    const out = wellFormedTags(tags);
    report(draftId, "hashtag", { err, kept: out.length }, "hashtag suggestions could not be mapped; only the stored strings sent, as plain tags");
    return out;
  }
}
