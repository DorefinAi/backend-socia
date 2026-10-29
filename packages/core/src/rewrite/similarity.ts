// How much of a reworded text was copied from a source: word 4-gram overlap plus the longest run of words
// copied in order. Words come from the Unicode word segmenter (Devanagari-aware), lower-cased; punctuation
// does not count.

const wordSegmenter = new Intl.Segmenter("hi", { granularity: "word" });

/** Above this the draft is flagged tooClose (and the rewriter tries other seeds first) */
export const TOO_CLOSE = 0.4;
const GRAM = 4;

export function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const s of wordSegmenter.segment(text.normalize("NFC"))) if (s.isWordLike) out.push(s.segment.toLowerCase());
  return out;
}

function grams(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(" "));
  return out;
}

/** Longest run of words that appears, in the same order, in both */
export function longestCopiedRun(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let best = 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

export interface CopyStats {
  /** Share of the result's word 4-grams that are also in the source (0..1) */
  overlap: number;
  /** Longest run of words copied in order */
  longestRun: number;
  /** 0.8 x overlap + 0.2 x (longestRun / words in the result), 0..1, 3 decimals */
  similarity: number;
}

export function copyStats(result: string, source: string): CopyStats {
  const r = wordTokens(result);
  const s = wordTokens(source);
  if (!r.length || !s.length) return { overlap: 0, longestRun: 0, similarity: 0 };
  // A result shorter than 4 words is compared on its own length
  const n = Math.min(GRAM, r.length);
  const mine = grams(r, n);
  const theirs = grams(s, n);
  let shared = 0;
  for (const g of mine) if (theirs.has(g)) shared++;
  const overlap = mine.size ? shared / mine.size : 0;
  const longestRun = longestCopiedRun(r, s);
  const similarity = Math.round((0.8 * overlap + 0.2 * Math.min(1, longestRun / r.length)) * 1000) / 1000;
  return { overlap: Math.round(overlap * 1000) / 1000, longestRun, similarity };
}

export interface Closest extends CopyStats {
  /** The source the result is most like ("" when there is none) */
  source: string;
}

/** The result against each source; the closest one counts */
export function closestSource(result: string, sources: { source: string; text: string }[]): Closest {
  let best: Closest = { overlap: 0, longestRun: 0, similarity: 0, source: "" };
  for (const s of sources) {
    const stats = copyStats(result, s.text);
    if (!best.source || stats.similarity > best.similarity) best = { ...stats, source: s.source };
  }
  return best;
}
