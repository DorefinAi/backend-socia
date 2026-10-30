// The phase-1 X post for a breaking file, in the @1stIndiaNews desk style:
//
//   #Jodhpur #रावतभाटा: <headline>
//
//   <point 1>, <point 2>, <point 3>...
//
//   #RajasthanWithFirstIndia @CP_Jodhpur
//
// bodyText is lines 1–2 (editable), hashtags the footer tag, mentions the handles; assemblePostText()
// puts them together exactly as the desk copies it. Always within X's 280 (weighted).

import { X_LIMIT, assemblePostText, cutOnWords } from "../compose";
import { xLen } from "../xtext";
import { pickHandles, type HandlePick, type HandleRules } from "./handles";
import type { PlaceBook } from "./places";

export const RAJASTHAN_FOOTER = "#RajasthanWithFirstIndia";
export const NATIONAL_FOOTER = "#FirstIndiaNews";
/** The desk cuts with three dots */
export const BREAKING_CUT = "...";
/** The desk's posts run 190–265 (median 218): points stop here even when X would allow more */
export const BREAKING_TARGET = 265;
/** Bumped when the layout changes, so drafts of each format can be told apart */
export const BREAKING_FORMAT = "b1";

export interface BreakingComposeInput {
  headline: string;
  points: string[];
  /** stories.district: English district or national place, or null */
  district: string | null;
  /** Hindi town from the place line */
  town: string | null;
  rajasthan: boolean;
  leaderPost: boolean;
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
const trimPoint = (p: string) => p.replace(/[\s।॥|.,;:!-]+$/u, "").replace(/\s+/g, " ").trim();

/** The longest run of whole points (", "-joined) that fits, then the next point cut on a word, then "...". */
export function joinPoints(points: string[], budget: number): string {
  const parts = points.map(trimPoint).filter(Boolean);
  if (!parts.length || budget <= 0) return "";
  const all = parts.join(", ");
  if (xLen(all) <= budget) return all;
  const room = budget - xLen(BREAKING_CUT);
  const cut = cutOnWords(all, room).replace(/[\s,]+$/u, "");
  return cut ? cut + BREAKING_CUT : "";
}

export function composeBreaking(story: BreakingComposeInput, rules: HandleRules, book: PlaceBook, version = "0", limit = X_LIMIT, target = BREAKING_TARGET): BreakingDraft {
  const place = book.district(story.district);
  const rajasthan = place ? place.rajasthan : story.rajasthan;
  const handles = pickHandles({ ...story, rajasthan }, rules);
  const hashtags = [rajasthan ? RAJASTHAN_FOOTER : NATIONAL_FOOTER];
  const mentions = handles.map((h) => `@${h.handle}`);

  const tags = [place ? `#${place.tag}` : "", story.town && story.town !== place?.hi ? townHashtag(book.townTag(story.town) ?? story.town) : ""].filter(Boolean);
  const prefix = tags.length ? `${tags.join(" ")}: ` : "";
  const headline = story.headline.replace(/\s+/g, " ").trim();
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
