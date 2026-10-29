// Text measurement the way X counts it, and the no-URL gate.

const graphemes = new Intl.Segmenter("hi", { granularity: "grapheme" });
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * X's weighted length (twitter-text v3 config). Code points in these ranges weigh 1, everything
 * else 2. Devanagari (U+0900–U+097F) is inside the first range, so Hindi weighs 1 per code point:
 * दिल्ली is 6, not 3. An emoji sequence weighs 2 however many code points it has.
 * The ellipsis U+2026 is outside the ranges and weighs 2.
 */
const LIGHT: [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

function weightOf(cp: number): number {
  return LIGHT.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
}

export function xLen(text: string): number {
  let total = 0;
  for (const { segment } of graphemes.segment(text.normalize("NFC"))) {
    if (EMOJI.test(segment)) {
      total += 2;
      continue;
    }
    for (const ch of segment) total += weightOf(ch.codePointAt(0)!);
  }
  return total;
}

export function splitGraphemes(text: string): string[] {
  return [...graphemes.segment(text)].map((s) => s.segment);
}

// X turns a bare domain into a link too, so "jaipur.gov.in" counts as a URL.
const URL_PATTERNS = [
  /\bhttps?:\/\/\S+/i,
  /\bwww\.\S+/i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|org|net|co|io|gov|news|info|me|ly|tv|live|app|xyz)\b(?:\/\S*)?/i,
];

/** The first URL-like part of the text, or null. Posts must contain none (see URL_REASON). */
/** Every URL-like part in one pass (the same patterns as findUrl), however many there are. */
const ANY_URL = new RegExp(URL_PATTERNS.map((p) => p.source).join("|"), "gi");

export function stripUrls(text: string): string {
  return text.replace(ANY_URL, " ");
}

export function findUrl(text: string): string | null {
  for (const pattern of URL_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export const URL_REASON =
  "X charges about 13 times more for a post that contains a link. Remove the link to post this.";
