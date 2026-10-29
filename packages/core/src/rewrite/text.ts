// Text helpers for the rule rewriter: protecting what must not change, sentences in Hindi and English,
// and the phrase swaps. Every change is on whole words (bounded by non-letters), so a Devanagari syllable
// (consonant + matra / virama / nukta) is never split.

import { EN_GROUPS, EN_HEADLINE_GROUPS, EN_ONE_WAY, HI_GROUPS, HI_ONE_WAY, NOT_AFTER, NOT_BEFORE, type OneWay, type PhraseGroup } from "./phrases";
import type { Rng } from "./rng";
import type { RewriteLang } from "./types";

export const oneLine = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
export const wordCount = (s: string) => (s.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length;

export function detectLang(text: string): RewriteLang {
  const deva = (text.match(/\p{Script=Devanagari}/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (deva + latin === 0) return "mixed";
  const share = deva / (deva + latin);
  return share >= 0.7 ? "hi" : share <= 0.3 ? "en" : "mixed";
}

export const isDevanagari = (text: string) => detectLang(text) === "hi" || ((text.match(/\p{Script=Devanagari}/gu) ?? []).length > (text.match(/[A-Za-z]/g) ?? []).length);

// ─── Protected spans ─────────────────────────────────────────────────────────

const OPEN = "";
const CLOSE = "";
const SLOT = /(\d+)/gu;

/** Links, quotations and hashtags/mentions: never reworded, never split */
const PROTECT: RegExp[] = [
  /https?:\/\/\S+/gu,
  /“[^”\n]{1,400}”/gu,
  /"[^"\n]{1,400}"/gu,
  /‘[^’\n]{1,400}’/gu,
  /(?<![\p{L}\p{M}\p{N}])'[^'\n]{1,400}'(?![\p{L}\p{M}\p{N}])/gu,
  /[#@][\p{L}\p{M}\p{N}_]+/gu,
];

export interface Masked {
  text: string;
  slots: string[];
}

/** The mask's own markers (private-use U+E000/U+E001) are never let in from outside */
export const stripMarkers = (text: string) => text.replace(/[]/gu, "");

/** At most `max` UTF-16 units, cut back to a space so no word (or Devanagari syllable) is split */
export function capText(text: string, max: number): string {
  const t = stripMarkers(text);
  if (t.length <= max) return t;
  let i = max;
  while (i > 0 && !/\s/u.test(t[i]!)) i--;
  return t.slice(0, i > 0 ? i : 0).trimEnd();
}

const WORD_CHAR = /[\p{L}\p{M}]/u;
const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c);

/** The word that ends at `end` (spaces before `end` skipped): a backward scan, never a regex over the whole prefix */
export function wordBefore(text: string, end: number): string {
  let i = end;
  while (i > 0 && isSpace(text[i - 1])) i--;
  const stop = i;
  while (i > 0 && WORD_CHAR.test(text[i - 1]!)) i--;
  return text.slice(i, stop);
}

/** The word that starts at `start` (spaces skipped) */
export function wordAfter(text: string, start: number): string {
  let i = start;
  while (i < text.length && isSpace(text[i])) i++;
  const from = i;
  while (i < text.length && WORD_CHAR.test(text[i]!)) i++;
  return text.slice(from, i);
}

export function mask(text: string): Masked {
  const slots: string[] = [];
  let out = stripMarkers(text);
  for (const re of PROTECT) {
    out = out.replace(re, (m) => {
      slots.push(m);
      return `${OPEN}${slots.length - 1}${CLOSE}`;
    });
  }
  return { text: out, slots };
}

export function unmask(text: string, slots: string[]): string {
  let out = text;
  // A slot can hold another slot (a hashtag inside a quotation): repeat until none is left
  for (let i = 0; i < 4 && out.includes(OPEN); i++) out = out.replace(SLOT, (_, n: string) => slots[Number(n)] ?? "");
  return out;
}

export const hasQuote = (text: string) => /[“”"‘’]/u.test(text) || /(?<![\p{L}\p{M}\p{N}])'[^']+'/u.test(text);

// ─── Sentences ───────────────────────────────────────────────────────────────

/** A dot after these is not a sentence end */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "no", "sr", "jr", "vs", "rs", "govt", "gen", "lt", "col", "capt", "hon", "sh", "smt", "pvt", "ltd", "co", "inc",
  "dept", "approx", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "km", "kms", "pc", "डॉ", "श्री", "सं", "प्रो",
]);

/**
 * Sentences, on । ॥ ? ! and on a dot that ends a sentence (not 1.44, a.m., Dr., J. Kamatchi). Quotations
 * are never split. A Devanagari colon join ("चांद:बाड़मेर", Bhaskar's headline:subhead) also ends one.
 */
export function splitSentences(text: string): string[] {
  const joined = oneLine(text).replace(/(\p{Script=Devanagari}[\p{M}]*) ?:(?=\p{Script=Devanagari})/gu, "$1। ");
  const m = mask(joined);
  const t = m.text;
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (!"।॥?!.".includes(c)) continue;
    let j = i;
    while (j + 1 < t.length && "।॥?!.…".includes(t[j + 1]!)) j++;
    const after = t[j + 1];
    if (after !== undefined && after !== " ") {
      i = j;
      continue;
    }
    if (c === "." && j === i) {
      const lastWord = i > start ? wordBefore(t, i) : "";
      let k = j + 1;
      while (k < t.length && isSpace(t[k])) k++;
      const nextChar = t[k] ?? "";
      if ((lastWord.length === 1 && /[A-Za-z]/.test(lastWord)) || ABBREVIATIONS.has(lastWord.toLowerCase()) || /^[a-z]/.test(nextChar)) {
        i = j;
        continue;
      }
    }
    const piece = t.slice(start, j + 1).trim();
    if (piece) out.push(piece);
    start = j + 1;
    i = j;
  }
  const tail = t.slice(start).trim();
  if (tail) out.push(tail);
  return out.map((s) => unmask(s, m.slots));
}

/** A sentence ends with ।, ., ? or !; add the right one when it has none */
export function terminate(sentence: string): string {
  const s = sentence.replace(/[\s,;:\-–—]+$/u, "");
  if (/[।॥.?!…"”’']$/u.test(s)) return s;
  return s + (isDevanagari(s) ? "।" : ".");
}

// ─── Phrase swaps ────────────────────────────────────────────────────────────

interface SwapTable {
  regex: RegExp;
  options: Map<string, string[]>;
  caseless: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildTable(groups: readonly PhraseGroup[], oneWay: readonly OneWay[], caseless: boolean): SwapTable {
  const key = (s: string) => (caseless ? s.toLowerCase() : s);
  const options = new Map<string, string[]>();
  const add = (from: string, to: string) => {
    if (key(from) === key(to)) return;
    const list = options.get(key(from)) ?? [];
    if (!list.includes(to)) list.push(to);
    options.set(key(from), list);
  };
  for (const g of groups) for (const a of g) for (const b of g) add(a, b);
  for (const [from, to] of oneWay) add(from, to);
  const forms = [...options.keys()].sort((a, b) => b.length - a.length).map(escape);
  const regex = new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])(?:${forms.join("|")})(?![\\p{L}\\p{M}\\p{N}_])`, caseless ? "giu" : "gu");
  return { regex, options, caseless };
}

let tables: { hi: SwapTable; en: SwapTable; enHeadline: SwapTable } | null = null;
function swapTables() {
  tables ??= {
    hi: buildTable(HI_GROUPS, HI_ONE_WAY, false),
    en: buildTable(EN_GROUPS, EN_ONE_WAY, true),
    enHeadline: buildTable([...EN_GROUPS, ...EN_HEADLINE_GROUPS], EN_ONE_WAY, true),
  };
  return tables;
}

const SMALL_WORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "at", "for", "and", "or", "by", "with", "as"]);
export const titleCase = (s: string) => s.split(" ").map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Most longer Latin words start with a capital: a Title Case headline */
export function isTitleCase(text: string): boolean {
  const longWords = (text.match(/[A-Za-z][A-Za-z']{3,}/g) ?? []);
  if (longWords.length < 3) return false;
  return longWords.filter((w) => /^[A-Z]/.test(w)).length / longWords.length >= 0.7;
}

/** Only spaces before `offset`, or a sentence/clause end: a backward scan */
function atSentenceStart(text: string, offset: number): boolean {
  let i = offset;
  while (i > 0 && isSpace(text[i - 1])) i--;
  return i === 0 || ".!?।:;—–-".includes(text[i - 1]!);
}

export interface SwapOptions {
  headline: boolean;
  /** The text is a Title Case headline */
  titleCase: boolean;
  /** Chance that a found phrase is swapped */
  rate: number;
}

function applyTable(text: string, table: SwapTable, rng: Rng, opts: SwapOptions): string {
  table.regex.lastIndex = 0;
  return text.replace(table.regex, (match: string, offset: number, whole: string) => {
    const key = table.caseless ? match.toLowerCase() : match;
    const prev = wordBefore(whole, offset);
    if (prev && NOT_AFTER[key]?.includes(prev)) return match;
    const next = wordAfter(whole, offset + match.length);
    if (next && NOT_BEFORE[key]?.includes(next)) return match;
    // A word inside a hyphenated compound ("घर-घर", "विला-कॉटेज") stays
    if (!match.includes("-") && (whole[offset - 1] === "-" || whole[offset + match.length] === "-")) return match;
    const alternatives = table.options.get(key);
    if (!alternatives?.length || !rng.chance(opts.rate)) return match;
    const alt = rng.pick(alternatives);
    if (!table.caseless || match === match.toLowerCase()) return alt;
    // Upper case somewhere: a Title Case headline, a sentence start, or a name (left alone)
    if (opts.titleCase && match.split(" ").every((w) => /^[A-Z]/.test(w) || SMALL_WORDS.has(w))) return titleCase(alt);
    if (/^[A-Z][a-z]/.test(match) && match.slice(1) === match.slice(1).toLowerCase() && atSentenceStart(whole, offset)) return capitalise(alt);
    return match;
  });
}

/**
 * Verbs whose conjunctive participle only means "one thing, then the next" ("खरीदकर" = "खरीदने के बाद").
 * Instrumental "-कर" tells how something was done ("गोली मारकर हत्या", "काटकर", "डालकर", "छीनकर"): "मारने के
 * बाद" would change the facts, so no such verb is here. Names (भास्कर) and idioms (को लेकर, मिलकर, होकर)
 * never match.
 */
export const CONJUNCTIVE_STEMS = ["खरीद", "देख", "सुन", "पहुंच", "पहुँच", "जा", "आ", "लौट"] as const;
const STEMS = CONJUNCTIVE_STEMS.map(escape).join("|");
const PARTICIPLE = new RegExp(`(?<![\\p{L}\\p{M}])(${STEMS})(कर|ने के बाद)(?![\\p{L}\\p{M}])`, "gu");

/** "खरीदकर" ↔ "खरीदने के बाद", in one pass so nothing is swapped back */
function hindiParticiples(text: string, rng: Rng, rate: number): string {
  return text.replace(PARTICIPLE, (m, stem: string, form: string) => (rng.chance(rate) ? `${stem}${form === "कर" ? "ने के बाद" : "कर"}` : m));
}

/** "an probe" → "a probe", "a inquiry" → "an inquiry" after a swap ("a university", "an hour" and acronyms left alone) */
export function fixArticles(text: string): string {
  return text.replace(/\b([Aa])(n?) ([A-Za-z][a-z]+)/g, (all, a: string, n: string, word: string) => {
    if (/^(?:uni|use|usu|eu|one|once|hour|honest|honou?r|heir)/i.test(word)) return all;
    const vowel = /^[aeiou]/i.test(word);
    if (vowel && !n) return `${a}n ${word}`;
    if (!vowel && n) return `${a} ${word}`;
    return all;
  });
}

/** Phrase swaps on text whose protected spans are already masked */
export function swapPhrases(masked: string, rng: Rng, opts: SwapOptions): string {
  const t = swapTables();
  const hi = applyTable(hindiParticiples(masked, rng, opts.headline ? 0.5 : 0.7), t.hi, rng, opts);
  return fixArticles(applyTable(hi, opts.headline ? t.enHeadline : t.en, rng, opts));
}
