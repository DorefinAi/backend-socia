// Whether a headline OPENS with a place, spelling-tolerantly (b9, owner 23 Nov 2026: B4/B6). One matcher for the
// composer's "never twice" rule (compose.ts), the heading replay's check (packages/db/scripts/heading-replay.ts) and,
// as a copy kept in step by a shared case list, the desk's card heading (frontend cardWords.ts).
//
// Two spellings are the same place when their keys are equal: NFC; zero-width joiners out; nukta, chandrabindu and
// anusvara out ("नैनवा" = "नैनवां", "बूँदी" = "बूंदी"); long vowels as short ("बड़ीसादड़ी" = "बडिसादडि"); spaces,
// hyphens and underscores out ("बड़ी सादड़ी" = "बड़ीसादड़ी"); Latin lower-cased.

/** Zero-width non-joiner and joiner: inside a Devanagari word, never part of its spelling */
const JOINERS = /[\u200c\u200d]/g;

/** A place spelling's key (see the top of this file) */
export function placeMatchKey(text: string): string {
  return text
    .normalize("NFC")
    .replace(JOINERS, "")
    .normalize("NFD")
    .replace(/[ङञणनम]्(?=[क-ह])/g, "ं") // a half nasal before a consonant is the anusvara (बून्दी = बूंदी)
    .replace(/[़ँं]/g, "") // nukta, chandrabindu, anusvara
    .replace(/ी/g, "ि") // ी → ि
    .replace(/ू/g, "ु") // ू → ु
    .replace(/ई/g, "इ") // ई → इ
    .replace(/ऊ/g, "उ") // ऊ → उ
    .normalize("NFC")
    .replace(/[\s\-–—_]+/gu, "")
    .toLowerCase();
}

/** One word of a headline: letters, marks, digits and the joiners inside them */
const WORD = /[\p{L}\p{M}\p{N}\u200c\u200d]+/gu;

/** The most words a place name is written in ("नीम का थाना", "चौथ का बरवाड़ा", "सवाई माधोपुर"): R2 */
export const PLACE_MAX_WORDS = 4;

/**
 * When `headline` opens with one of `names` (its first word, or its first words written apart: "बड़ी सादड़ी", "नीम का
 * थाना"), the length of that opening in `headline` (so `headline.slice(n)` is what follows it); 0 otherwise. The longest
 * match wins, so "बड़ी सादड़ी में" never matches a town "बड़ी" alone when "बड़ीसादड़ी" is asked for.
 */
export function openingPlaceLength(headline: string, names: Iterable<string>): number {
  const keys = new Set([...names].map(placeMatchKey).filter(Boolean));
  if (!keys.size) return 0;
  const lead = /^\s*/u.exec(headline)![0].length;
  const words = [...headline.slice(lead).matchAll(WORD)].slice(0, PLACE_MAX_WORDS);
  if (!words[0] || words[0].index !== 0) return 0;
  // Words written apart count together only when nothing but spaces or a hyphen sits between them
  let joined = 1;
  while (joined < words.length && /^[\s\-–]+$/u.test(headline.slice(lead + words[joined - 1]!.index! + words[joined - 1]![0].length, lead + words[joined]!.index!))) joined++;
  for (let k = joined; k >= 1; k--) {
    if (keys.has(placeMatchKey(words.slice(0, k).map((w) => w[0]).join("")))) return lead + words[k - 1]!.index! + words[k - 1]![0].length;
  }
  return 0;
}

/**
 * R3 (owner, 23 Nov 2026): the place word is part of a compound or a route when a hyphen or dash follows it
 * ("जयपुर-दिल्ली हाईवे", "बेगूं-चित्तौड़गढ़ मार्ग"): then it is never dropped or replaced, on line 1 or on the card.
 */
export function placeWordInCompound(headline: string, opening: number): boolean {
  return opening > 0 && /^\s*[-–—]/u.test(headline.slice(opening));
}
