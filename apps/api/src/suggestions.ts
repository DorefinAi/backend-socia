// The breaking draft's suggestions as the desk receives them (reporter-prior brief §2.3, UI contract): each item
// may carry the stable rule id (`source`), the reason line (`reason`), core's `detail` and, for the reporter
// prior, `score` and `n`. Old clients read only the fields they always had.
//
// - mentionSuggestions: the stored items, passed through. Items stored before the rule ids existed get a
//   `source` derived from the reason code in their handleId ("rule:police:..." → "district.police"), as core does,
//   marked `sourceDerived: true`.
// - hashtagSuggestions: plain strings, except a tag whose rule is known (handle_pick.tagSuggestions), which goes
//   out as { tag, source, reason, score?, n? }. Reporter and policy tags always have one.
//
// A stored item that is not usable is left out and reported once per draft; anything unexpected while mapping
// falls back to the arrays as stored, so a draft always opens.

import { handleSource, PROPOSAL_SOURCES, type RuleHandlePick } from "@socia/core";
import type { DraftHandlePick } from "@socia/db";

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

/** Drafts already reported, so a draft opened all day is reported once (bounded) */
const reported = new Set<string>();
function report(draftId: string, obj: Record<string, unknown>, msg: string): void {
  if (reported.has(draftId)) return;
  if (reported.size >= 5000) reported.clear();
  reported.add(draftId);
  try {
    logger?.warn({ draftId, ...obj }, msg);
  } catch {
    // a broken logger never breaks a draft view
  }
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
  // A prior pick's rule id is fixed (core's PriorHandlePick needs score and n, which an old row may lack)
  const derived =
    !stored && code && REASONS.has(code)
      ? code === "prior" ? PROPOSAL_SOURCES.reporterPrior : handleSource({ handle: m.handle, reason: code as RuleHandlePick["reason"] })
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

export function mentionSuggestionsView(stored: unknown, draftId = "?"): MentionSuggestionView[] {
  try {
    if (!Array.isArray(stored)) {
      if (stored !== null && stored !== undefined) report(draftId, { type: typeof stored }, "mention suggestions are not a list; none shown");
      return [];
    }
    const out: MentionSuggestionView[] = [];
    let dropped = 0;
    const fields = new Set<string>();
    for (const raw of stored) {
      const { view, malformed } = mentionView(raw);
      if (view) out.push(view);
      else dropped++;
      for (const f of malformed) fields.add(f);
    }
    if (dropped || fields.size) report(draftId, { dropped, malformedFields: [...fields] }, "mention suggestions: unusable items left out or malformed fields dropped");
    return out;
  } catch (err) {
    report(draftId, { err }, "mention suggestions could not be mapped; sent as stored");
    return stored as MentionSuggestionView[];
  }
}

/** The hashtag suggestions, each tag with its rule when handle_pick knows it; the order and the strings as stored */
export function hashtagSuggestionsView(tags: readonly string[], pick: DraftHandlePick | null | undefined, draftId = "?"): HashtagSuggestionView[] {
  try {
    const items = pick?.tagSuggestions;
    if (items !== undefined && !Array.isArray(items)) report(draftId, {}, "handle_pick.tagSuggestions is not a list; tags sent as plain strings");
    const byTag = new Map<string, Record<string, unknown>>();
    let bad = 0;
    for (const it of Array.isArray(items) ? items : []) {
      if (it && typeof it === "object" && typeof it.tag === "string") {
        if (!byTag.has(it.tag.toLowerCase())) byTag.set(it.tag.toLowerCase(), it as unknown as Record<string, unknown>);
      } else bad++;
    }
    if (bad) report(draftId, { dropped: bad }, "hashtag suggestion rules: unusable items left out");
    return tags.map((tag) => {
      const it = byTag.get(tag.toLowerCase());
      const source = str(it?.source);
      if (!it || !source) return tag;
      const reason = str(it.reason);
      const score = num(it.score);
      const n = num(it.n);
      return { tag, source, ...(reason && { reason }), ...(score !== undefined && { score }), ...(n !== undefined && { n }) };
    });
  } catch (err) {
    report(draftId, { err }, "hashtag suggestions could not be mapped; sent as stored");
    return [...tags];
  }
}
