// The compose engine: pure rules, no network. The same module drives the API's live checks, so what
// the operator sees is what the worker posts.

import { selectHashtags, type HashtagConfig, type HashtagGazetteer } from "./hashtags";
import { suggestMentions, type HandleGazetteer, type MentionSuggestion } from "./mentions";
import { findUrl, URL_REASON, xLen } from "./xtext";

export const X_LIMIT = 280;
/** U+2026: one character, but X weighs it 2 */
export const ELLIPSIS = "…";
export const HEADLINE_WORDS = 9;

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

/** Run by the API before approve, and again by the publish worker before sending. */
export function checkXPost(text: string): PostCheck {
  const problems: string[] = [];
  const length = xLen(text);
  if (!text.trim()) problems.push("The post is empty.");
  if (length > X_LIMIT) problems.push(`The post is ${length - X_LIMIT} characters over X's limit of ${X_LIMIT}.`);
  const url = findUrl(text);
  if (url) problems.push(`"${url}" is a link. ${URL_REASON}`);
  return { ok: problems.length === 0, length, problems };
}

// ─── The composer seam: rules now, an LLM later, same interface ──────────────

export type Platform = "x";
export type ComposeMethod = "rules" | "llm";

export interface StoryForCompose {
  headline: string;
  body: string;
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
    const text = `${story.headline}\n${story.body}`;
    const hashtags = selectHashtags(text, this.deps.hashtags, this.deps.hashtagConfig);
    const mentionSuggestions = suggestMentions(text, this.deps.handles, this.deps.maxMentions ?? 2);
    // Leave room for every suggestion, so accepting them never pushes the post over the limit
    const budget = bodyBudget(hashtags, mentionSuggestions.map((m) => m.handle));
    const { text: bodyText } = truncateHeadline(story.headline, budget);
    return { bodyText, hashtags, mentionSuggestions, composeMethod: "rules", composeVersion: this.deps.version };
  }
}

export class LlmComposer implements Composer {
  async compose(): Promise<DraftContent> {
    throw new Error("LlmComposer is Phase 2. Phase 1 uses RuleComposer.");
  }
}
