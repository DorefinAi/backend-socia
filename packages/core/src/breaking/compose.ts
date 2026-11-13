// The phase-1 X post for a breaking file, in the @1stIndiaNews desk style:
//
//   #Jodhpur #रावतभाटा: <headline>
//
//   <point 1>, <point 2>, <point 3 cut right after a linking word>...
//
//   #RajasthanWithFirstIndia #RajasthanPolice @CP_Jodhpur
//
// bodyText is lines 1–2 (editable), hashtags the footer tag and 0–2 category tags, mentions the handles;
// assemblePostText() puts them together exactly as the desk copies it. Always within X's 280 (weighted).

import { fold } from "../fold";
import { X_LIMIT, assemblePostText, cutOnWords } from "../compose";
import type { HashtagGazetteer } from "../hashtags";
import { xLen } from "../xtext";
import { pickCategoryTags } from "./categories";
import { pickHandlesExplained, type HandlePick, type HandleRules } from "./handles";
import { EMPTY_DESK_HANDLE_RULES, type DeskHandleRules } from "./desk-handles";
import { EMPTY_PARTY_RULES, type PartyRules } from "./parties";
import { EMPTY_REPORTER_RULES, pickReporter, reporterDistrict, type ReporterMatch, type ReporterRules } from "./reporters";
import { headlineDistrictTags, inferHeadlineDistrict, isExplicitDistrict, parseBreaking, type DistrictFrom } from "./parse";
import {
  EMPTY_NORMALISER, EMPTY_SUGGEST_RULES, HASHTAG, emittable, explicit, inferred, normaliseTag, stripLinks, suggestTags,
  type Sourced, type SuggestRules, type TagNormaliser,
} from "./post-tags";
import type { StoryClass } from "./storyclass";
import type { DistrictInfo, PlaceBook } from "./places";
import { EMPTY_SUBJECT_RULES, type SubjectRules } from "./subjects";
import { SOURCES, districtSource, handleProposal, tagProposal, type Proposal, type TagSuggestion } from "./proposals";

/** A headline that starts with the desk's own hashtags and a colon ("#BJP:", "#Congress #Kota:") */
const DESK_TAG_RUN = /^(?:#\S+\s*){1,3}[:：]/u;
export const RAJASTHAN_FOOTER = "#RajasthanWithFirstIndia";
export const NATIONAL_FOOTER = "#FirstIndiaNews";
/** The desk cuts with three dots */
export const BREAKING_CUT = "...";
/** The desk's posts run 190–265 (median 218): points stop here even when X would allow more */
export const BREAKING_TARGET = 265;
/**
 * Bumped when the layout changes, so drafts of each format can be told apart.
 * b2: category hashtags, the cut after a linking word, subject handles, police/collector only when acting.
 * b4: story-class routing, 3 slots, party and reporter handles, the judicial class, no government fallback.
 * b5: the footer is the only hashtag applied on its own; topic rules are offered to the desk instead.
 * b6: URLs out of every line read; desk tag typos normalised; an inferred district, campaign and #ACB tags
 *     offered, never applied; handle suggestions (HASHTAG_HANDLE_CHANGES_v3).
 * b7: provenance (b6 fix brief): only an explicit district (the copy, or the file code of a reporter tied to
 *     one district) goes in line 1 or picks a police, collector or administration handle; a district the
 *     headline text or the reporter suggests is offered. A party named only in the
 *     points, a party wing and a seasonal institution (@CeoRajasthan) are offered, not tagged.
 */
export const BREAKING_FORMAT = "b7";

export interface BreakingComposeInput {
  headline: string;
  points: string[];
  /** stories.district: English district or national place, or null */
  district: string | null;
  /**
   * Where `district` came from (parseBreaking; stories.district_from). place_line, headline_prefix and tag are
   * the desk's own words; file_code counts as stated unless trustsFileCode refuses the reporter; text is only
   * offered.
   * OMITTED (undefined): the caller states the district itself (a replayed post's leading tag, a test), and it
   * is taken as explicit. NULL: unknown (a row stored before migration 0023). The worker recovers it by parsing
   * the stored file again (recoverDistrictFrom); when it cannot, storyDistrict states the district only when it
   * equals a trusted file code and offers it otherwise.
   */
  districtFrom?: DistrictFrom | null;
  /** Hindi town from the place line */
  town: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
  /** The headline line as the file had it, place prefix included (parseBreaking); read by the class check */
  rawHeadline?: string;
  /** slotFromTags().reporterToken — the reporter list's key. Never read from the post text. */
  reporterToken?: string | null;
  /**
   * slotFromTags().district — the FILING desk's code. Stated (explicit) when the copy names no district, unless
   * the reporter is a bureau filing for no single district; compared with the copy for a warning.
   */
  fileDistrict?: string | null;
  /** slotFromTags().unknownCode — surfaced as a warning so a missing district code gets found */
  unknownBureauCode?: string | null;
}

export interface BreakingComposeOptions {
  /** Identifies the data files and rules behind the draft: composeVersion is `${BREAKING_FORMAT}.${version}` */
  version?: string;
  /** The org's hashtag rules (topic rules give the category tags); none: the footer tag only */
  topics?: HashtagGazetteer | null;
  /** subject-handles.json */
  subjects?: SubjectRules;
  /** Handles the desk added with keywords (the org's handle_directory, source "desk") */
  desk?: DeskHandleRules;
  /** reporter-handles.json plus the tokens editors taught us */
  reporters?: ReporterRules;
  /** party-handles.json */
  parties?: PartyRules;
  /** hashtag-normalise.json: the desk's typos in its own tag run, corrected and flagged */
  normaliser?: TagNormaliser;
  /** campaigns.json: date-windowed campaign tags and keyword tags (#ACB), OFFERED only */
  suggestRules?: SuggestRules;
  /** When the story came in, for the campaign windows; none: campaign tags are not offered */
  at?: Date;
  limit?: number;
  target?: number;
}

export interface BreakingDraft {
  bodyText: string;
  /** The tags that go on the post by themselves: the footer, and nothing else */
  hashtags: string[];
  /**
   * Topic tags the org's rules matched, for the desk to accept with a click. Never applied on their own:
   * see the note in composeBreaking for what auto-applying them measured at.
   */
  hashtagSuggestions: string[];
  /** hashtagSuggestions with the rule behind each and its reason line, in the same order (brief §2.3) */
  hashtagSuggestionItems: TagSuggestion[];
  /**
   * Everything the draft carries or offers, one entry per item, with layer, rule id and reason: the decision
   * log's `proposals` (brief §2.3). Built from the fields here, never a second decision.
   */
  proposals: Proposal[];
  mentions: string[];
  handles: HandlePick[];
  /** Handles offered to the desk and not in the post (handles.ts `suggestions`) */
  handleSuggestions: HandlePick[];
  /** The class the handles were chosen by, for the draft's audit line */
  cls: StoryClass;
  /** Why that class, in words the desk can agree or disagree with */
  why: string;
  /** Never blocks a tag: an unknown district code, a reporter filing from another district */
  warnings: string[];
  /** The file named a reporter the list does not carry, so the post went out with no byline */
  unmatchedReporter: string | null;
  /** The headline itself had to be cut to fit */
  headlineCut: boolean;
  composeVersion: string;
}

/** "#बड़ीसादड़ी": spaces and punctuation out, Devanagari marks kept */
export function townHashtag(town: string): string {
  const bare = town.replace(/[^\p{L}\p{M}\p{N}_]+/gu, "");
  return bare ? `#${bare}` : "";
}

/** Each point without its closing punctuation, so ", " can join them */
const trimPoint = (p: string) => p.normalize("NFC").replace(/[\s।॥|.,;:!-]+$/u, "").replace(/\s+/g, " ").trim();
/** Punctuation left dangling before the dots */
const DANGLING = /[\s,،;:।॥|\-–—]+$/u;

const wordSegmenter = new Intl.Segmenter("hi", { granularity: "word" });

/**
 * Words after which a point can stop so that the outcome is withheld: "बदमाशों ने...", "हादसे के बाद...",
 * "मामले को लेकर...". Postpositions, conjunctions and a few relational nouns.
 */
export const LINKING_WORDS: ReadonlySet<string> = new Set(
  [
    "का", "की", "के", "को", "से", "में", "पर", "ने", "और", "व", "एवं", "तथा", "जबकि", "बाद", "लेकर", "दौरान", "तक", "लिए", "साथ",
    "द्वारा", "बीच", "सहित", "समेत", "खिलाफ", "बावजूद", "चलते", "जरिए", "कि", "लेकिन", "पहले",
  ].map((w) => w.normalize("NFC")),
);
/** "की गई", "को है": after these the word before is a verb or complete, not a link */
const AUXILIARIES: ReadonlySet<string> = new Set(
  [
    "गई", "गया", "गए", "गयी", "जा", "जाएगी", "जाएगा", "जाएंगे", "जाती", "जाता", "जाते", "है", "हैं", "था", "थी", "थे", "रही", "रहा", "रहे", "हो",
    "होगा", "होगी", "होंगे", "हुआ", "हुई", "हुए", "सकता", "सकती", "सकते", "चुकी", "चुका", "चुके",
  ].map((w) => w.normalize("NFC")),
);
const NUMBER = /^[\p{N}.,:]+$/u;

interface Word {
  text: string;
  start: number;
  end: number;
}

const wordsOf = (text: string): Word[] =>
  [...wordSegmenter.segment(text)].filter((s) => s.isWordLike).map((s) => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));

const isContent = (w: Word | undefined) => !!w && !LINKING_WORDS.has(w.text) && !AUXILIARIES.has(w.text);

/**
 * Where a point can be cut after a linking word: the end offsets, latest first, each with how many content
 * words it hides. Never before a number range ("10 से 15"), never when the next word is not content (an
 * auxiliary: "की गई"; another link: "के बाद"), never with no content word before it in the point.
 */
export function linkingCuts(point: string): { end: number; hidden: number }[] {
  const words = wordsOf(point);
  const out: { end: number; hidden: number }[] = [];
  let seenContent = false;
  words.forEach((w, i) => {
    const next = words[i + 1];
    if (LINKING_WORDS.has(w.text) && seenContent && isContent(next)) {
      const prev = words[i - 1];
      if (!(prev && NUMBER.test(prev.text) && NUMBER.test(next!.text))) {
        out.push({ end: w.end, hidden: words.slice(i + 1).filter(isContent).length });
      }
    }
    if (isContent(w)) seenContent = true;
  });
  return out.reverse();
}

/**
 * The points as the post's line 2: every point when they all fit; otherwise the longest run of whole points
 * (", "-joined) and the next point cut right after a linking word so its outcome is withheld, then "...". The
 * latest such cut that fits wins, preferring one that hides at least 2 content words. With no linking-word cut
 * that fits, the next point is cut on a word instead; when not one word of it fits, the last whole point is cut
 * instead. The result never ends on a completed point.
 */
export function joinPoints(points: string[], budget: number): string {
  const parts = points.map(trimPoint).filter(Boolean);
  if (!parts.length || budget <= 0) return "";
  const all = parts.join(", ");
  if (xLen(all) <= budget) return all;
  const room = budget - xLen(BREAKING_CUT);

  // Whole points while they fit (with room for the dots after the next one's cut)
  let k = 0;
  let head = "";
  while (k < parts.length) {
    const next = head ? `${head}, ${parts[k]}` : parts[k]!;
    if (xLen(next) > room) break;
    head = next;
    k++;
  }
  // Point i cut after whole points 0..i-1: after a linking word, else on a word; null when not one word fits
  const cutAt = (i: number): string | null => {
    const lead = parts.slice(0, i).map((p) => `${p}, `).join("");
    const point = parts[i]!;
    const left = room - xLen(lead);
    const cuts = linkingCuts(point)
      .map((c) => ({ ...c, text: point.slice(0, c.end).replace(DANGLING, "") }))
      .filter((c) => c.text && xLen(c.text) <= left);
    const best = cuts.find((c) => c.hidden >= 2) ?? cuts.find((c) => c.hidden >= 1);
    if (best) return lead + best.text + BREAKING_CUT;
    // At least one word of the point is held back
    const partial = cutOnWords(point, Math.min(left, xLen(point) - 1)).replace(DANGLING, "");
    return partial ? lead + partial + BREAKING_CUT : null;
  };
  // The next point; when not one word of it fits, the last whole point becomes the cut one
  return cutAt(k) ?? (k > 0 ? cutAt(k - 1) : null) ?? "";
}

/**
 * A reporter whose ROSTER district says nothing about where a story is: listed for no district (a state bureau:
 * Navin's ACB beat) or for several. Their roster entry is never offered as the story's district. Whether their
 * FILE CODE stands is trustsFileCode's question (b6 fix brief P5).
 */
const isBureauReporter = (m: ReporterMatch | null): boolean => !!m && m.districts.length !== 1;
const districtKey = (s: string) => fold(s).replace(/\s+/g, "");
/**
 * Whether the file name's district code can be taken as the story's district for this reporter. A reporter listed
 * for no district files statewide (Navin's ACB bureau: the code is where he sits, not where the story is). A
 * reporter listed for several (Jaipur and Delhi) is trusted when the code is one of them: @aishwaryam99's JPR
 * file is a Jaipur story. A single-district reporter, or none matched, keeps the code as before b6.
 */
const trustsFileCode = (m: ReporterMatch | null, code: DistrictInfo): boolean =>
  !m || m.districts.length === 1 || m.districts.some((d) => districtKey(d) === districtKey(code.name) || districtKey(d) === districtKey(code.tag));

/**
 * The story's district with its provenance. Precedence (user decision, 12 Nov): the desk's own copy (place line,
 * place prefix, a district tag) > the file name's code > (offered only) the headline's district > the
 * reporter's one district.
 *   - explicit: the copy, or the caller stating it (districtFrom omitted);
 *   - explicit: the file code, as before b6 — UNLESS the reporter files for no single district (a state bureau:
 *     Navin's ACB beat files every district's story under JPR). Then the code says where he sits, not where
 *     the story is, and is used for nothing, not even a suggestion;
 *   - inferred: the headline's district (inferHeadlineDistrict's guards), parse's `text` district (a place the
 *     headline or first points mention — on 9 Nov it gave Ajmer for an Uttarakhand story), the reporter's.
 */
export function storyDistrict(story: BreakingComposeInput, book: PlaceBook, reporter: ReporterMatch | null): Sourced<DistrictInfo> | null {
  const own = book.district(story.district);
  if (own && (story.districtFrom === undefined || isExplicitDistrict(story.districtFrom))) return explicit(own, story.districtFrom ?? "caller");
  // A row stored before migration 0023 whose file could not be parsed again: the district is stated only when it
  // is the file code (what the file name says, as before b6); any other value is offered, never tagged
  if (own && story.districtFrom === null) {
    const code = book.district(story.fileDistrict);
    if (code && code.name === own.name && trustsFileCode(reporter, code)) return explicit(own, "legacy_file_code");
    if (!code || code.name !== own.name) return inferred(own, "legacy");
  }
  const fileCode = book.district(story.districtFrom === "file_code" ? story.district : story.fileDistrict);
  if (fileCode && trustsFileCode(reporter, fileCode)) return explicit(fileCode, "file_code");
  const headline = inferHeadlineDistrict(book, story.headline);
  if (headline) return inferred(headline, "headline");
  if (own && story.districtFrom === "text") return inferred(own, "text");
  const filed = isBureauReporter(reporter) ? null : book.district(reporterDistrict(reporter));
  return filed ? inferred(filed, "reporter") : null;
}

/**
 * The provenance of a stored district whose row predates migration 0023 (district_from NULL): the stored file is
 * parsed again, and its answer is used when it names the same district. Null when the file is missing or the
 * parse disagrees (storyDistrict's legacy rule then applies).
 */
export function recoverDistrictFrom(sourceText: string | null | undefined, fileName: string | null | undefined, district: string | null, book: PlaceBook): DistrictFrom | null {
  if (!sourceText || !fileName || !district) return null;
  const p = parseBreaking(sourceText, fileName, book);
  return p.district === district ? p.districtFrom : null;
}

export function composeBreaking(story: BreakingComposeInput, rules: HandleRules, book: PlaceBook, opts: BreakingComposeOptions = {}): BreakingDraft {
  const {
    version = "0", topics = null, subjects = EMPTY_SUBJECT_RULES, desk = EMPTY_DESK_HANDLE_RULES,
    reporters = EMPTY_REPORTER_RULES, parties = EMPTY_PARTY_RULES, limit = X_LIMIT, target = BREAKING_TARGET,
    normaliser = EMPTY_NORMALISER, suggestRules = EMPTY_SUGGEST_RULES, at,
  } = opts;
  // URLs never reach a rule or the post (§2.1): every line this reads is cleaned first
  const flags: string[] = [];
  const clean = (t: string) =>
    stripLinks(t).replace(HASHTAG, (whole, tag: string) => {
      const n = normaliseTag(tag, normaliser);
      if (n.flag && !flags.includes(n.flag)) flags.push(n.flag);
      return n.tag === tag ? whole : `#${n.tag}`;
    }).replace(/[ 	]{2,}/g, " ").trim();
  story = {
    ...story,
    headline: clean(story.headline),
    points: story.points.map(clean).filter(Boolean),
    ...(story.rawHeadline !== undefined && { rawHeadline: clean(story.rawHeadline) }),
  };
  // The district with its provenance (b6 fix brief P0). Only an explicit one sets line 1's hashtag and is the
  // district the handle rules see; everything inferred is offered in hashtagSuggestions and nothing else.
  const reporterPick = pickReporter(story.reporterToken, reporters);
  const reporter = reporterPick.match;
  const district = storyDistrict(story, book, reporter);
  // The file code stood for a reporter the list does not know: say so, since the code is then trusted blind
  const codeWarnings =
    district?.provenance === "explicit" && district.from === "file_code" && reporterPick.unmatchedToken
      ? [`the file names ${reporterPick.unmatchedToken}, who is not in the reporter list; the file code's district (${district.value.name}) was used — check it`]
      : [];
  const place = emittable(district);
  const rajasthan = place ? place.rajasthan : story.rajasthan;
  // A word naming another district: "बूंदी SP ने" in a Jaipur story does not tag Jaipur's police
  const elsewhere = (word: string) => {
    const p = book.lookup(word);
    return p?.kind === "district" && !p.districts.some((d) => d.name === place?.name);
  };
  // The picker sees the explicit district only, so an inferred one cannot choose a police force, a collector
  // or an administration handle however a later rule uses `district`
  const picked = pickHandlesExplained({ ...story, district: place?.name ?? null, rajasthan, elsewhere }, rules, { subjects, desk, reporters, parties, max: 3, at });
  const handles = picked.handles;
  const footer = rajasthan ? RAJASTHAN_FOOTER : NATIONAL_FOOTER;
  // The footer is the only tag that goes on by itself. The topic rules are OFFERED, not applied: measured
  // against 400 published posts (30 Oct 2026), auto-applying them put a tag the desk had not written on
  // 283 posts — #RajasthanElection alone fired 111 times and the desk used it NOT ONCE — and dropped the
  // trailing run's precision from 92.5% to 55.8%. Only 2 of 19 active rules beat a coin flip. A wrong tag
  // costs the desk a deletion on a live post; a missing one costs a click.
  const hashtags = [footer];
  const offered: TagSuggestion[] = [];
  // An inferred district (§2.8) is offered first among the suggestions and goes nowhere else
  if (district?.provenance === "inferred") {
    offered.push({ tag: `#${district.value.tag}`, source: districtSource(district.from, true), reason: `${district.value.name}, inferred from the ${district.from === "reporter" ? "reporter's district" : district.from}: not stated in the copy` });
  }
  for (const t of pickCategoryTags({ headline: story.headline, points: story.points, rajasthan }, topics, [footer])) {
    offered.push({ tag: t, source: SOURCES.topic, reason: "the org's topic rule matched the copy" });
  }
  // District tags in the headline that were not taken as stated (two different districts: a conflict) are offered
  if (!place) {
    for (const d of headlineDistrictTags(book, story.rawHeadline ?? story.headline)) {
      offered.push({ tag: `#${d.tag}`, source: SOURCES.headlineConflict, reason: `the headline tags ${d.name} beside another district` });
    }
  }
  if (at) {
    for (const t of suggestTags([story.headline, ...story.points].join("\n"), suggestRules, at)) {
      offered.push({ tag: `#${t}`, source: SOURCES.campaign, reason: "a campaign or keyword tag in campaigns.json matched" });
    }
  }
  // First occurrence of each tag wins; never the footer
  const hashtagSuggestionItems = offered.filter((o, i) => offered.findIndex((x) => x.tag === o.tag) === i && o.tag.toLowerCase() !== footer.toLowerCase());
  const hashtagSuggestions = hashtagSuggestionItems.map((o) => o.tag);
  const mentions = handles.map((h) => `@${h.handle}`);

  const townTag = story.town && story.town !== place?.hi ? townHashtag(book.townTag(story.town) ?? story.town) : "";
  const tags = [place ? `#${place.tag}` : "", townTag].filter(Boolean);
  const headline = story.headline.normalize("NFC").replace(/\s+/g, " ").trim();
  // The desk's own tag run kept in the headline ("#Congress #Kota: ...", "#BJP: ..."): line 1 as written, no tags added
  const prefix = tags.length && !DESK_TAG_RUN.test(headline) ? `${tags.join(" ")}: ` : "";
  // Room for lines 1–2: the limit less the footer and its blank line
  const room = limit - xLen(assemblePostText("x", hashtags, mentions)) + 1;

  let line1 = prefix + headline;
  let headlineCut = false;
  if (xLen(line1) > room) {
    headlineCut = true;
    const cut = cutOnWords(headline, room - xLen(prefix) - xLen(BREAKING_CUT));
    line1 = cut ? `${prefix}${cut}${BREAKING_CUT}` : (cutOnWords(line1, room - xLen(BREAKING_CUT)) + BREAKING_CUT);
  }
  const body = headlineCut ? "" : joinPoints(story.points, Math.min(room, room - limit + target) - xLen(line1) - 2);
  const bodyText = body ? `${line1}\n\n${body}` : line1;
  const handleSuggestions = picked.suggestions;
  // The decision log's view of all of the above (brief §2.3): line 1's tags only when this composer put them there
  const proposals: Proposal[] = [];
  if (prefix && place) proposals.push({ item: `#${place.tag}`, kind: "hashtag", layer: "emit", source: districtSource(district!.from, false), reason: `${place.name}, stated (${district!.from})` });
  if (prefix && townTag) proposals.push({ item: townTag, kind: "hashtag", layer: "emit", source: SOURCES.town, reason: `the town on the place line (${story.town})` });
  proposals.push({ item: footer, kind: "hashtag", layer: "emit", source: SOURCES.brand, reason: rajasthan ? "a Rajasthan story" : "a story from outside Rajasthan" });
  for (const h of handles) proposals.push(handleProposal(h, "emit"));
  for (const t of hashtagSuggestionItems) proposals.push(tagProposal(t));
  for (const h of handleSuggestions) proposals.push(handleProposal(h, "suggest"));
  return {
    bodyText, hashtags, hashtagSuggestions, hashtagSuggestionItems, proposals, mentions, handles, handleSuggestions, cls: picked.cls, why: picked.why,
    warnings: [...picked.warnings, ...codeWarnings, ...flags.map((f) => `hashtag typo: ${f}`)],
    unmatchedReporter: picked.unmatchedReporter, headlineCut, composeVersion: `${BREAKING_FORMAT}.${version}`,
  };
}
