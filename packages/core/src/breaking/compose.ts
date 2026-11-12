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

import { X_LIMIT, assemblePostText, cutOnWords } from "../compose";
import type { HashtagGazetteer } from "../hashtags";
import { xLen } from "../xtext";
import { pickCategoryTags } from "./categories";
import { pickHandlesExplained, type HandlePick, type HandleRules } from "./handles";
import { EMPTY_DESK_HANDLE_RULES, type DeskHandleRules } from "./desk-handles";
import { EMPTY_PARTY_RULES, type PartyRules } from "./parties";
import { EMPTY_REPORTER_RULES, pickReporter, reporterDistrict, type ReporterRules } from "./reporters";
import { EMPTY_NORMALISER, EMPTY_SUGGEST_RULES, HASHTAG, normaliseTag, stripLinks, suggestTags, type SuggestRules, type TagNormaliser } from "./post-tags";
import type { StoryClass } from "./storyclass";
import type { PlaceBook } from "./places";
import { EMPTY_SUBJECT_RULES, type SubjectRules } from "./subjects";

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
 */
export const BREAKING_FORMAT = "b6";

export interface BreakingComposeInput {
  headline: string;
  points: string[];
  /** stories.district: English district or national place, or null */
  district: string | null;
  /** Hindi town from the place line */
  town: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
  /** The headline line as the file had it, place prefix included (parseBreaking); read by the class check */
  rawHeadline?: string;
  /** slotFromTags().reporterToken — the reporter list's key. Never read from the post text. */
  reporterToken?: string | null;
  /** slotFromTags().district — used only when the copy names no district; the copy sets the hashtag */
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
  const place = book.district(story.district);
  const rajasthan = place ? place.rajasthan : story.rajasthan;
  // Which district the handle rules are working in. The post's hashtag comes from `place` — the copy —
  // and is left alone; this is only for the "another district's officer is not ours" test, which has to
  // know the district the rules actually chose. Without it, a story whose district came from the file
  // name alone treats its OWN district as somebody else's and tags no police at all.
  const handlePlace = place ?? (story.fileDistrict ? book.district(story.fileDistrict) : null);
  // A word naming another district: "बूंदी SP ने" in a Jaipur story does not tag Jaipur's police
  const elsewhere = (word: string) => {
    const p = book.lookup(word);
    return p?.kind === "district" && !p.districts.some((d) => d.name === handlePlace?.name);
  };
  const picked = pickHandlesExplained({ ...story, rajasthan, elsewhere }, rules, { subjects, desk, reporters, parties, max: 3 });
  const handles = picked.handles;
  const footer = rajasthan ? RAJASTHAN_FOOTER : NATIONAL_FOOTER;
  // The footer is the only tag that goes on by itself. The topic rules are OFFERED, not applied: measured
  // against 400 published posts (30 Oct 2026), auto-applying them put a tag the desk had not written on
  // 283 posts — #RajasthanElection alone fired 111 times and the desk used it NOT ONCE — and dropped the
  // trailing run's precision from 92.5% to 55.8%. Only 2 of 19 active rules beat a coin flip. A wrong tag
  // costs the desk a deletion on a live post; a missing one costs a click.
  const hashtags = [footer];
  const offered = pickCategoryTags({ headline: story.headline, points: story.points, rajasthan }, topics, [footer]);
  // No district at all (§2.8): infer one and OFFER it — a Rajasthan district the headline names (the curated
  // Hindi names), else the filing reporter's one district. Never into line 1: inference is right 98.5% of the
  // time and the 1.5% is a wrong place on a live post (Navin files every district's ACB story as Jaipur).
  if (!place) {
    const named = book.find(story.headline).find((m) => m.entry.data.kind === "district" && m.entry.data.districts[0]!.rajasthan);
    const inferred = named ? named.entry.data.districts[0]! : book.district(reporterDistrict(pickReporter(story.reporterToken, reporters).match));
    if (inferred) offered.unshift(`#${inferred.tag}`);
  }
  if (at) offered.push(...suggestTags([story.headline, ...story.points].join("\n"), suggestRules, at).map((t) => `#${t}`));
  const hashtagSuggestions = [...new Set(offered)].filter((t) => t.toLowerCase() !== footer.toLowerCase());
  const mentions = handles.map((h) => `@${h.handle}`);

  const tags = [place ? `#${place.tag}` : "", story.town && story.town !== place?.hi ? townHashtag(book.townTag(story.town) ?? story.town) : ""].filter(Boolean);
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
  return {
    bodyText, hashtags, hashtagSuggestions, mentions, handles, handleSuggestions: picked.suggestions, cls: picked.cls, why: picked.why,
    warnings: [...picked.warnings, ...flags.map((f) => `hashtag typo: ${f}`)],
    unmatchedReporter: picked.unmatchedReporter, headlineCut, composeVersion: `${BREAKING_FORMAT}.${version}`,
  };
}
