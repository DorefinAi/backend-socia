// The compose engine: pure rules, no network. The same module drives the API's live checks, so what
// the operator sees is what the worker posts.

import { districtHashtag, selectTagLine, type HashtagConfig, type HashtagGazetteer } from "./hashtags";
import { suggestMentions, type HandleGazetteer, type MentionSuggestion } from "./mentions";
import { findUrl, stripUrls, URL_REASON, xLen } from "./xtext";

export const X_LIMIT = 280;
/** U+2026: one character, but X weighs it 2 */
export const ELLIPSIS = "…";
export const HEADLINE_WORDS = 9;
/** First India ends a cut story body with four dots, not an ellipsis */
export const BODY_CUT = "....";
/** Bumped when the post layout changes, so drafts from each format can be told apart */
export const COMPOSE_FORMAT = "fi1";

const words = new Intl.Segmenter("hi", { granularity: "word" });
const graphemes = new Intl.Segmenter("hi", { granularity: "grapheme" });
const TRAILING = /[\s।॥,;:\-–—]+$/u;

/** Hashtags and mentions go after a blank line, separated by spaces. */
export function tagLine(hashtags: string[], mentions: string[]): string {
  return [...hashtags, ...mentions].join(" ");
}

export function assemblePostText(bodyText: string, hashtags: string[], mentions: string[]): string {
  return [bodyText.trim(), tagLine(hashtags, mentions)].filter(Boolean).join("\n\n");
}

/** Characters left for the body once the tag line (and an ellipsis) are in. */
export function bodyBudget(hashtags: string[], mentions: string[], limit = X_LIMIT): number {
  const suffix = tagLine(hashtags, mentions);
  return limit - xLen(suffix) - (suffix ? 2 : 0) - xLen(ELLIPSIS);
}

/**
 * Two rules, and the hard one wins: the desk's "about 9 words, then an ellipsis", and X's weighted
 * limit. Cuts are on word, then grapheme, boundaries so a Devanagari syllable is never split.
 */
export function truncateHeadline(headline: string, budget: number, maxWords = HEADLINE_WORDS): { text: string; truncated: boolean } {
  const source = headline.trim();
  const wordSegments = [...words.segment(source)].filter((s) => s.isWordLike);
  const nth = wordSegments[maxWords - 1];
  let text = nth && wordSegments.length > maxWords ? source.slice(0, nth.index + nth.segment.length) : source;

  if (xLen(text) > budget) {
    let out = "";
    for (const { segment } of graphemes.segment(text)) {
      if (xLen(out + segment) > budget) break;
      out += segment;
    }
    text = out;
  }

  const truncated = text.length < source.length;
  text = text.replace(TRAILING, "");
  return { text: truncated ? text + ELLIPSIS : text, truncated };
}

/** The spec's one-call form: headline cut to fit, then the tag line. */
export function composeXText(headline: string, hashtags: string[], mentions: string[], maxWords = HEADLINE_WORDS): string {
  const { text } = truncateHeadline(headline, bodyBudget(hashtags, mentions), maxWords);
  return assemblePostText(text, hashtags, mentions);
}

export interface PostCheck {
  ok: boolean;
  length: number;
  problems: string[];
}

/** What is left of a post once hashtags, mentions, punctuation and spaces are taken out */
const TAG_OR_MENTION = /[#@][\p{L}\p{M}\p{N}_]+/gu;
const NOT_TEXT = /[\s\p{P}\p{S}]+/gu;

/** Run by the API before approve, and again by the publish worker before sending. */
export function checkXPost(text: string): PostCheck {
  const problems: string[] = [];
  const length = xLen(text);
  if (!text.trim()) problems.push("The post is empty.");
  else if (!text.replace(TAG_OR_MENTION, "").replace(NOT_TEXT, "")) problems.push("The post has only hashtags and mentions. Add the news text.");
  if (length > X_LIMIT) problems.push(`The post is ${length - X_LIMIT} characters over X's limit of ${X_LIMIT}.`);
  const url = findUrl(text);
  if (url) problems.push(`"${url}" is a link. ${URL_REASON}`);
  return { ok: problems.length === 0, length, problems };
}

// ─── First India format ──────────────────────────────────────────────────────
//
//   #Jaipur: <full headline>
//
//   <opening of the story body, cut on a word>....
//
//   #RajasthanWithFirstIndia #RajasthanHighCourt
//
// Lines 1 and 2 are the editable bodyText; the tag line is the hashtags (and accepted mentions).

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();
/** After a repeated headline: the end of the text, a space or punctuation, never the rest of a word */
const WORD_END = /^(?:$|[\s।॥.,;:!?\-–—])/u;

/** The body as one paragraph, links taken out (a post must carry none), and the headline not repeated. */
export function bodyExcerpt(body: string, headline = ""): string {
  let text = oneLine(stripUrls(body));
  const head = oneLine(headline);
  // Samvadia uses the body's first sentence when a story has no headline; do not post it twice
  if (head && text.startsWith(head) && WORD_END.test(text.slice(head.length))) {
    text = text.slice(head.length).replace(/^[\s।॥.,;:!?\-–—]+/u, "");
  }
  return text;
}

/**
 * The longest run of whole words that fits the budget, trailing punctuation dropped. "" if not even one
 * word fits. The segmenter is lazy and the loop stops at the first word over budget, so a long body
 * costs no more than a short one.
 */
export function cutOnWords(text: string, budget: number): string {
  if (budget <= 0) return "";
  let end = 0;
  for (const s of words.segment(text)) {
    if (!s.isWordLike) continue;
    const stop = s.index + s.segment.length;
    if (xLen(text.slice(0, stop)) > budget) break;
    end = stop;
  }
  return text.slice(0, end).replace(TRAILING, "");
}

/** Whole graphemes within the budget, never ending on a virama (half a conjunct). The fallback for one huge word. */
function cutOnGraphemes(text: string, budget: number): string {
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    if (xLen(out + segment) > budget) break;
    out += segment;
  }
  return out.replace(/्+$/u, "").replace(TRAILING, "");
}

/** The headline cut to the budget (ellipsis not included): on words, else on graphemes. */
function cutHeadline(headline: string, budget: number): string {
  if (budget <= 0) return "";
  return cutOnWords(headline, budget) || cutOnGraphemes(headline, budget);
}

export interface FirstIndiaParts {
  /** Line 1's hashtag, e.g. "#Jaipur"; "" when the story has no district */
  district: string;
  headline: string;
  body: string;
}

/**
 * Lines 1 and 2, sized so the whole post (tag line and every handle in `tags` included) fits X's limit.
 * The body is cut first, then dropped; only when line 1 alone does not fit is the headline cut (with …),
 * and when even the #District prefix leaves no room it goes too. "" when there is nothing to post.
 */
export function firstIndiaText(parts: FirstIndiaParts, tags: string[], limit = X_LIMIT): string {
  const headline = oneLine(parts.headline);
  if (!headline) return "";
  const suffix = tagLine(tags, []);
  const room = limit - (suffix ? xLen(suffix) + 2 : 0);
  const prefix = parts.district ? `${parts.district}: ` : "";

  const line1 = prefix + headline;
  if (xLen(line1) <= room) {
    const excerpt = bodyExcerpt(parts.body, headline);
    const left = room - xLen(line1) - 2;
    if (!excerpt) return line1;
    if (xLen(excerpt) <= left) return `${line1}\n\n${excerpt}`;
    const cut = cutOnWords(excerpt, left - xLen(BODY_CUT));
    return cut ? `${line1}\n\n${cut}${BODY_CUT}` : line1;
  }

  for (const p of prefix ? [prefix, ""] : [""]) {
    const cut = cutHeadline(headline, room - xLen(p) - xLen(ELLIPSIS));
    if (cut) return `${p}${cut}${ELLIPSIS}`;
  }
  return "";
}

// ─── The composer seam: rules now, an LLM later, same interface ──────────────

export type Platform = "x";
export type ComposeMethod = "rules" | "llm";

export interface StoryForCompose {
  headline: string;
  body: string;
  /** District the source already knows (Samvadia): line 1's #District, e.g. "Jaipur" or "Sawai Madhopur" */
  place?: string | null;
}

export interface DraftContent {
  /** The editable post text, without the tag line */
  bodyText: string;
  hashtags: string[];
  /** Unconfirmed: the operator accepts each one */
  mentionSuggestions: MentionSuggestion[];
  composeMethod: ComposeMethod;
  composeVersion: string;
}

export interface Composer {
  compose(story: StoryForCompose, platform: Platform): Promise<DraftContent>;
}

export interface RuleComposerDeps {
  hashtags: HashtagGazetteer;
  handles: HandleGazetteer;
  hashtagConfig: HashtagConfig;
  /** Identifies the rules and handle tables that produced a draft */
  version: string;
  maxMentions?: number;
}

export class RuleComposer implements Composer {
  constructor(private readonly deps: RuleComposerDeps) {}

  async compose(story: StoryForCompose): Promise<DraftContent> {
    // No headline: the body stands in for it (line 1), and there is no line 2
    const given = story.headline.trim();
    const headline = given || story.body.trim();
    const body = given ? story.body : "";
    const text = `${headline}
${body}`;
    const place = story.place?.trim();
    const district = place ? districtHashtag(place, this.deps.hashtags) : "";
    const hashtags = selectTagLine(text, this.deps.hashtags, this.deps.hashtagConfig, district ? [district] : []);
    const mentionSuggestions = suggestMentions(text, this.deps.handles, this.deps.maxMentions ?? 2);
    // Leave room for every suggestion, so accepting them never pushes the post over the limit
    const bodyText = firstIndiaText({ district, headline, body }, [...hashtags, ...mentionSuggestions.map((m) => m.handle)]);
    return { bodyText, hashtags, mentionSuggestions, composeMethod: "rules", composeVersion: `${COMPOSE_FORMAT}.${this.deps.version}` };
  }
}

export class LlmComposer implements Composer {
  async compose(): Promise<DraftContent> {
    throw new Error("LlmComposer is Phase 2. Phase 1 uses RuleComposer.");
  }
}
