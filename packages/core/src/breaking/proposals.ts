// Every hashtag and handle a draft carries or offers, with the rule that produced it (reporter-prior brief §2.3).
//
// THE CONTRACT the decision log, the API and the desk read: one Proposal per item, `layer` "emit" (on the post
// by itself) or "suggest" (one click to add, never applied), `source` a STABLE rule id so the log can score each
// rule on its own, `reason` the line the desk sees. A reporter-prior item, and only one, also carries its smoothed
// `score` and the reporter's sample size `n`. Rule ids are listed here and nowhere else; renaming one breaks the
// log's history.

import type { HandlePick } from "./handles";

export type ProposalKind = "hashtag" | "handle";
export type ProposalLayer = "emit" | "suggest";

/** The fixed rule ids. Hashtags first, then handles. */
export const PROPOSAL_SOURCES = {
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

/** The rule ids of the handle picker's own reasons (handleSource) */
export type HandleRuleId =
  | "cm.name" | "district.police" | "district.collector" | "state.government" | "state.police" | "subject" | "desk" | "party"
  | "reporter.byline" | "beat";

/** "district.place_line", "district.inferred.headline", ... */
export type DistrictRuleId = `district.${string}`;
/** A declared beat: "beat.education" */
export type BeatRuleId = `beat.${string}`;
/** An office named without its holder: "office_alias.rajasthan_cm" */
export type OfficeRuleId = `office_alias.${string}`;

/** Every rule id a Proposal may carry */
export type RuleId = (typeof PROPOSAL_SOURCES)[keyof typeof PROPOSAL_SOURCES] | HandleRuleId | DistrictRuleId | BeatRuleId | OfficeRuleId;
/** The reporter prior's id: the only rule whose items carry a score and a sample size */
export type PriorRuleId = typeof PROPOSAL_SOURCES.reporterPrior;
/** Every other rule id */
export type PlainRuleId = Exclude<RuleId, PriorRuleId>;

interface ProposalBase {
  /** "#Jaipur", "@RajGovOfficial" */
  item: string;
  kind: ProposalKind;
  layer: ProposalLayer;
  /** Why, in words the desk can agree or disagree with */
  reason: string;
}

/** A reporter-prior item: the smoothed rate the threshold was read against, and the posts it rests on */
export interface PriorProposal extends ProposalBase {
  source: PriorRuleId;
  score: number;
  n: number;
}

/** Any other rule's item: never a score */
export interface RuleProposal extends ProposalBase {
  source: PlainRuleId;
  score?: never;
  n?: never;
}

export type Proposal = PriorProposal | RuleProposal;

/** The Proposal fields a hashtag suggestion carries, with `item` called `tag`, per variant (so the two cannot drift) */
type AsTagSuggestion<P> = P extends Proposal ? Omit<P, "item" | "kind" | "layer"> & { /** "#Jaipur" */ tag: string } : never;

/** A hashtag offered to the desk, with its rule: the structured form of BreakingDraft.hashtagSuggestions */
export type TagSuggestion = AsTagSuggestion<Proposal>;

/** The district hashtag's rule id: "district.place_line", "district.tag", "district.file_code", "district.inferred.headline" */
export const districtSource = (from: string, inferred: boolean): DistrictRuleId => `district.${inferred ? "inferred." : ""}${from}`;

/** A declared beat's rule id: "beat.education" */
export const beatSource = (beat: string): BeatRuleId => `beat.${beat}`;

function assertNever(x: never): never {
  throw new Error(`unhandled handle reason: ${String(x)}`);
}

type PlainHandlePick = Exclude<HandlePick, { reason: "prior" }>;

/** The rule id of any handle but a prior one: an explicit `source` wins, else the picker's reason */
function plainHandleSource(h: PlainHandlePick): PlainRuleId {
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
    case "beat": return "beat";
    case "office": return PROPOSAL_SOURCES.officeCm;
    default: return assertNever(h.reason);
  }
}

/** The rule id of a handle the picker chose, from its HandlePick (an explicit `source` wins) */
export const handleSource = (h: HandlePick): RuleId => (h.reason === "prior" ? h.source : plainHandleSource(h));

/** The line shown for a handle: its own detail, else its title, else the rule */
export const handleReason = (h: HandlePick): string => h.detail ?? h.title ?? handleSource(h);

/** A HandlePick as a Proposal */
export function handleProposal(h: HandlePick, layer: ProposalLayer): Proposal {
  const base = { item: `@${h.handle}`, kind: "handle" as const, layer, reason: handleReason(h) };
  return h.reason === "prior" ? { ...base, source: h.source, score: h.score, n: h.n } : { ...base, source: plainHandleSource(h) };
}

/** A TagSuggestion as a Proposal */
export function tagProposal(t: TagSuggestion): Proposal {
  const base = { item: t.tag, kind: "hashtag" as const, layer: "suggest" as const, reason: t.reason };
  return t.source === PROPOSAL_SOURCES.reporterPrior ? { ...base, source: t.source, score: t.score, n: t.n } : { ...base, source: t.source };
}
