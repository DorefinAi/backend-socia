// Every hashtag and handle a draft carries or offers, with the rule that produced it (reporter-prior brief §2.3).
//
// THE CONTRACT the decision log, the API and the desk read: one Proposal per item, `layer` "emit" (on the post
// by itself) or "suggest" (one click to add, never applied), `source` a STABLE rule id so the log can score each
// rule on its own, `reason` the line the desk sees. A reporter-prior item also carries its smoothed `score` and
// the reporter's sample size `n`. Rule ids are listed here and nowhere else; renaming one breaks the log's history.

import type { HandlePick } from "./handles";

export type ProposalKind = "hashtag" | "handle";
export type ProposalLayer = "emit" | "suggest";

export interface Proposal {
  /** "#Jaipur", "@RajGovOfficial" */
  item: string;
  kind: ProposalKind;
  layer: ProposalLayer;
  /** A stable rule id (SOURCES below, or "district.<from>" / "beat.<key>") */
  source: string;
  /** Why, in words the desk can agree or disagree with */
  reason: string;
  /** reporter_prior only: the smoothed rate the threshold was read against */
  score?: number;
  /** reporter_prior only: the reporter's posts the rate rests on */
  n?: number;
  /** Phase 2 exploration (brief §7.2.3): shown regardless of the reporter's rate. Unused in phase 1. */
  explore?: boolean;
}

/** A hashtag offered to the desk, with its rule: the structured form of BreakingDraft.hashtagSuggestions */
export interface TagSuggestion {
  /** "#Jaipur" */
  tag: string;
  source: string;
  reason: string;
  score?: number;
  n?: number;
}

/** The rule ids. Hashtags first, then handles. */
export const SOURCES = {
  /** The footer: #RajasthanWithFirstIndia / #FirstIndiaNews by the story's geography */
  brand: "brand.geo",
  /** The Hindi town tag after the district in line 1 */
  town: "town",
  /** A district the headline names next to another one: two districts, neither taken (offered) */
  headlineConflict: "district.headline_conflict",
  /** The org's topic rules (offered) */
  topic: "topic_rule",
  /** campaigns.json: date-windowed campaign and keyword tags (offered) */
  campaign: "campaign",
  /** A reporter's desk rule: rituraj's "#Jaipur:" when the post names no district (brief §4) */
  reporterPolicy: "reporter_policy",
  /** A handle or hashtag the reporter's measured rates make likely (brief §3) */
  reporterPrior: "reporter_prior",
  /** "CM" / "मुख्यमंत्री" with no name (brief §6) */
  officeCm: "office_alias.rajasthan_cm",
} as const;

/** The district hashtag's rule id: "district.place_line", "district.tag", "district.file_code", "district.inferred.headline" */
export const districtSource = (from: string, inferred: boolean): string => `district.${inferred ? "inferred." : ""}${from}`;

/** A declared beat's rule id: "beat.education" */
export const beatSource = (beat: string): string => `beat.${beat}`;

/** The rule id of a handle the picker chose, from its HandlePick (an explicit `source` wins) */
export function handleSource(h: HandlePick): string {
  if (h.source) return h.source;
  switch (h.reason) {
    case "cm": return "cm.name";
    case "police": return "district.police";
    case "collector": return "district.collector";
    case "government": return "state.government";
    case "state_police": return "state.police";
    case "subject": return "subject";
    case "desk": return "desk";
    case "party": return "party";
    case "reporter": return "reporter.byline";
    case "prior": return SOURCES.reporterPrior;
    case "beat": return "beat";
    case "office": return SOURCES.officeCm;
  }
}

/** The line shown for a handle: its own detail, else its title, else the rule */
export const handleReason = (h: HandlePick): string => h.detail ?? h.title ?? handleSource(h);

/** A HandlePick as a Proposal */
export const handleProposal = (h: HandlePick, layer: ProposalLayer): Proposal => ({
  item: `@${h.handle}`, kind: "handle", layer, source: handleSource(h), reason: handleReason(h),
  ...(h.score !== undefined && { score: h.score }), ...(h.n !== undefined && { n: h.n }),
});

/** A TagSuggestion as a Proposal */
export const tagProposal = (t: TagSuggestion): Proposal => ({
  item: t.tag, kind: "hashtag", layer: "suggest", source: t.source, reason: t.reason,
  ...(t.score !== undefined && { score: t.score }), ...(t.n !== undefined && { n: t.n }),
});
