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
import { pickHandles, type HandlePick, type HandleRules } from "./handles";
import { EMPTY_DESK_HANDLE_RULES, type DeskHandleRules } from "./desk-handles";
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
 */
export const BREAKING_FORMAT = "b2";

export interface BreakingComposeInput {
  headline: string;
  points: string[];
  /** stories.district: English district or national place, or null */
  district: string | null;
  /** Hindi town from the place line */
  town: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
  /** The headline line as the file had it, place prefix included (parseBreaking); read by the party check */
  rawHeadline?: string;
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
  limit?: number;
  target?: number;
}

export interface BreakingDraft {
  bodyText: string;
  hashtags: string[];
  mentions: string[];
  handles: HandlePick[];
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
  const { version = "0", topics = null, subjects = EMPTY_SUBJECT_RULES, desk = EMPTY_DESK_HANDLE_RULES, limit = X_LIMIT, target = BREAKING_TARGET } = opts;
  const place = book.district(story.district);
  const rajasthan = place ? place.rajasthan : story.rajasthan;
  // A word naming another district: "बूंदी SP ने" in a Jaipur story does not tag Jaipur's police
  const elsewhere = (word: string) => {
    const p = book.lookup(word);
    return p?.kind === "district" && !p.districts.some((d) => d.name === place?.name);
  };
  const handles = pickHandles({ ...story, rajasthan, elsewhere }, rules, subjects, desk);
  const footer = rajasthan ? RAJASTHAN_FOOTER : NATIONAL_FOOTER;
  const hashtags = [footer, ...pickCategoryTags({ headline: story.headline, points: story.points, rajasthan }, topics, [footer])];
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
  return { bodyText, hashtags, mentions, handles, headlineCut, composeVersion: `${BREAKING_FORMAT}.${version}` };
}
