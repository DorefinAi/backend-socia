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
import { EMPTY_REPORTER_RULES, pickReporter, reporterDistrict, reporterProfile, type ReporterMatch, type ReporterRules } from "./reporters";
import { EMPTY_BEAT_RULES, reporterPrior, type BeatRules } from "./prior";
import { officeSuggestions } from "./offices";
import { deskPlacePrefix, headlineDistrictTags, inferHeadlineDistrict, isExplicitDistrict, parseBreaking, type DistrictFrom } from "./parse";
import {
  EMPTY_NORMALISER, EMPTY_SUGGEST_RULES, HASHTAG, emittable, explicit, inferred, isVideoHeadline, normaliseTag, stripLinks, suggestTags, videoLabelBrand,
  BRAND_RAJASTHAN, type PlaceKind, type PlaceKindLookup, type Sourced, type SuggestRules, type TagNormaliser,
} from "./post-tags";
import type { StoryClass } from "./storyclass";
import type { DistrictInfo, Place, PlaceBook } from "./places";
import { EMPTY_SUBJECT_RULES, type SubjectRules } from "./subjects";
import { PROPOSAL_SOURCES, districtSource, handleProposal, tagProposal, type Proposal, type TagSuggestion } from "./proposals";

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
  /**
   * The rule behind line 1's district hashtag: "district.<from>" for a stated district, "reporter_policy" for a
   * reporter's desk rule (a hashtag only: it chose no handle), null when line 1 carries none
   */
  districtSource: string | null;
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

export function composeBreaking(story: BreakingComposeInput, rules: HandleRules, book: PlaceBook, opts: BreakingComposeOptions = {}): BreakingDraft {
  const {
    version = "0", topics = null, subjects = EMPTY_SUBJECT_RULES, desk = EMPTY_DESK_HANDLE_RULES,
    reporters = EMPTY_REPORTER_RULES, parties = EMPTY_PARTY_RULES, limit = X_LIMIT, target = BREAKING_TARGET,
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
  const picked = pickHandlesExplained({ ...story, district: place?.name ?? null, rajasthan, elsewhere }, rules, { subjects, desk, reporters, parties, max: 3, at });
  const handles = picked.handles;
  // The headline's district tags (two districts: a conflict when none was taken as stated)
  const headlineTags = place ? [] : headlineDistrictTags(book, story.rawHeadline ?? story.headline);
  const headline = story.headline.normalize("NFC").replace(/\s+/g, " ").trim();
  // The desk's own tag run kept in the headline ("#Congress #Kota: ...", "#BJP: ..."): line 1 as written, no tags added
  const deskRun = DESK_TAG_RUN.test(headline);
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
  // A place hashtag anywhere, "#<Place>News" included (#JodhpurNews, #DelhiNews): the desk wrote the place
  const placeTagged = [story.rawHeadline ?? story.headline, ...story.points].some((line) => [...line.matchAll(HASHTAG)].some((m) => m[1] !== undefined && tagPlace(book, m[1]) !== null));
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
  const mentions = handles.map((h) => `@${h.handle}`);

  const townTag = story.town && story.town !== place?.hi ? townHashtag(book.townTag(story.town) ?? story.town) : "";
  const lineOne = place ?? (policy?.layer === "emit" ? policy.district : null);
  const tags = [lineOne ? `#${lineOne.tag}` : "", townTag].filter(Boolean);

  // ── added after every rule above has finished, as suggestions only: nothing above moves (brief §3.5, L7) ──
  const handleSuggestions = [...picked.suggestions];
  const taken = new Set([...handles, ...handleSuggestions].map((h) => h.handle.toLowerCase()));
  const text = [story.rawHeadline ?? story.headline, ...story.points].join("\n");
  // An office named without its holder: "CM ने ..." offers the CM's handles (§6), on Rajasthan copy only
  if (rajasthan && picked.cls !== "leader_post" && subjects.offices?.length) {
    const holders = subjects.gazetteer.find(text).filter((m) => m.entry.data.kind === "person").map((m) => m.entry.data.handle.toLowerCase());
    for (const h of officeSuggestions(subjects.offices, text, taken, (o) => o.handles.some((x) => holders.includes(x.toLowerCase())))) {
      handleSuggestions.push(h);
      taken.add(h.handle.toLowerCase());
    }
  }
  const priorWarnings: string[] = [];
  // The reporter routing prior (§3): measured rates and declared beats of the reporter the FILE NAME names
  if (reporterPriorOn && profile) {
    // Every police and collector handle, verified or not: a reporter never brings one (§3.5)
    const districtBound = new Set([...(rules.bound ?? []), ...rules.state.police, ...Object.values(rules.districts).flatMap((d) => [...d.police, ...d.collector])].map((h) => h.toLowerCase()));
    const takenTags = new Set([...tags, footer, ...offered.map((o) => o.tag)].map((t) => t.toLowerCase()));
    const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])].map((h) => h.replace(/^@/, "").toLowerCase()));
    const prior = reporterPrior({ profile, text, taken, takenTags, districtBound, directory }, reporters, beats);
    handleSuggestions.push(...prior.handles);
    offered.push(...prior.hashtags);
    priorWarnings.push(...prior.warnings);
  }
  // First occurrence of each tag wins; never the footer, never a tag already in line 1
  const inLineOne = new Set(tags.map((t) => t.toLowerCase()));
  const hashtagSuggestionItems = offered.filter((o, i) => offered.findIndex((x) => x.tag.toLowerCase() === o.tag.toLowerCase()) === i && o.tag.toLowerCase() !== footer.toLowerCase() && (policy?.layer !== "emit" || !inLineOne.has(o.tag.toLowerCase())));
  const hashtagSuggestions = hashtagSuggestionItems.map((o) => o.tag);
  const prefix = tags.length && !deskRun ? `${tags.join(" ")}: ` : "";
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
  // The decision log's view of all of the above (brief §2.3): line 1's tags only when this composer put them there
  const proposals: Proposal[] = [];
  const stated = place && district ? districtSource(district.from, false) : null;
  if (prefix && place && district) proposals.push({ item: `#${place.tag}`, kind: "hashtag", layer: "emit", source: districtSource(district.from, false), reason: `${place.name}, stated (${district.from})` });
  if (prefix && policy?.layer === "emit") proposals.push({ item: `#${policy.district.tag}`, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.reporterPolicy, reason: policyReason });
  if (prefix && townTag) proposals.push({ item: townTag, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.town, reason: `the town on the place line (${story.town})` });
  proposals.push({ item: footer, kind: "hashtag", layer: "emit", source: PROPOSAL_SOURCES.brand, reason: rajasthan ? "a Rajasthan story" : "a story from outside Rajasthan" });
  for (const h of handles) proposals.push(handleProposal(h, "emit"));
  for (const t of hashtagSuggestionItems) proposals.push(tagProposal(t));
  for (const h of handleSuggestions) proposals.push(handleProposal(h, "suggest"));
  return {
    bodyText, hashtags, hashtagSuggestions, hashtagSuggestionItems, proposals, mentions, handles, handleSuggestions, cls: picked.cls, why: picked.why,
    warnings: [...picked.warnings, ...codeWarnings, ...policyWarnings, ...priorWarnings, ...flags.map((f) => `hashtag typo: ${f}`)],
    unmatchedReporter: picked.unmatchedReporter, headlineCut, composeVersion: `${BREAKING_FORMAT}.${version}`,
    // Only when this composer put line 1's district there (the desk's own tag run is left as written)
    districtSource: !prefix ? null : stated ?? (policy?.layer === "emit" ? PROPOSAL_SOURCES.reporterPolicy : null),
  };
}
