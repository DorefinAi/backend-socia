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
import { RAJASTHAN_DISTRICTS } from "../rajasthan";
import { X_LIMIT, assemblePostText, cutOnGraphemes, cutOnWords } from "../compose";
import type { HashtagGazetteer } from "../hashtags";
import { xLen } from "../xtext";
import { pickCategoryTags } from "./categories";
import { pickHandlesExplained, type HandlePick, type HandleRules } from "./handles";
import { EMPTY_DESK_HANDLE_RULES, type DeskHandleRules } from "./desk-handles";
import { EMPTY_PARTY_RULES, partyOfLeader, type PartyRules } from "./parties";
import { EMPTY_REPORTER_RULES, pickReporter, reporterDistrict, reporterProfile, type ReporterMatch, type ReporterRules } from "./reporters";
import { EMPTY_BEAT_RULES, reporterPrior, type BeatRules } from "./prior";
import { officeSuggestions } from "./offices";
import { stateCapitalStory } from "./capital";
import { PARTY, deskPlacePrefix, headlineDistrictTags, inferHeadlineDistrict, isExplicitDistrict, parseBreaking, placeOfTag, withoutRoutesAndBuildings, type DistrictFrom } from "./parse";
import { openingPlaceLength, placeWordInCompound } from "./place-match";
import {
  EMPTY_NORMALISER, EMPTY_SUGGEST_RULES, HASHTAG, emittable, isDevanagari, explicit, inferred, isVideoHeadline, normaliseTag, stripLinks, suggestTags, videoLabelBrand, electionOf,
  BRAND_RAJASTHAN, type PlaceKind, type PlaceKindLookup, type Sourced, type SuggestRules, type TagNormaliser,
} from "./post-tags";
import type { StoryClass } from "./storyclass";
import type { DistrictInfo, Place, PlaceBook } from "./places";
import { EMPTY_SUBJECT_RULES, type SubjectRules } from "./subjects";
import { PROPOSAL_SOURCES, districtSource, handleProposal, tagProposal, type Proposal, type TagSuggestion } from "./proposals";
import { mergeHandleTypes, type HandleType } from "./handle-types";

/** A headline that starts with the desk's own hashtags and a colon ("#BJP:", "#Congress #Kota:") */
const DESK_TAG_RUN = /^(?:#\S+\s*){1,3}[:：]/u;
/** The headline's first word: letters, marks and digits */
const OPENING_WORD = /^[\p{L}\p{M}\p{N}]+/u;

/**
 * The districts' other Latin names (rajasthan.ts aliases: "Didwana", "Kuchaman", "Khairthal", "Ganganagar", "Jalor"...),
 * folded. The places file tags a district by one name only ("#DidwanaKuchaman"), but the desk writes these too (#Didwana
 * on 40 of its own posts, Sep–Nov): such a tag is a city the desk wrote. Read ONLY to tell whether the copy already
 * carries a city (b9 rule 1) and to keep a reporter's desk rule off it; the parser and the handle rules do not see it.
 */
const DISTRICT_TAG_ALIASES = new Set(
  RAJASTHAN_DISTRICTS.flatMap((d) => d.aliases.filter((a) => /^[A-Za-z]/.test(a)).map((a) => fold(a).replace(/[\s_-]+/g, ""))),
);
/** R1: the first Rajasthan district the text window names, with the parser's own guards (routes and buildings are not places) */
function windowDistrict(book: PlaceBook, lines: readonly string[]): DistrictInfo | null {
  for (const line of lines) {
    const d = inferHeadlineDistrict(book, line);
    if (d?.rajasthan) return d;
  }
  return null;
}

/** R8: a place's name as the card shows it: a national one with its spaces ("UttarPradesh" → "Uttar Pradesh") */
export function cardName(info: DistrictInfo): string {
  return info.rajasthan ? info.name : info.name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Every spelling of a district or national place: the places file's, and rajasthan.ts's other names ("Didwana", "बांसवाडा") */
export function placeSpellings(book: PlaceBook, info: DistrictInfo): string[] {
  const own = RAJASTHAN_DISTRICTS.find((d) => d.name === info.name);
  return [...book.spellingsOf(info.name), info.name, info.tag, info.hi, ...(own ? [own.hi, ...own.aliases] : [])];
}

/**
 * The first place a national story's text names (D4, 23 Nov 2026), an outside one included: "दिल्ली के द्वारका में…" →
 * Delhi, "पटना में…" → Patna; a town gives its district. Routes and buildings are not places ("जयपुर-दिल्ली हाईवे").
 */
function textPlace(book: PlaceBook, lines: readonly string[]): DistrictInfo | null {
  for (const line of lines) {
    for (const m of book.find(withoutRoutesAndBuildings(line))) {
      const d = m.entry.data.districts;
      if (d.length === 1) return d[0]!;
    }
  }
  return null;
}

/**
 * Hindi words that are a party, a topic or an institution, never a place, though a desk may lead with them ("#भाजपा:",
 * "#सुप्रीमकोर्ट:"): Q2 (owner, 23 Nov 2026). Compared folded, without spaces.
 */
const NOT_PLACE_WORDS = new Set(
  [
    "भाजपा", "बीजेपी", "कांग्रेस", "आप", "बसपा", "सपा", "रालोपा", "सुप्रीमकोर्ट", "हाईकोर्ट", "उच्चन्यायालय", "कोर्ट", "अदालत", "पुलिस",
    "सरकार", "राजस्थानसरकार", "केंद्रसरकार", "विधानसभा", "लोकसभा", "राज्यसभा", "संसद", "चुनाव", "मतदान", "पंचायतचुनाव", "मौसम",
    "बारिश", "हादसा", "अपराध", "राजनीति", "खेल", "क्रिकेट", "शिक्षा", "स्वास्थ्य", "कृषि", "किसान", "बजट", "नौकरी", "भर्ती", "परीक्षा",
    "रिजल्ट", "धर्म", "त्योहार", "दीपावली", "होली", "मुख्यमंत्री", "मंत्री", "कलेक्टर", "एसीबी", "ईडी", "सीबीआई", "राजस्थान",
  ].map((w) => fold(w).replace(/\s+/g, "")),
);

/**
 * Q2: a hashtag the desk wrote is its city when it names a place the places file knows, in any spelling (a district,
 * town or outside place), or when it is a single unknown Hindi word leading line 1's run before the colon ("#आकोला:")
 * that is not a party, topic or label word. "#भाजपा" and "#सुप्रीमकोर्ट" never are.
 */
export function deskPlaceTag(book: PlaceBook, tag: string, inLeadRun: boolean, labels: readonly string[] = HEADLINE_LABEL_WORDS): boolean {
  if (knownPlaceTag(book, tag) || book.isPlaceName(tag)) return true;
  if (!inLeadRun || !isDevanagari(tag)) return false;
  const key = fold(tag).replace(/\s+/g, "");
  return !NOT_PLACE_WORDS.has(key) && !PARTY.test(tag) && !isHeadlineLabel(tag, labels);
}

/** A hashtag naming a place: one the places file knows, or a district's other Latin name ("#Didwana", "#KhairthalNews") */
function knownPlaceTag(book: PlaceBook, tag: string): boolean {
  if (placeOfTag(book, tag) !== null) return true;
  const key = fold(tag).replace(/[\s_-]+/g, "");
  return DISTRICT_TAG_ALIASES.has(key) || DISTRICT_TAG_ALIASES.has(key.replace(/news$/, ""));
}
export const RAJASTHAN_FOOTER = "#RajasthanWithFirstIndia";
export const NATIONAL_FOOTER = "#FirstIndiaNews";
/** A cut headline ends with three dots (line 2 ends with "..." or "....": breakingDots) */
export const BREAKING_CUT = "...";
/**
 * Bumped when the layout changes, so drafts of each format can be told apart.
 * b2: category hashtags, the cut after a linking word, subject handles, police/collector only when acting.
 * b4: story-class routing, 3 slots, party and reporter handles, the judicial class (gone since the handle fixes P1/P2), no government fallback.
 * b5: the footer is the only hashtag applied on its own; topic rules are offered to the desk instead.
 * b6: URLs out of every line read; desk tag typos normalised; an inferred district, campaign and #ACB tags
 *     offered, never applied; handle suggestions (HASHTAG_HANDLE_CHANGES_v3).
 * b7: provenance (b6 fix brief): only an explicit district (the copy, or the file code of a reporter tied to
 *     one district) goes in line 1 or picks a police, collector or administration handle; a district the
 *     headline text or the reporter suggests is offered. A party named only in the
 *     points, a party wing and a seasonal institution (@CeoRajasthan) are offered, not tagged.
 * b8: line 2 the desk's length (100–130 with its dots, crispPoints) whatever the headline, cut to withhold the
 *     payoff, then "..." or "...."; the post may go past 280 (the desk posts by hand; "Fit to 280" in the editor
 *     makes a post fit), up to BREAKING_POST_MAX; a line 2 that would be under BREAKING_BODY_FLOOR is dropped.
 * b9: the city (owner rules, 23 Nov 2026, SOCIA_HEADING_GAPS_AND_PLAN): every post carries a city hashtag (the city chain in
 *     composeBreaking, ending in #Jaipur), and line 1 never names its city twice — a headline that opens with line 1's town
 *     takes the tag in place of the word ("#Bundi #नैनवां में…"), one that opens with line 1's district moves the
 *     district tag to the tag line, as the desk writes both. One place decision (headingPlace) for line 1 and the card.
 */
export const BREAKING_FORMAT = "b9";

/**
 * The head office: offered (one click, never applied) to a story that names no place. The 23 Nov fallback that PUT
 * #Jaipur on such a story was removed on 24 Nov 2026 (owner: a Delhi story went out "#Jaipur"); only a reporter's desk
 * rule still puts #Jaipur on a post.
 */
export const HEAD_OFFICE_DISTRICT = "Jaipur";

/**
 * Whether a post with no stated place takes the district its copy names (inferred: the headline's, or the first
 * points') as its city, in the TAG LINE, before the file code and the head office. Owner decision D2 (23 Nov
 * 2026): ON. The plan had no such step (a place found only in the text stays offered, b7), but measured on the 1,689
 * stories posted 15–22 Nov it beats the head office: with it the post's city equals the desk's on 1,454 posts
 * (without: 1,413), and a city the desk did not use goes on 43 posts (without: 84). It never leads line 1 and never
 * picks a handle. false: such a post gets the file code or #Jaipur, and the inferred district is offered as before.
 */
export const CITY_FROM_COPY_TEXT = true;

/** Where line 1's city came from (HeadingPlace.source) */
export type HeadingSource = "desk" | "copy" | "reporter_rule" | "file_code" | "inferred" | "fallback" | "none";
/**
 * Where the city tag sits: `lead` "#District #Town: <headline>", `inline` the town tag in place of the headline's
 * first word ("#Bundi #नैनवां में…"), `trailing` in the tag line, `copy` the desk's own tag in the copy, `none`.
 */
export type HeadingPlacement = "lead" | "inline" | "trailing" | "copy" | "none";

/**
 * The ONE place decision behind line 1 and the card heading (plan step 1): the card never works its place out again.
 * Stored on the draft (handle_pick.headingPlace).
 */
export interface HeadingPlace {
  /** The city tags the composer put on the post, as written there ("#Bundi", "#नैनवां") */
  tags: string[];
  /** The city's English district or national place ("Bundi", "Delhi"), null when the composer added none */
  district: string | null;
  /** The Hindi town in line 1, if any */
  town: string | null;
  source: HeadingSource;
  placement: HeadingPlacement;
  /**
   * The place the card heading starts with (D1): the town in Hindi when the post carries one, else the district's or
   * national place's name ("नैनवां", "Jodhpur", "Uttar Pradesh"), for lead, inline and trailing alike; the card drops the
   * word when the headline opens with it. Null for `copy` (the card reads the desk's own tag run) and `none`.
   */
  card: string | null;
}

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
  /** beat-handles.json: the desk-declared beats a reporter's profile may name (reporter-prior brief §3.3) */
  beats?: BeatRules;
  /**
   * The reporter routing prior and declared beats, offered after every other rule (default on). Off is what the
   * L7 test compares against: the emitted post must be byte-identical either way.
   */
  reporterPrior?: boolean;
  /**
   * Words that make the text before the headline's colon a LABEL, not a place ("बड़ी खबर:", "पंचायत चुनाव:",
   * "ब्रेकिंग:"): a reporter's desk rule still puts its tag before them ("#Jaipur: पंचायत चुनाव: ..."). Default
   * HEADLINE_LABEL_WORDS; matched per word, without case or nukta.
   */
  headlineLabels?: readonly string[];
  /** The longest whole post, a sanity limit (default BREAKING_POST_MAX) */
  limit?: number;
  /**
   * X's weighted limit the composed post must fit (default X_LIMIT, 280; P2, owner 25 Nov 2026): tag-line items move to the
   * suggestions first (reason "length"), and only then is the text cut. The tighter of this and `limit` applies.
   */
  xLimit?: number;
  /** Line 2's longest length (default BREAKING_BODY_MAX) */
  bodyMax?: number;
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
  /**
   * The rule behind line 1's district hashtag: "district.<from>" for a stated district, "reporter_policy" for a
   * reporter's desk rule (a hashtag only: it chose no handle), null when line 1 carries none
   */
  districtSource: string | null;
  /** Line 1's and the card's place (b9) */
  headingPlace: HeadingPlace;
  /** D4: a national story whose copy names no place carries no city; the worker flags the story "no_city" */
  noCity: boolean;
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

const isContent = (w: Word | undefined): w is Word => !!w && !LINKING_WORDS.has(w.text) && !AUXILIARIES.has(w.text);

/**
 * Line 2's length as the desk writes it (1,454 posts, 8–13 Nov 2026): 104–125 X characters, median 115, whatever
 * the headline's length. The cut is looked for between MIN and MAX and lands nearest TARGET; all three count the
 * closing dots.
 */
export const BREAKING_BODY_MIN = 100;
export const BREAKING_BODY_TARGET = 120;
export const BREAKING_BODY_MAX = 130;
/** A line 2 shorter than this is a stub ("आमजन....") and the post goes without it */
export const BREAKING_BODY_FLOOR = 40;
/**
 * The longest whole breaking post, a sanity limit (b8 decisions §0.2). Copy & Posted and corrections check against it.
 * Since P2 (owner, 25 Nov 2026) the composed draft itself fits X's 280 (BreakingComposeOptions.xLimit): the account is
 * capped at 280 and the desk was cutting handles by hand on X.
 */
export const BREAKING_POST_MAX = 1000;

/** Describing words the payoff follows: "डंपर और कार के बीच हुई जोरदार...." */
const HANGING_WORDS: ReadonlySet<string> = new Set(
  [
    "जोरदार", "भीषण", "बड़ी", "बड़ा", "बड़े", "गंभीर", "दर्दनाक", "तेज", "अहम", "नई", "नया", "नए", "भारी", "खास", "विशेष",
    "अचानक", "पूरी", "पूरा", "पूरे", "अनूठी", "अनूठा", "शानदार", "सनसनीखेज", "जानलेवा", "खूनी",
  ].map((w) => w.normalize("NFC")),
);
/** Words that finish a statement: a cut after them gives the outcome away ("…किया गिरफ्तार", "…जारी") */
const FINISHING_WORDS: ReadonlySet<string> = new Set(
  [
    "किया", "किए", "की", "दी", "दिया", "दिए", "मिला", "मिली", "मिले", "गिरफ्तार", "जारी", "बरामद", "जब्त", "दर्ज", "शुरू", "पूरी",
    "मौजूद", "रवाना", "पहुंचे", "पहुंची", "पहुंचा", "निलंबित", "घायल",
  ].map((w) => w.normalize("NFC")),
);

/** The desk ends on "...." in 56% of posts and "..." in 41%: one or the other, fixed per story by its headline */
export function breakingDots(seed: string): string {
  let h = 2166136261;
  for (const ch of seed.normalize("NFC")) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619) >>> 0;
  return h % 100 < 56 ? "...." : "...";
}

/**
 * The headline as line 1 carries it, without its leading hashtags: NFC, spaces collapsed, "#Jaipur #डग: " (or
 * "#Jaipur ") taken off the front. Line 2's dots are seeded with it here and in the editor's Fit (frontend
 * crispLine.ts), so both choose the same 3 or 4 dots.
 */
export function plainHeadline(line1: string): string {
  return line1.normalize("NFC").replace(/\s+/g, " ").trim().replace(/^(?:#\S+\s*)+[:：]?\s*/u, "").trim();
}

/**
 * The points as line 2, the desk's way: all of them when they fit in `max`; otherwise a cut between MIN and `max`
 * X characters (dots included) that withholds the payoff, then `dots`. A line 2 under BREAKING_BODY_FLOOR is "".
 */
export function crispPoints(points: string[], dots: string, max = BREAKING_BODY_MAX): string {
  const parts = points.map(trimPoint).filter(Boolean);
  if (!parts.length || max <= 0) return "";
  const all = parts.join(", ");
  const line = xLen(all) <= max ? all : cutPoints(parts, all, dots, max);
  return xLen(line) < BREAKING_BODY_FLOOR ? "" : line;
}

/**
 * The cut. Every word end whose line (dots included) lands between MIN and `max` is a candidate, scored once:
 * best right after a linking word or a describing word with content still to come in that point ("…दिलबाग सिंह
 * पर....", "…के बीच हुई जोरदार...."), or on the person or thing just before its action; worse after a word that
 * finishes the statement, after a number, or at the end of a point (nothing held back); the further from TARGET,
 * the lower the score (equal scores go to the earlier cut). A cut under BREAKING_BODY_FLOOR is never a candidate,
 * so line 2 is dropped only when no cut of 40 or more fits. The scan stops at the first word end past `max`
 * (prefixes only grow). With no candidate: the longest run of whole words, and when that is under the floor (one
 * huge word), whole letters.
 */
function cutPoints(parts: string[], all: string, dots: string, max: number): string {
  const dotLen = xLen(dots);
  // Never under the floor: a shorter cut would win on score and then be dropped as a stub (review B2)
  const lo = Math.max(BREAKING_BODY_FLOOR, Math.min(BREAKING_BODY_MIN, max - 30));
  const target = Math.min(BREAKING_BODY_TARGET, max);
  const words = wordsOf(all);
  // Each word's point, and how many words and content words of that point come after it
  const point: number[] = [];
  let p = 0;
  let pointEnd = parts[0]!.length;
  for (const w of words) {
    while (w.start >= pointEnd && p < parts.length - 1) pointEnd += 2 + parts[++p]!.length;
    point.push(p);
  }
  const rest = new Array<number>(words.length).fill(0);
  const hidden = new Array<number>(words.length).fill(0);
  for (let i = words.length - 2; i >= 0; i--) {
    if (point[i + 1] !== point[i]) continue;
    rest[i] = rest[i + 1]! + 1;
    hidden[i] = hidden[i + 1]! + (isContent(words[i + 1]) ? 1 : 0);
  }
  let best: { text: string; score: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const text = all.slice(0, w.end).replace(DANGLING, "");
    const len = xLen(text) + dotLen;
    if (len > max) break;
    if (!text || len < lo) continue;
    const next = words[i + 1];
    let score = 0;
    // The order matters: "की" is both a linking and a finishing word, "पूरी" both describing and finishing; the
    // first rule that matches decides
    if (!rest[i]) score -= 4; // a whole point: nothing held back
    else if (LINKING_WORDS.has(w.text) && isContent(next) && !(NUMBER.test(words[i - 1]?.text ?? "") && NUMBER.test(next.text))) score += 3;
    else if (HANGING_WORDS.has(w.text) && isContent(next)) score += 3;
    else if (FINISHING_WORDS.has(w.text) || AUXILIARIES.has(w.text)) score -= 2;
    else if (NUMBER.test(w.text)) score -= 2;
    else if (isContent(w) && next && (FINISHING_WORDS.has(next.text) || AUXILIARIES.has(next.text))) score += 2; // just before its action
    else if (LINKING_WORDS.has(w.text)) score -= 1; // a link followed by another link or a number
    if (rest[i] && hidden[i]! >= 2) score += 1;
    score -= Math.abs(len - target) / 10;
    if (!best || score > best.score) best = { text, score };
  }
  if (best) return best.text + dots;
  const onWords = cutOnWords(all, max - dotLen).replace(DANGLING, "");
  if (onWords && xLen(onWords) + dotLen >= BREAKING_BODY_FLOOR) return onWords + dots;
  const onLetters = cutOnGraphemes(all, max - dotLen).replace(DANGLING, "");
  return onLetters ? onLetters + dots : "";
}

/**
 * A reporter whose ROSTER district says nothing about where a story is: listed for no district (a state bureau:
 * Navin's ACB beat) or for several. Their roster entry is never offered as the story's district. Whether their
 * FILE CODE stands is trustsFileCode's question (b6 fix brief P5).
 */
const isBureauReporter = (m: ReporterMatch | null): boolean => !!m && (!!m.bureau || m.districts.length !== 1);
const districtKey = (s: string) => fold(s).replace(/\s+/g, "");
/**
 * Whether the file name's district code can be taken as the story's district for this reporter. A reporter listed
 * for no district files statewide (Navin's ACB bureau: the code is where he sits, not where the story is). A
 * reporter listed for several (Jaipur and Delhi) is trusted when the code is one of them: @aishwaryam99's JPR
 * file is a Jaipur story. A single-district reporter, or none matched, keeps the code as before b6. A reporter marked
 * `bureau` (Kasana, Changes #3 Q2) is never trusted, whatever districts he is listed for.
 */
const trustsFileCode = (m: ReporterMatch | null, code: DistrictInfo): boolean =>
  !m || (!m.bureau && (m.districts.length === 1 || m.districts.some((d) => districtKey(d) === districtKey(code.name) || districtKey(d) === districtKey(code.tag))));

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

/**
 * The words that make a pre-colon prefix a label rather than a place (BreakingComposeOptions.headlineLabels). From the
 * desk's own prefixes in the Sep–Nov exports: "पंचायत चुनाव:", "पंचायतीराज चुनाव 2026:", "Breaking News:", "बड़ी खबर:".
 */
export const HEADLINE_LABEL_WORDS: readonly string[] = [
  "खबर", "ख़बर", "बड़ी", "बड़ा", "बड़े", "ताजा", "ब्रेकिंग", "अपडेट", "लाइव", "एक्सक्लूसिव", "अलर्ट", "सूचना", "चुनाव", "मतदान",
  "Breaking", "News", "Live", "Update", "Exclusive", "Alert",
];

/** Whether a pre-colon prefix is a label: any of its words is a label word */
export function isHeadlineLabel(prefix: string, labels: readonly string[] = HEADLINE_LABEL_WORDS): boolean {
  const set = new Set(labels.map((w) => fold(w)).filter(Boolean));
  return prefix.split(/[\s\-–—/]+/u).some((w) => set.has(fold(w)));
}

/** "#JodhpurNews", "#Jodhpur_News", "#जोधपुरन्यूज़", "#जोधपुरसमाचार": the place a "<Place>News" tag names */
const NEWS_STEM = /^(.+?)_?(?:News|NEWS|news|न्यूज़?|समाचार)$/u;
const tagPlace = (book: PlaceBook, raw: string) => {
  const t = raw.normalize("NFC");
  const stem = NEWS_STEM.exec(t)?.[1];
  return book.hashtag(t) ?? (stem ? book.hashtag(stem) : null);
};

/**
 * What a hashtag stands for, to tell two tags apart: its lowercased text, and the place it names when the places file
 * knows it ("#Jaipur", "#jaipur", "#JaipurNews" and "#जयपुर" all name the district Jaipur). A town keys on its Hindi
 * name, a district or national place on its Latin tag.
 */
function tagKeys(book: PlaceBook, tag: string): string[] {
  const bare = tag.replace(/^#/, "").normalize("NFC");
  const keys = [`t:${bare.toLowerCase()}`];
  const p = tagPlace(book, bare);
  if (p) keys.push(p.kind === "town" ? `p:town:${p.hi}` : `p:${p.kind}:${(p.districts[0]?.tag ?? p.tag).toLowerCase()}`);
  return keys;
}

/** The keys (tagKeys) of every hashtag in some lines of copy */
function copyTagKeys(book: PlaceBook, lines: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) for (const m of line.matchAll(HASHTAG)) if (m[1] !== undefined) for (const k of tagKeys(book, m[1])) keys.add(k);
  return keys;
}

/**
 * A video post's brand when no place is stated: true for Rajasthan, false for national, null when nothing decides
 * (the caller keeps its default). The first place hashtag in the copy decides first, as in resolveBrand; then the
 * channel label after the headline's last "|" or "।".
 */
function videoBrand(story: Pick<BreakingComposeInput, "headline" | "points" | "rawHeadline">, book: PlaceBook): boolean | null {
  if (!isVideoHeadline(story.headline)) return null;
  for (const line of [story.rawHeadline ?? story.headline, ...story.points]) {
    for (const m of line.matchAll(HASHTAG)) {
      const kind = m[1] !== undefined ? placeKind(tagPlace(book, m[1])) : null;
      if (kind) return kind === "rajasthan";
    }
  }
  const label = videoLabelBrand(story.headline, bookPlaceKind(book));
  return label === null ? null : label === BRAND_RAJASTHAN;
}

/** Which side of the border a place the places file knows is on: a town or district is Rajasthan, a national place is not */
const placeKind = (p: Place | null): PlaceKind | null =>
  !p ? null : p.kind === "national" || p.districts[0]?.rajasthan === false ? "outside" : "rajasthan";

/** The live composer's lookup for videoLabelBrand: a Latin label word through the places file ("Sikar", "Delhi") */
export const bookPlaceKind = (book: PlaceBook): PlaceKindLookup => (tag) => placeKind(tagPlace(book, tag));

/**
 * The district a Hindi leading tag names ("#किशनगढ़:" → Ajmer, "#श्रीमाधोपुर:" → Sikar, "#जोधपुर:" → Jodhpur), as its
 * English tag, or null for a place the places file does not know ("#आकोला:"). A TAG the desk wrote, so not a guess:
 * the live composer takes it as the stated district (parseBreaking), and the replay reference (composePostTags'
 * leadTagDistrict) gives the post the same brand from it (N3).
 */
export const bookLeadTagDistrict = (book: PlaceBook) => (tag: string): string | null => {
  const p = tagPlace(book, tag);
  return p && p.kind !== "national" ? (p.districts[0]?.tag ?? null) : null;
};

/** R4 display tiers of the handle suggestions, top first (rankHandleSuggestions) */
export const SUGGESTION_TIERS = ["text_person_office", "text_other", "video_headline_district", "declared_beat", "reporter_prior"] as const;
export type SuggestionTier = (typeof SUGGESTION_TIERS)[number];

/** Which R4 tier a suggestion belongs to */
export function suggestionTier(h: HandlePick, types: ReadonlyMap<string, HandleType>): SuggestionTier {
  if (h.reason === "prior") return "reporter_prior";
  if (h.reason === "beat") return "declared_beat";
  if (h.reason === "office" || types.get(h.handle.toLowerCase()) === "person") return "text_person_office";
  return "text_other";
}

/**
 * The desk's order for the handle suggestions (directory changes v2 R4, as decided by the owner on 14 Nov: a declared
 * beat ranks ABOVE the measured prior). The emitted handles are not here: they stay on the post, first and
 * unchanged. Below them:
 *   1. a person or an office the copy names: a name match, an MLA, "CM ने", "मुख्य सचिव ने" (the Chief Secretary
 *      the text names ranks above the @RajGovOfficial rituraj's prior offers beside it);
 *   2. the other rules' text suggestions, in their own order: a party named only in the points, the police at a
 *      venue, an institution named in passing, a seasonal institution;
 *   3. the headline-suffix district of a video post — EMPTY: no such rule exists in the code (the "| <Place> News"
 *      channel label decides the brand only: videoLabelBrand), so nothing is ever in this slot;
 *   4. declared-beat handles (the beat's keywords matched the copy; may be a person: Nirmal's tourism → @KumariDiya);
 *   5. the reporter prior's measured institution handles (who filed it, nothing in the copy).
 * Stable within a tier, so each rule keeps its own order.
 */
export function rankHandleSuggestions(list: readonly HandlePick[], types: ReadonlyMap<string, HandleType>): HandlePick[] {
  const rank = (h: HandlePick) => SUGGESTION_TIERS.indexOf(suggestionTier(h, types));
  return list.map((h, i) => ({ h, i, r: rank(h) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.h);
}

export function composeBreaking(story: BreakingComposeInput, rules: HandleRules, book: PlaceBook, opts: BreakingComposeOptions = {}): BreakingDraft {
  const {
    version = "0", topics = null, subjects = EMPTY_SUBJECT_RULES, desk = EMPTY_DESK_HANDLE_RULES,
    reporters = EMPTY_REPORTER_RULES, parties = EMPTY_PARTY_RULES, limit = BREAKING_POST_MAX, xLimit = X_LIMIT, bodyMax = BREAKING_BODY_MAX,
    normaliser = EMPTY_NORMALISER, suggestRules = EMPTY_SUGGEST_RULES, at, beats = EMPTY_BEAT_RULES, reporterPrior: reporterPriorOn = true,
    headlineLabels = HEADLINE_LABEL_WORDS,
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
  // The brand. A stated place decides; with none, a video post's place TAG in the copy, then its channel label
  // ("| Madhya Pradesh News" → national, "| Rajasthan News" → Rajasthan: videoLabelBrand, the one implementation the
  // replay reference shares, V1), then the story's own default. A place the gazetteer only finds in the text never
  // decides here (FL5).
  const rajasthan = place ? place.rajasthan : (videoBrand(story, book) ?? story.rajasthan);
  // A word naming another district: "बूंदी SP ने" in a Jaipur story does not tag Jaipur's police
  const elsewhere = (word: string) => {
    const p = book.lookup(word);
    return p?.kind === "district" && !p.districts.some((d) => d.name === place?.name);
  };
  // The picker sees the explicit district only, so an inferred one cannot choose a police force, a collector
  // or an administration handle however a later rule uses `district`
  // Election mode (owner, 20 Nov 2026): a Rajasthan story inside an election campaign's window that its pattern matches
  const election = rajasthan ? electionOf([story.rawHeadline ?? story.headline, ...story.points].join("\n"), suggestRules, at) : null;
  const picked = pickHandlesExplained({ ...story, district: place?.name ?? null, rajasthan, elsewhere }, rules, {
    subjects, desk, reporters, parties, max: 3, at, election,
    // An election story's DM comes from the district the STORY names when the copy states none (owner, 20 Nov 2026:
    // "panchayat election based, not reporter based"): the headline's or the text's district, never the reporter's own
    electionDistrict: election && district && district.from !== "reporter" ? district.value.name : null,
  });
  let handles = picked.handles;
  // The headline's district tags (two districts: a conflict when none was taken as stated)
  const headlineTags = place ? [] : headlineDistrictTags(book, story.rawHeadline ?? story.headline);
  const headline = story.headline.normalize("NFC").replace(/\s+/g, " ").trim();
  // The desk's own tag run kept in the headline ("#Congress #Kota: ...", "#BJP: ..."). With a place in it, line 1 is
  // as written and no tag is added. A run of party, topic or label tags only ("#BJP:", "#Congress #INC:") does not
  // fill the district slot (handle fixes F10): the stated district or a reporter's desk rule still goes in front of it
  // ("#Jaipur: #BJP: ..."), the text's district is still offered, and the desk's tags stay where it wrote them. A Hindi
  // tag in the run counts as a place, known or not ("#आकोला:"): the desk writes its towns that way.
  const deskRunMatch = DESK_TAG_RUN.exec(headline);
  const deskRun = !!deskRunMatch && [...deskRunMatch[0].matchAll(HASHTAG)].some((m) => m[1] !== undefined && deskPlaceTag(book, m[1], true, headlineLabels));
  // A reporter's desk rule (reporter-prior brief §4): rituraj's post that names no district goes out as "#Jaipur:".
  // It means "filed from the Jaipur desk", not "happened in Jaipur" (his Jodhpur panchayat story went out as
  // #JaipurNews), so it is a line-1 hashtag and NOTHING ELSE: it was not in the picker's district above, never
  // chooses a police, collector or administration handle, and never changes the footer. Only what the DESK WROTE
  // blocks it — a stated district, a place written before the headline's colon ("आकोला: ..."), a place hashtag
  // anywhere in the copy ("#Delhi"), the desk's own tag run; a place the gazetteer finds in the text does not
  // (user decision, 13 Nov). A video headline never takes a leading tag: there it is offered instead.
  const profile = reporterProfile(reporters, reporter);
  const policyWarnings: string[] = [];
  const policyDistrict = profile?.districtWhenMissing ? book.district(profile.districtWhenMissing) : null;
  if (profile?.districtWhenMissing && !policyDistrict) {
    policyWarnings.push(`@${profile.handle}'s district_when_missing "${profile.districtWhenMissing}" is not a district in the places file; the desk rule was not applied`);
  }
  // A place hashtag anywhere, "#<Place>News" included (#JodhpurNews, #DelhiNews, #जोधपुरन्यूज़): the desk wrote the place.
  // The same reading as the parser's headline district tags (parse.ts placeOfTag)
  const placeTagged = [story.rawHeadline ?? story.headline, ...story.points].some((line) => [...line.matchAll(HASHTAG)].some((m) => m[1] !== undefined && deskPlaceTag(book, m[1], false, headlineLabels)));
  // A place the desk wrote before the headline's colon, known or not ("रामपुरा खुर्द: ..."), that is not a label
  // ("बड़ी खबर:", "पंचायत चुनाव:"). The parser drops an unknown two-word prefix from the headline; it still blocks.
  const prefixPlace = deskPlacePrefix(book, story.rawHeadline ?? story.headline);
  const prefixTagged = !!prefixPlace && !isHeadlineLabel(prefixPlace, headlineLabels);
  // A district found only by the gazetteer (headline, text) or guessed from the reporter is not one the desk wrote; a
  // stored district of unknown provenance (a row before migration 0023) may be, so it blocks
  const gazetteerOnly = district?.provenance === "inferred" && (district.from === "headline" || district.from === "text" || district.from === "reporter");
  const deskWrotePlace = !!place || (!!district && !gazetteerOnly) || headlineTags.length > 0 || !!story.town || placeTagged || prefixTagged || deskRun;
  const policy = policyDistrict && profile && !deskWrotePlace ? { district: policyDistrict, layer: isVideoHeadline(headline) ? ("suggest" as const) : ("emit" as const), name: profile.name } : null;
  const policyReason = policy ? `${policy.name}'s desk rule: a post naming no district goes out as ${policy.district.name} (filed from that desk, not a location)` : "";
  const footer = rajasthan ? RAJASTHAN_FOOTER : NATIONAL_FOOTER;
  // The footer is the only tag that goes on by itself. The topic rules are OFFERED, not applied: measured
  // against 400 published posts (30 Oct 2026), auto-applying them put a tag the desk had not written on
  // 283 posts — #RajasthanElection alone fired 111 times and the desk used it NOT ONCE — and dropped the
  // trailing run's precision from 92.5% to 55.8%. Only 2 of 19 active rules beat a coin flip. A wrong tag
  // costs the desk a deletion on a live post; a missing one costs a click.
  const hashtags = [footer];
  // An election story carries the election's tag, then the hashtag of each party it tags (#Congress, #BJP)
  if (election) {
    hashtags.push(`#${election}`);
    // In the order the parties are tagged, which is the order the copy names them
    for (const h of picked.handles) {
      const r = parties.rules.find((x) => x.handle.toLowerCase() === h.handle.toLowerCase());
      if (r?.hashtag && !hashtags.some((t) => t.toLowerCase() === `#${r.hashtag}`.toLowerCase())) hashtags.push(`#${r.hashtag}`);
    }
  }
  const offered: TagSuggestion[] = [];
  // A video post's desk rule: offered first, never a leading tag
  if (policy?.layer === "suggest") offered.push({ tag: `#${policy.district.tag}`, source: PROPOSAL_SOURCES.reporterPolicy, reason: `${policyReason}; a video post takes no leading tag` });
  // An inferred district (§2.8) is offered first among the suggestions and goes nowhere else
  if (district?.provenance === "inferred" && !(policy && policy.district.name === district.value.name)) {
    offered.push({ tag: `#${district.value.tag}`, source: districtSource(district.from, true), reason: `${district.value.name}, inferred from the ${district.from === "reporter" ? "reporter's district" : district.from}: not stated in the copy` });
  }
  for (const t of pickCategoryTags({ headline: story.headline, points: story.points, rajasthan }, topics, [footer])) {
    offered.push({ tag: t, source: PROPOSAL_SOURCES.topic, reason: "the org's topic rule matched the copy" });
  }
  // District tags in the headline that were not taken as stated (two different districts: a conflict) are offered
  if (!place) {
    for (const d of headlineTags) {
      offered.push({ tag: `#${d.tag}`, source: PROPOSAL_SOURCES.headlineConflict, reason: `the headline tags ${d.name} beside another district` });
    }
  }
  if (at) {
    for (const t of suggestTags([story.headline, ...story.points].join("\n"), suggestRules, at)) {
      offered.push({ tag: `#${t}`, source: PROPOSAL_SOURCES.campaign, reason: "a campaign or keyword tag in campaigns.json matched" });
    }
  }
  // P1 (owner, 25 Nov 2026): a party an election story names but is not about (its handle offered, handles.ts) has its
  // hashtag offered too, never put on the post
  if (election) {
    for (const h of picked.suggestions) {
      const r = h.reason === "party" ? parties.rules.find((x) => x.handle.toLowerCase() === h.handle.toLowerCase()) : undefined;
      if (r?.hashtag) offered.push({ tag: `#${r.hashtag}`, source: PROPOSAL_SOURCES.campaign, reason: `an election story that names ${r.name} but is not about it` });
    }
  }
  let mentions = handles.map((h) => `@${h.handle}`);

  const townTag = story.town && story.town !== place?.hi ? townHashtag(book.townTag(story.town) ?? story.town) : "";
  const lineOne = place ?? (policy?.layer === "emit" ? policy.district : null);
  // A tag the headline already carries without a colon ("#Jaipur जयपुर में…", "…#JaipurNews") is not added again
  // in front of it (desk fixes 14 Nov, point 6)
  const headlineTagKeys = copyTagKeys(book, [headline]);
  let tags = [lineOne ? `#${lineOne.tag}` : "", townTag].filter((t) => t && !tagKeys(book, t).some((k) => headlineTagKeys.has(k)));

  // ── The city (b9, owner rules and decisions of 23 Nov 2026) ──
  // Rule 1: every post carries at least one city hashtag, in this order (the first that applies wins):
  //   1. a place the desk wrote: line 1's stated district or town, its own tag run, a place prefix before the colon,
  //      a place hashtag anywhere in the copy, known or unknown ("#आकोला", "#Didwana"), or a stored district of unknown
  //      provenance (a row before migration 0023): no guess below applies;
  //   2. an outside place the desk tagged (a place hashtag, as in 1);
  //   3. the reporter's desk rule (a video post's too);
  //   4. the file name's district code (a state bureau's included: a TAG only, it picked no handle above);
  //   5. the district the text names (CITY_FROM_COPY_TEXT), in the tag line;
  //   6. none: NO city tag. The draft says so (noCity, the story's "no_city" check) and offers the three likeliest places,
  //      one click each. (Owner, 24 Nov 2026: the #Jaipur fallback is gone; only the reporter rule tags #Jaipur.)
  // A national story (#FirstIndiaNews) skips 4: after 3 it takes the first place its text names, an outside one included
  // (#Delhi, #Bihar), then 6.
  const video = isVideoHeadline(headline);
  // B1: the desk's own tag run is line 1 as written, so a stated district never reaches line 1 beside it
  if (deskRun) tags = [];
  const legacy = district?.provenance === "inferred" && district.from === "legacy" ? district.value : null;
  const deskPlace = deskRun || placeTagged || prefixTagged;
  const trailing: string[] = [];
  let placement: HeadingPlacement = tags.length ? "lead" : deskPlace ? "copy" : "none";
  let source: HeadingSource = tags.length ? (place || !lineOne ? "desk" : "reporter_rule") : placement === "copy" ? "copy" : "none";
  let cityInfo: DistrictInfo | null = tags.length ? lineOne : null;
  let noCity = false;
  const cityOffers: TagSuggestion[] = [];
  if (placement === "none") {
    const code = book.district(story.fileDistrict);
    // R1 (owner, 23 Nov 2026): a bureau reporter (Navin: no district of his own, or marked bureau) files every district
    // under one code, so the district the text names (headline and first two points, parse's window) comes before it.
    // For a district reporter the file code still wins.
    const bureau = !!reporter && (!!reporter.bureau || reporter.districts.length === 0);
    const inferredText = district?.provenance === "inferred" && (district.from === "headline" || district.from === "text") ? district.value : null;
    const guess = inferredText ?? (bureau ? windowDistrict(book, [headline, ...story.points.slice(0, 2)]) : null);
    // A national story's city is a place its text names, an outside one included ("दिल्ली के द्वारका में…" → #Delhi)
    const named = rajasthan ? null : textPlace(book, [headline, ...story.points]);
    // Step 4 (owner, 23 Nov 2026): a file code reaching here is one storyDistrict did not trust (a bureau reporter such as
    // Navin, filing every district under JPR, or a code not among the reporter's districts). It is the city only when the
    // text names no district: "डूंगरपुर में ACB कार्रवाई" under JPR is #Dungarpur (as the desk wrote it); Navin's IAS stories,
    // naming none, stay "#Jaipur:" (3 of 3 as the desk wrote them, 15–22 Nov). Measured on 1,689 posts: no other change.
    const fileCodeCity = bureau && guess && CITY_FROM_COPY_TEXT ? null : code;
    const pick: [DistrictInfo, HeadingSource] | null = legacy
      ? [legacy, "desk"]
      : policy
        ? [policy.district, "reporter_rule"]
        : rajasthan
          ? fileCodeCity
            ? [fileCodeCity, "file_code"]
            : guess && CITY_FROM_COPY_TEXT
              ? [guess, "inferred"]
              : null
          : named && CITY_FROM_COPY_TEXT
            ? [named, "inferred"]
            : null;
    if (pick) {
      [cityInfo, source] = pick;
      const tag = `#${cityInfo.tag}`;
      // A video post takes no leading tag. The reporter's desk rule and the file code lead line 1, as the desk wrote them
      // (Navin's JPR files went out "#Jaipur: ..."); a district from the text and a stored one of unknown
      // provenance go in the tag line
      const lead = !video && (source === "reporter_rule" || source === "file_code");
      if (lead) {
        tags = [tag];
        placement = "lead";
      } else {
        trailing.push(tag);
        placement = "trailing";
      }
    } else {
      // No place anywhere: no city on the post, the draft is flagged, and the three likeliest are offered (never applied)
      noCity = true;
      const likely = [...(reporter?.districts ?? []), story.fileDistrict ?? "", ...(rajasthan ? [HEAD_OFFICE_DISTRICT, "Delhi"] : ["Delhi", HEAD_OFFICE_DISTRICT])]
        .map((n) => book.district(n))
        .filter((d): d is DistrictInfo => !!d)
        .filter((d, i, all) => all.findIndex((x) => x.name === d.name) === i)
        .slice(0, 3);
      for (const d of likely) cityOffers.push({ tag: `#${d.tag}`, source: "district.city.candidate", reason: `a story naming no place: ${d.name} is one of the likeliest (one click)` });
    }
  }
  // Rule 3: line 1 never names its city twice (the desk, Sep–Nov exports: a town tag in place of the word 62 times to 6
  // doubled; a headline opening with its district has the district tag in the tag line 221 times to 3 doubled, and 81
  // to 34 on 15–22 Nov). Spelling-tolerant (place-match.ts): "नैनवा" = "नैनवां", "बड़ी सादड़ी" = "बड़ीसादड़ी".
  let inlineLine: string | null = null;
  if (placement === "lead" && tags.length) {
    const last = tags.at(-1)!;
    const townOpening = last === townTag ? openingPlaceLength(headline, [story.town ?? "", townTag.slice(1), book.hashtag(townTag.slice(1))?.hi ?? ""]) : 0;
    const first = tags[0] === townTag ? null : tagPlace(book, tags[0]!.slice(1));
    const districtOpening = first && first.kind !== "town" && first.districts[0] ? openingPlaceLength(headline, placeSpellings(book, first.districts[0])) : 0;
    if (townOpening && !placeWordInCompound(headline, townOpening)) {
      // "#Bundi #नैनवां में मां कंकाली…": the town tag in place of the word, the rest as written
      inlineLine = `${tags.join(" ")}${headline.slice(townOpening)}`;
      placement = "inline";
    } else if (districtOpening) {
      // "टोंक में अवैध खनन…": no leading tag, the headline as written, the city (and a town with it) in the tag line
      trailing.push(...tags);
      tags = [];
      placement = "trailing";
    }
  }
  if (trailing.length) hashtags.splice(1, 0, ...trailing.filter((t) => !hashtags.some((h) => h.toLowerCase() === t.toLowerCase())));
  const written = placement === "lead" || placement === "inline" ? tags : placement === "trailing" ? trailing : [];
  const townWritten = !!townTag && written.includes(townTag);
  const headingPlace: HeadingPlace = {
    tags: [...written],
    district: placement === "copy" || placement === "none" ? null : (cityInfo?.name ?? null),
    town: townWritten ? (story.town ?? null) : null,
    source,
    placement,
    // D1: the card always leads with the post's city: its town in Hindi when line 1 or the tag line carries one, else the
    // district's (or national place's) English name. The desk's own place (copy) is read by the card itself.
    card: placement === "copy" || placement === "none" ? null : townWritten ? townTag.slice(1) : cityInfo ? cardName(cityInfo) : null,
  };

  // ── added after every rule above has finished, as suggestions only: nothing above moves (brief §3.5, L7) ──
  const offeredHandles = [...picked.suggestions];
  // What kind of account each directory handle is (R2): the prior offers institutions only, and the order below
  // puts a person or office the copy names first (R4)
  const types = mergeHandleTypes(rules.types, subjects.types, parties.types, reporters.types);
  const taken = new Set([...handles, ...offeredHandles].map((h) => h.handle.toLowerCase()));
  const text = [story.rawHeadline ?? story.headline, ...story.points].join("\n");
  // An office named without its holder: "CM ने ..." offers the CM's handles (§6), on Rajasthan copy only
  if (rajasthan && picked.cls !== "leader_post" && subjects.offices?.length) {
    const holders = subjects.gazetteer.find(text).filter((m) => m.entry.data.kind === "person").map((m) => m.entry.data.handle.toLowerCase());
    for (const h of officeSuggestions(subjects.offices, text, taken, (o) => o.handles.some((x) => holders.includes(x.toLowerCase())))) {
      offeredHandles.push(h);
      taken.add(h.handle.toLowerCase());
    }
  }
  // Changes #3 §2.1 (party_of_leader): a Congress leader on the draft (emitted, or offered by a text rule above) with no
  // INC handle there offers @INCRajasthan, never tags it. A text rule, so it runs BEFORE the reporter prior and does not
  // depend on it (L7): the prior then sees the handle as taken and does not offer it twice. Nothing above is removed,
  // re-ordered or replaced: the offer goes first in the list when the filing reporter is one the config names (Dangi,
  // Naresh), else into its own tier (a party: text_other, after the other text suggestions).
  const leaderFirst: HandlePick[] = [];
  for (const o of partyOfLeader(text, [...handles, ...offeredHandles], parties, reporter?.handle)) {
    const pick: HandlePick = { handle: o.handle, reason: "party", source: PROPOSAL_SOURCES.partyOfLeader, title: o.name, detail: o.reason };
    (o.first ? leaderFirst : offeredHandles).push(pick);
    taken.add(o.handle.toLowerCase());
  }
  const priorWarnings: string[] = [];
  // The reporter routing prior (§3): measured rates and declared beats of the reporter the FILE NAME names
  if (reporterPriorOn && profile) {
    // Every police and collector handle, verified or not: a reporter never brings one (§3.5)
    const districtBound = new Set([...(rules.bound ?? []), ...rules.state.police, ...Object.values(rules.districts).flatMap((d) => [...d.police, ...d.collector])].map((h) => h.toLowerCase()));
    const takenTags = new Set([...tags, footer, ...offered.map((o) => o.tag)].map((t) => t.toLowerCase()));
    const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])].map((h) => h.replace(/^@/, "").toLowerCase()));
    const prior = reporterPrior({ profile, text, taken, takenTags, districtBound, directory, types }, reporters, beats);
    offeredHandles.push(...prior.handles);
    offered.push(...prior.hashtags);
    priorWarnings.push(...prior.warnings);
  }
  // The desk's order (R4, 14 Nov): a person or office the copy names, the other text rules, declared beats, the prior
  // Changes #3 §2.1 (party_of_leader) is placed before the prior below: see leaderFirst
  const handleSuggestions = [...leaderFirst, ...rankHandleSuggestions(offeredHandles, types)];
  // First occurrence of each tag wins; never the footer, never a tag already in line 1's prefix or anywhere in the
  // headline or points (the same tag, any case, or the same place as "#<Place>News")
  const onPost = copyTagKeys(book, [headline, ...story.points]);
  for (const t of [...tags, ...trailing]) for (const k of tagKeys(book, t)) onPost.add(k);
  // D4: a national story with no city offers its three likeliest first, one click each
  offered.unshift(...cityOffers);
  // P7 (owner, 25 Nov 2026): a Rajasthan state-capital story (CM, CS, secretariat, the High Court, the assembly) that carries
  // no city offers #Jaipur first, as the desk adds it by hand; never applied, never on copy naming another state or country
  const capital = rajasthan && headingPlace.placement === "none" ? book.district(HEAD_OFFICE_DISTRICT) : null;
  if (capital && stateCapitalStory(text, book)) {
    offered.unshift({ tag: `#${capital.tag}`, source: "district.capital", reason: "a state-capital story (CM, CS, secretariat, High Court, assembly) naming no city: offered" });
  }
  const prefix = tags.length && !deskRun && inlineLine === null ? `${tags.join(" ")}: ` : "";
  /** Lines 1–2 within `lim` for the tag line as it stands: the headline cut only when it alone overflows, line 2 the desk's length */
  const layout = (lim: number) => {
    // Room for lines 1–2: the limit less the footer and its blank line
    const room = lim - xLen(assemblePostText("x", hashtags, mentions)) + 1;
    let line1 = inlineLine ?? prefix + headline;
    let cutHead = false;
    if (xLen(line1) > room) {
      cutHead = true;
      const cut = inlineLine === null ? cutOnWords(headline, room - xLen(prefix) - xLen(BREAKING_CUT)) : "";
      line1 = cut ? `${prefix}${cut}${BREAKING_CUT}` : (cutOnWords(line1, room - xLen(BREAKING_CUT)) + BREAKING_CUT);
    }
    // Line 2 the desk's length whatever the headline (100–130), shorter only when the post's limit leaves less room,
    // and dropped under the floor (crispPoints)
    const body = cutHead ? "" : crispPoints(story.points, breakingDots(plainHeadline(line1)), Math.min(bodyMax, room - xLen(line1) - 2));
    return { line1, cutHead, bodyText: body ? `${line1}\n\n${body}` : line1 };
  };
  // ── P2 (owner, 25 Nov 2026): the post fits X's 280 ──
  // 20 of 36 drafts were over on 23-24 Nov and the desk cut handles on X, the party pair first. Lines 1–2 are laid out at
  // the desk's length; while the whole post is over, the weakest tag-line item goes back to the suggestions (reason
  // "length"), in this order: the second party handle, the other party handles, the collector, the topic hashtags
  // (party tags, then the election tag), the other handles (police, government, desk). The city tags, the brand tag, the
  // reporter byline and the subject and CM handles are never moved. Only when nothing movable is left is the text cut.
  const cap = Math.min(limit, xLimit);
  const lengthHandles: HandlePick[] = [];
  const lengthTags: TagSuggestion[] = [];
  const placedTag = (t: string) => headingPlace.tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const nextToMove = (): { handle: HandlePick } | { tag: string } | null => {
    const last = <T,>(xs: readonly T[]) => xs.at(-1);
    const parties = handles.filter((h) => h.reason === "party");
    if (parties.length >= 2) return { handle: last(parties)! };
    if (parties.length) return { handle: parties[0]! };
    const dm = handles.find((h) => h.reason === "collector");
    if (dm) return { handle: dm };
    const topic = hashtags.slice(1).filter((t) => !placedTag(t));
    const partyTag = last(topic.filter((t) => t.toLowerCase() !== `#${election ?? ""}`.toLowerCase()));
    if (partyTag ?? topic[0]) return { tag: (partyTag ?? topic[0])! };
    const other = last(handles.filter((h) => h.reason !== "reporter" && h.reason !== "subject" && h.reason !== "cm"));
    return other ? { handle: other } : null;
  };
  let laid = layout(limit);
  while (xLen(assemblePostText(laid.bodyText, hashtags, mentions)) > cap) {
    const move = nextToMove();
    if (!move) break;
    if ("handle" in move) {
      handles = handles.filter((h) => h !== move.handle);
      mentions = handles.map((h) => `@${h.handle}`);
      lengthHandles.push({ ...move.handle, detail: "length" } as HandlePick);
    } else {
      hashtags.splice(hashtags.indexOf(move.tag), 1);
      lengthTags.push({ tag: move.tag, source: PROPOSAL_SOURCES.campaign, reason: "length" });
    }
    laid = layout(limit);
  }
  if (xLen(assemblePostText(laid.bodyText, hashtags, mentions)) > cap) laid = layout(cap);
  const { cutHead: headlineCut, bodyText } = laid;
  // What was moved for length is offered first, in the order it came off
  handleSuggestions.unshift(...lengthHandles);
  offered.unshift(...lengthTags);
  const hashtagSuggestionItems = offered.filter((o, i) => offered.findIndex((x) => x.tag.toLowerCase() === o.tag.toLowerCase()) === i && !hashtags.some((t) => t.toLowerCase() === o.tag.toLowerCase()) && !tagKeys(book, o.tag).some((k) => onPost.has(k)));
  const hashtagSuggestions = hashtagSuggestionItems.map((o) => o.tag);
  // The decision log's view of all of the above (brief §2.3): line 1's tags only when this composer put them there
  const proposals: Proposal[] = [];
  const stated = place && district ? districtSource(district.from, false) : null;
  // The composer's city tags: line 1's (a lead run, or a town tag in place of its word) and the tag line's
  const cityTags = new Set(headingPlace.tags.map((t) => t.toLowerCase()));
  const placed = (tag: string) => cityTags.has(tag.toLowerCase());
  const where = placement === "trailing" ? "in the tag line" : placement === "inline" ? "in place of the headline's first word" : "in line 1";
  if (place && district && placed(`#${place.tag}`)) proposals.push({ item: `#${place.tag}`, kind: "hashtag", layer: "emit", source: districtSource(district.from, false), reason: `${place.name}, stated (${district.from}), ${where}` });
  if (source === "reporter_rule" && policy && placed(`#${policy.district.tag}`)) proposals.push({ item: `#${policy.district.tag}`, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.reporterPolicy, reason: `${policyReason}, ${where}` });
  if (townTag && placed(townTag)) proposals.push({ item: townTag, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.town, reason: `the town on the place line (${story.town}), ${where}` });
  if (legacy && cityInfo && placed(`#${cityInfo.tag}`)) proposals.push({ item: `#${cityInfo.tag}`, kind: "hashtag", layer: "emit", source: "district.city.legacy", reason: `${cityInfo.name}, the story's stored district (provenance unknown), ${where}` });
  if ((source === "file_code" || source === "inferred" || source === "fallback") && cityInfo) {
    const why = source === "file_code" ? `the file name's district code (${cityInfo.name}): a tag only, no handle` : source === "inferred" ? `${cityInfo.name}, the district the copy names` : `no place in the copy: the head office (${cityInfo.name})`;
    proposals.push({ item: `#${cityInfo.tag}`, kind: "hashtag", layer: "emit", source: `district.city.${source}`, reason: `every post carries a city: ${why}, ${where}` });
  }
  proposals.push({ item: footer, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.brand, reason: rajasthan ? "a Rajasthan story" : "a story from outside Rajasthan" });
  for (const t of hashtags.slice(1)) if (!placed(t)) proposals.push({ item: t, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.campaign, reason: `an election story (#${election})` });
  for (const h of handles) proposals.push(handleProposal(h, "emit"));
  for (const t of hashtagSuggestionItems) proposals.push(tagProposal(t));
  for (const h of handleSuggestions) proposals.push(handleProposal(h, "suggest"));
  return {
    bodyText, hashtags, hashtagSuggestions, hashtagSuggestionItems, proposals, mentions, handles, handleSuggestions, cls: picked.cls, why: picked.why,
    warnings: [
      ...picked.warnings, ...codeWarnings, ...policyWarnings, ...priorWarnings, ...flags.map((f) => `hashtag typo: ${f}`),
      ...(noCity ? ["a story naming no place: no city hashtag was added; pick one of the offered places"] : []),
    ],
    unmatchedReporter: picked.unmatchedReporter, headlineCut, composeVersion: `${BREAKING_FORMAT}.${version}`,
    // Only when this composer put line 1's district there (the desk's own tag run is left as written)
    districtSource: !prefix && inlineLine === null ? null : stated ?? (source === "reporter_rule" ? PROPOSAL_SOURCES.reporterPolicy : source === "file_code" || source === "fallback" || source === "inferred" ? `district.city.${source}` : null),
    headingPlace,
    noCity,
  };
}
