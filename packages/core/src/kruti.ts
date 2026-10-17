// Kruti Dev 010 → Unicode.
//
// PROVISIONAL TABLE. Built from the common Kruti Dev 010 layout, not yet from the control room's own
// .ttf. Kruti Dev 010, 011, 016 and 050 differ; until the real font and 200 real files arrive
// (spec §11 Q2), treat every output as unverified and keep conversion_confidence visible.
//
// How it works: an ordered table applied longest key first, then two reordering passes:
// - i-matra: Kruti stores ि (typed "f") BEFORE its consonant cluster; Unicode puts it after.
// - reph: Kruti stores र् (typed "Z") AFTER the syllable it sits on; Unicode puts it before.

const I_MATRA = "";
const REPH = "";

const TABLE: [string, string][] = [
  // digits
  ["å", "०"], ["ƒ", "१"], ["„", "२"], ["…", "३"], ["†", "४"],
  ["‡", "५"], ["ˆ", "६"], ["‰", "७"], ["Š", "८"], ["‹", "९"],

  // nukta letters
  ["d+", "क़"], ["[k+", "ख़"], ["[+", "ख़्"], ["x+", "ग़"], ["t+", "ज़"], ["T+", "ज़्"],
  ["M+", "ड़"], ["<+", "ढ़"], ["Q+", "फ़"], ["¶+", "फ़्"], [";+", "य़"], ["j+", "ऱ"], ["u+", "ऩ"],

  // conjuncts and ligatures
  ["Ùk", "त्त"], ["Ù", "त्त्"], ["Dr", "क्त"], ["–", "दृ"], ["—", "कृ"], ["é", "न्न"], ["™", "न्न्"],
  ["à", "ह्न"], ["á", "ह्य"], ["â", "हृ"], ["ã", "ह्म"], ["ºz", "ह्र"], ["º", "ह्"], ["í", "द्द"],
  ["{k", "क्ष"], ["{", "क्ष्"], ["=", "त्र"], ["«", "त्र्"], ["|", "द्य"], ["K", "ज्ञ"], ["}", "द्व"],
  ["J", "श्र"], ["Vª", "ट्र"], ["Mª", "ड्र"], ["<ª", "ढ्र"], ["Nª", "छ्र"], ["Ø", "क्र"], ["Ý", "फ्र"],
  ["æ", "द्र"], ["ç", "प्र"], ["#", "रु"], [":", "रू"], ["ô", "क्क"], ["ê", "ट्ट"], ["ë", "ट्ठ"],
  ["ì", "ड्ड"], ["ï", "ड्ढ"], ["Ë", "ध्"],

  // independent vowels
  ["v‚", "ऑ"], ["vks", "ओ"], ["vkS", "औ"], ["vk", "आ"], ["v", "अ"], ["bZ", "ई"], ["b", "इ"],
  ["m", "उ"], ["Å", "ऊ"], [",s", "ऐ"], [",", "ए"], ["_", "ऋ"],

  // consonants: full form, and half form (the full form is often half + "k")
  ["d", "क"], ["Dk", "क"], ["D", "क्"], ["[k", "ख"], ["[", "ख्"],
  ["x", "ग"], ["Xk", "ग"], ["X", "ग्"], ["?k", "घ"], ["?", "घ्"], ["³", "ङ"],
  ["p", "च"], ["Pk", "च"], ["P", "च्"], ["N", "छ"], ["t", "ज"], ["Tk", "ज"], ["T", "ज्"],
  [">", "झ"], ["÷", "झ्"], ["¥", "ञ"],
  ["V", "ट"], ["B", "ठ"], ["M", "ड"], ["<", "ढ"], [".k", "ण"], [".", "ण्"],
  ["r", "त"], ["Rk", "त"], ["R", "त्"], ["Fk", "थ"], ["F", "थ्"], ["n", "द"],
  ["/k", "ध"], ["/", "ध्"], ["èk", "ध"], ["è", "ध्"], ["u", "न"], ["Uk", "न"], ["U", "न्"],
  ["i", "प"], ["Ik", "प"], ["I", "प्"], ["Q", "फ"], ["¶", "फ्"],
  ["c", "ब"], ["Ck", "ब"], ["C", "ब्"], ["Hk", "भ"], ["H", "भ्"], ["e", "म"], ["Ek", "म"], ["E", "म्"],
  [";", "य"], ["¸", "य्"], ["j", "र"], ["y", "ल"], ["Yk", "ल"], ["Y", "ल्"], ["G", "ळ"],
  ["o", "व"], ["Ok", "व"], ["O", "व्"], ["'k", "श"], ["'", "श्"], ['"k', "ष"], ['"', "ष्"],
  ["l", "स"], ["Lk", "स"], ["L", "स्"], ["g", "ह"],

  // vowel signs and marks
  ["ks", "ो"], ["kS", "ौ"], ["k", "ा"], ["h", "ी"], ["q", "ु"], ["w", "ू"], ["`", "ृ"],
  ["s", "े"], ["S", "ै"], ["‚", "ॉ"], ["a", "ं"], ["¡", "ँ"], ["%", "ः"], ["W", "ॅ"],
  ["~", "्"], ["z", "्र"], ["ª", "्र"], ["+", "़"], ["f", I_MATRA], ["Z", REPH],

  // punctuation (the plain keys are taken by letters, so Kruti moves these)
  ["A", "।"], ["-", "."], ["&", "-"], ["]", ","], ["@", "/"], ["(", ";"], ["¾", "="], ["\\", "?"],
  ["^", "‘"], ["*", "’"], ["Þ", "“"], ["ß", "”"], ["¼", "("], ["½", ")"], ["¿", "{"], ["À", "}"],
];

const BY_KEY = new Map(TABLE);
const MAX_KEY = Math.max(...TABLE.map(([k]) => k.length));

// A consonant cluster: (consonant + nukta? + virama)* consonant + nukta?
const C = "[\\u0915-\\u0939\\u0958-\\u095F]";
const CLUSTER = `(?:${C}\\u093C?\\u094D)*${C}\\u093C?`;
const I_MATRA_RE = new RegExp(`${I_MATRA}(${CLUSTER})`, "gu");
const REPH_RE = new RegExp(`(${CLUSTER})([\\u093E-\\u094C\\u0962\\u0963]*)([\\u0901-\\u0903]?)${REPH}([\\u0901-\\u0903]?)`, "gu");

function substitute(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    let matched = false;
    for (let len = Math.min(MAX_KEY, input.length - i); len > 0; len--) {
      const value = BY_KEY.get(input.slice(i, i + len));
      if (value !== undefined) {
        out += value;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += input[i];
      i += 1;
    }
  }
  return out;
}

export function krutiToUnicode(input: string): string {
  let text = substitute(input);
  text = text.replace(I_MATRA_RE, "$1ि");
  text = text.replace(REPH_RE, "र्$1$2$3$4");
  // A marker with nothing to attach to is a broken file, not something to guess at
  text = text.replaceAll(I_MATRA, "ि").replaceAll(REPH, "र्");
  return text.normalize("NFC");
}

const DEVANAGARI = /[ऀ-ॿ]/gu;
const LATIN = /[A-Za-z]/g;

/**
 * Share of letters that came out as Devanagari, 0–1. A Kruti file converted correctly is almost all
 * Devanagari; leftover Latin letters mean the table missed something or the file was not Kruti.
 */
export function conversionConfidence(converted: string): number {
  const deva = converted.match(DEVANAGARI)?.length ?? 0;
  const latin = converted.match(LATIN)?.length ?? 0;
  if (deva + latin === 0) return 0;
  return Math.round((deva / (deva + latin)) * 1000) / 1000;
}

/** Below this the operator sees the original text next to the conversion. */
export const LOW_CONFIDENCE = 0.97;

export type SourceEncoding = "unicode" | "krutidev";

/** Text that already has a fair amount of Devanagari is Unicode and must not be converted again. */
export function detectEncoding(text: string): SourceEncoding {
  const deva = text.match(DEVANAGARI)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  return deva > 0 && deva >= latin * 0.5 ? "unicode" : "krutidev";
}

/**
 * Notepad saves Kruti Dev files as ANSI (Windows-1252), where bytes like 0x83 are ƒ (Kruti's १).
 * Valid UTF-8 is read as UTF-8; anything else as Windows-1252.
 */
export function decodeBytes(bytes: Uint8Array): { text: string; charset: "utf-8" | "windows-1252" } {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
    return { text, charset: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), charset: "windows-1252" };
  }
}
