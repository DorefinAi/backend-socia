// The breaking draft's suggestions as the desk receives them (reporter-prior brief §2.3, UI contract): each item
// may carry the stable rule id (`source`), the reason line (`reason`) and, for the reporter prior, `score` and
// `n`. Old clients read only the fields they always had.
//
// - mentionSuggestions: the stored items, passed through. Items stored before the rule ids existed get a
//   `source` derived from the reason code in their handleId ("rule:police:..." → "district.police"), as core does.
// - hashtagSuggestions: plain strings, except a tag whose rule is known (handle_pick.tagSuggestions), which goes
//   out as { tag, source, reason, score?, n? }. Reporter and policy tags always have one.

import { handleSource, type HandlePick } from "@socia/core";
import type { DraftHandlePick } from "@socia/db";

export interface MentionSuggestionView {
  handleId: string;
  entity: string;
  handle: string;
  exact: boolean;
  source?: string;
  reason?: string;
  /** The prior's "why" line from core (HandlePick.detail), when it has one */
  detail?: string;
  score?: number;
  n?: number;
}

export type HashtagSuggestionView = string | { tag: string; source?: string; reason?: string; score?: number; n?: number };

const REASONS: ReadonlySet<string> = new Set(["cm", "police", "collector", "government", "state_police", "subject", "desk", "party", "reporter", "prior", "beat", "office"]);

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);

/** One stored mention suggestion, checked, with its rule id filled in when the row predates it */
function mentionView(raw: unknown): MentionSuggestionView | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.handle !== "string" || typeof m.handleId !== "string") return null;
  const view: MentionSuggestionView = { handleId: m.handleId, entity: typeof m.entity === "string" ? m.entity : "", handle: m.handle, exact: m.exact === true };
  // "rule:<reason>:<handle>" / "suggest:<reason>:<handle>": the reason code the rule id falls back to
  const code = /^(?:rule|suggest):([a-z_]+):/.exec(m.handleId)?.[1];
  const source = str(m.source) ?? (code && REASONS.has(code) ? handleSource({ handle: m.handle, reason: code as HandlePick["reason"] }) : undefined);
  const reason = str(m.reason);
  const detail = str(m.detail);
  const score = num(m.score);
  const n = num(m.n);
  // Any other stored field passes through as it always did; the contract's own fields only when well-formed
  const { source: _s, reason: _r, detail: _d, score: _sc, n: _n, ...rest } = m;
  return {
    ...rest, ...view, ...(source && { source }), ...(reason && { reason }), ...(detail && { detail }),
    ...(score !== undefined && { score }), ...(n !== undefined && { n }),
  };
}

export function mentionSuggestionsView(stored: unknown): MentionSuggestionView[] {
  return Array.isArray(stored) ? stored.map(mentionView).filter((m): m is MentionSuggestionView => m !== null) : [];
}

/** The hashtag suggestions, each tag with its rule when handle_pick knows it; the order and the strings as stored */
export function hashtagSuggestionsView(tags: readonly string[], pick: DraftHandlePick | null | undefined): HashtagSuggestionView[] {
  const items = Array.isArray(pick?.tagSuggestions) ? pick.tagSuggestions : [];
  const byTag = new Map<string, Record<string, unknown>>();
  for (const it of items) {
    if (it && typeof it === "object" && typeof it.tag === "string" && !byTag.has(it.tag.toLowerCase())) byTag.set(it.tag.toLowerCase(), it as unknown as Record<string, unknown>);
  }
  return tags.map((tag) => {
    const it = byTag.get(tag.toLowerCase());
    const source = str(it?.source);
    if (!it || !source) return tag;
    const reason = str(it.reason);
    const score = num(it.score);
    const n = num(it.n);
    return { tag, source, ...(reason && { reason }), ...(score !== undefined && { score }), ...(n !== undefined && { n }) };
  });
}
