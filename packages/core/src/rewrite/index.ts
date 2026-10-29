// Draft rewording for the Web Scraper's "Create draft" (handoff/web-scraper-contract.md, "Draft rewording").
// REWRITE_MODE picks the rewriter (only "rules" now); every result goes through the same copy check.

import { RuleRewriter, boundInput } from "./rules";
import { closestSource, TOO_CLOSE } from "./similarity";
import type { RewriteInput, RewriteMode, RewriteOutput, Rewriter } from "./types";

export * from "./types";
export { REWRITE_MAX_HEADLINE_CHARS, REWRITE_MAX_SUMMARY_CHARS, RuleRewriter, boundInput, cleanHeadline, factScore, rewriteHeadline, storySentences } from "./rules";
export { TOO_CLOSE, closestSource, copyStats, longestCopiedRun, wordTokens, type Closest, type CopyStats } from "./similarity";
export { CONJUNCTIVE_STEMS, capText, detectLang, splitSentences, stripMarkers } from "./text";
export { seededRng, hashSeed, type Rng } from "./rng";
export { phraseCount, phraseWords } from "./phrases";

/** More seeds tried when the first result is too close to a source */
export const REWRITE_RETRIES = 3;

export function createRewriter(mode: RewriteMode): Rewriter {
  switch (mode) {
    case "rules":
      return new RuleRewriter();
    // A local model ("local-llm") returns its Rewriter here.
    default:
      return assertNever(mode);
  }
}

function assertNever(mode: never): never {
  throw new Error(`Unknown REWRITE_MODE "${String(mode)}"`);
}

export interface CheckedRewrite extends RewriteOutput {
  /** Against the closest source, 0..1 (see copyStats) */
  similarity: number;
  /** similarity > TOO_CLOSE even after the retries: the desk should reword it by hand */
  tooClose: boolean;
  /** The source it is closest to */
  closestSource: string;
  /** The seed of the kept result */
  seed: string;
  attempts: number;
}

/** What the result is compared with: the lead source is its headline plus its summary, the others their text */
export function referenceTexts(input: RewriteInput): { source: string; text: string }[] {
  if (!input.summaries.length) return [{ source: "", text: input.headline }];
  return input.summaries.map((s, i) => ({ source: s.source, text: i === 0 ? `${input.headline}\n${s.text}` : s.text }));
}

/**
 * Rewrites with `seed`; when the result is too close to a source, tries up to `retries` more seeds
 * (`<seed>#1`, `#2`, ...) and keeps the least similar.
 */
export async function rewriteChecked(rewriter: Rewriter, raw: RewriteInput, seed: string, retries = REWRITE_RETRIES): Promise<CheckedRewrite> {
  // Capped once here, so a long feed text costs no more than a short one (and a future rewriter sees the same)
  const input = boundInput(raw);
  const refs = referenceTexts(input);
  let best: CheckedRewrite | null = null;
  let attempts = 0;
  for (let i = 0; i <= retries; i++) {
    const s = i ? `${seed}#${i}` : seed;
    const out = await rewriter.rewrite(input, s);
    attempts++;
    const c = closestSource(`${out.headline}\n${out.body}`, refs);
    const candidate: CheckedRewrite = { ...out, similarity: c.similarity, tooClose: c.similarity > TOO_CLOSE, closestSource: c.source, seed: s, attempts: 0 };
    if (!best || candidate.similarity < best.similarity) best = candidate;
    if (!candidate.tooClose) break;
  }
  return { ...best!, attempts };
}
