// A story's name for links and downloaded files, instead of a draft id:
//   linkSlug  "jaipur-sms-aspatal-men-naye-trauma-vard-ka-lokarpan-2241"   (/ai-content/x?story=<linkSlug>)
//   fileStem  "Jaipur-SMS-aspatal-men-naye-trauma-vard-09Nov-2241"         (<fileStem>-x.png)
// Hindi is written in plain Latin by a small deterministic transliterator. The spelling is not scholarly, only
// readable and stable: the same story always gets the same name, which is what GET /drafts/resolve relies on.

import { RAJASTHAN_DISTRICTS } from "./rajasthan";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Headline words in a link: at most this many, and at most SLUG_HEADLINE_CHARS characters joined */
export const SLUG_HEADLINE_WORDS = 8;
export const SLUG_HEADLINE_CHARS = 60;
/** Headline words in a file name (the first of the link's words) */
export const FILE_HEADLINE_WORDS = 6;
const DISTRICT_CHARS = 30;
/** The slug of a story without a district */
export const NO_DISTRICT_SLUG = "news";

// ---- Devanagari → Latin ----------------------------------------------------------------------------------

const CONSONANTS: Record<string, string> = {
  क: "k", ख: "kh", ग: "g", घ: "gh", ङ: "n",
  च: "ch", छ: "chh", ज: "j", झ: "jh", ञ: "n",
  ट: "t", ठ: "th", ड: "d", ढ: "dh", ण: "n",
  त: "t", थ: "th", द: "d", ध: "dh", न: "n", ऩ: "n",
  प: "p", फ: "ph", ब: "b", भ: "bh", म: "m",
  य: "y", र: "r", ऱ: "r", ल: "l", ळ: "l", ऴ: "l", व: "v",
  श: "sh", ष: "sh", स: "s", ह: "h",
};

/** The consonant with a nukta (base + U+093C, which is what NFC leaves for क़ … य़) */
const NUKTA: Record<string, string> = { क: "q", ख: "kh", ग: "g", ज: "z", ड: "r", ढ: "rh", फ: "f", य: "y" };

const VOWELS: Record<string, string> = {
  अ: "a", आ: "a", इ: "i", ई: "i", उ: "u", ऊ: "u", ऋ: "ri", ॠ: "ri", ऌ: "li",
  ए: "e", ऐ: "ai", ओ: "o", औ: "au", ऑ: "au", ऍ: "e", ऎ: "e", ऒ: "o",
};

const MATRAS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "ॄ": "ri",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "au", "ॅ": "e", "ॆ": "e", "ॊ": "o",
};

const HALANT = "्";
const NUKTA_SIGN = "़";
const ANUSVARA = "ं";
const CHANDRABINDU = "ँ";
const VISARGA = "ः";
const LABIALS = new Set(["प", "फ", "ब", "भ", "म"]);

type Unit =
  /** A consonant: vowel "" = halant, inherent = the vowel is the unwritten schwa */
  | { k: "c"; latin: string; vowel: string; inherent: boolean; deleted?: boolean }
  /** An independent vowel */
  | { k: "v"; latin: string }
  /** Anything else kept as is: anusvara, digits, Latin letters */
  | { k: "x"; latin: string };

const hasVowel = (u: Unit | undefined) => !!u && (u.k === "v" || (u.k === "c" && u.vowel !== "" && !u.deleted));
const endsInVowel = (u: Unit | undefined) => hasVowel(u) || (!!u && u.k === "x" && /[aeiou]$/.test(u.latin));

/**
 * One word, Devanagari and/or Latin, in lowercase-free plain Latin (Latin letters keep their case). Schwa
 * deletion: a word-final inherent "a" goes (जयपुर → jaypur, वार्ड → vard) unless the word is one syllable or ends
 * in a conjunct (पत्र → patra); a medial one goes between a vowel and a consonant-plus-vowel (जयपुर → jay·pur).
 */
export function transliterateWord(word: string): string {
  const units: Unit[] = [];
  const chars = [...word.normalize("NFC")];
  const lastC = () => {
    const u = units.at(-1);
    return u?.k === "c" ? u : null;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (CONSONANTS[ch] !== undefined) {
      const nukta = chars[i + 1] === NUKTA_SIGN;
      units.push({ k: "c", latin: nukta ? (NUKTA[ch] ?? CONSONANTS[ch]!) : CONSONANTS[ch]!, vowel: "a", inherent: true });
      if (nukta) i++;
    } else if (ch === NUKTA_SIGN) {
      // A nukta not straight after its consonant: ignore
    } else if (MATRAS[ch] !== undefined) {
      const c = lastC();
      if (c && c.inherent) Object.assign(c, { vowel: MATRAS[ch]!, inherent: false });
      else units.push({ k: "v", latin: MATRAS[ch]! });
    } else if (ch === HALANT) {
      const c = lastC();
      if (c) Object.assign(c, { vowel: "", inherent: false });
    } else if (VOWELS[ch] !== undefined) {
      // नए → naye, गए → gaye: an ए after a vowel is said with a y
      const glide = (ch === "ए" || ch === "ऐ") && endsInVowel(units.at(-1));
      units.push({ k: "v", latin: (glide ? "y" : "") + VOWELS[ch]! });
    } else if (ch === ANUSVARA) {
      units.push({ k: "x", latin: LABIALS.has(chars[i + 1] ?? "") ? "m" : "n" });
    } else if (ch === CHANDRABINDU) {
      units.push({ k: "x", latin: "n" });
    } else if (ch === VISARGA) {
      units.push({ k: "x", latin: "h" });
    } else if (ch === "ॐ") {
      units.push({ k: "v", latin: "om" });
    } else if (ch >= "०" && ch <= "९") {
      units.push({ k: "x", latin: String(ch.charCodeAt(0) - 0x966) });
    } else if (/[A-Za-z0-9]/.test(ch)) {
      units.push({ k: "x", latin: ch });
    } else {
      // Latin with accents: café → cafe; anything else (marks, symbols) is dropped
      const plain = ch.normalize("NFD").replace(/[^A-Za-z0-9]/g, "");
      if (plain) units.push({ k: "x", latin: plain });
    }
  }

  // Word-final schwa
  const syllables = units.filter((u) => u.k === "v" || (u.k === "c" && u.vowel !== "")).length;
  const last = units.at(-1);
  if (last?.k === "c" && last.inherent && syllables > 1) {
    const before = units.at(-2);
    // पत्र, मंत्र, स्वास्थ्य keep it; a reph cluster (वार्ड, अर्थ) does not
    const conjunct = before?.k === "c" && before.vowel === "" && before.latin !== "r";
    if (!conjunct) last.deleted = true;
  }
  // Medial schwa, right to left: V C(a) C V → V C C V
  for (let i = units.length - 2; i > 0; i--) {
    const u = units[i]!;
    if (u.k !== "c" || !u.inherent || u.deleted) continue;
    const next = units[i + 1];
    if (hasVowel(units[i - 1]) && next?.k === "c" && hasVowel(next)) u.deleted = true;
  }

  return units.map((u) => (u.k === "c" ? u.latin + (u.deleted ? "" : u.vowel) : u.latin)).join("");
}

// ---- Words -------------------------------------------------------------------------------------------------

/** Split on anything that is not a letter, mark or digit (spaces, punctuation, emoji, hyphens) */
function rawWords(text: string): string[] {
  return text.normalize("NFC").split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

interface District {
  /** "Sawai-Madhopur" */
  title: string;
  /** "sawai-madhopur" */
  slug: string;
  /** Ways the headline may name it, folded: "jaipur", "जयपुर" */
  names: string[];
}

const fold = (s: string) => s.normalize("NFC").toLowerCase().trim();

function district(value: string | null | undefined): District | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const known = RAJASTHAN_DISTRICTS.find((d) => [d.name, d.hi, ...d.aliases].some((n) => fold(n) === fold(v)));
  const english = known?.name ?? v;
  const words = rawWords(english).map(transliterateWord).filter(Boolean);
  if (!words.length) return null;
  const title = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join("-").slice(0, DISTRICT_CHARS).replace(/-+$/, "");
  const names = [v, ...(known ? [known.name, known.hi, ...known.aliases] : [])].map(fold);
  return { title, slug: title.toLowerCase(), names };
}

/** "जयपुर: …", "#Jaipur: …", "मेड़ता सिटी : …": one or two words (a place) before a colon */
const COLON_PREFIX = /^\s*((?:#?[\p{L}\p{M}\p{N}_.]+\s*){1,2})[:：|]\s*[-–—]?\s*(.+)$/su;
/** "जयपुर- …", "Jaipur – …", "#Jaipur …", "कोटा में …": the district itself as the first word */
const DISTRICT_LEAD = /^\s*(#?)([\p{L}\p{M}\p{N}_]+)\s*([-–—,]?)\s*(.+)$/su;

/** The headline without a leading place, so the district is not said twice */
export function stripPlacePrefix(headline: string, districtValue?: string | null): string {
  let h = headline.trim();
  const colon = COLON_PREFIX.exec(h);
  // Only when a real headline follows (two words or more)
  if (colon && rawWords(colon[2]!).length >= 2) h = colon[2]!.trim();
  const d = district(districtValue);
  const lead = d ? DISTRICT_LEAD.exec(h) : null;
  // The district as the first word ("कोटा में बारिश …") goes too, when a headline is left after it
  if (lead && d!.names.includes(fold(lead[2]!)) && rawWords(lead[4]!).length >= (lead[1] || lead[3] ? 1 : 2)) h = lead[4]!.trim();
  return h;
}

/** The headline's words in Latin, as written in a file name: Latin keeps its case (SMS), Hindi is lowercase */
function headlineWords(headline: string, districtValue: string | null | undefined): string[] {
  return rawWords(stripPlacePrefix(headline, districtValue))
    .map((w) => {
      const latin = transliterateWord(w);
      return /[ऀ-ॿ]/.test(w) ? latin.toLowerCase() : latin;
    })
    .filter(Boolean);
}

/** Whole words while they fit in `chars` joined by "-" (a lone first word longer than that is cut) */
function fit(words: string[], maxWords: number, chars: number): string[] {
  const out: string[] = [];
  let len = 0;
  for (const w of words.slice(0, maxWords)) {
    const add = (out.length ? 1 : 0) + w.length;
    if (len + add > chars) {
      if (!out.length) out.push(w.slice(0, chars));
      break;
    }
    out.push(w);
    len += add;
  }
  return out;
}

// ---- The name -------------------------------------------------------------------------------------------------

export interface StoryNameInput {
  /** stories.district: English district (or national place); Hindi is mapped / transliterated; null = none */
  district: string | null | undefined;
  /** stories.headline */
  headline: string | null | undefined;
  /** stories.createdAt: when the story was received */
  receivedAt: Date | string;
}

export interface StoryName {
  /** [a-z0-9-] only: "<district>-<headline words>-<HHMM IST>" */
  linkSlug: string;
  /** Filesystem-safe [A-Za-z0-9-]: "<District>-<headline words>-<DDMon>-<HHMM>" */
  fileStem: string;
}

/** IST clock parts of a time */
export function istParts(at: Date | string): { hh: string; mm: string; day: string; month: string } {
  const ist = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const two = (n: number) => String(n).padStart(2, "0");
  return { hh: two(ist.getUTCHours()), mm: two(ist.getUTCMinutes()), day: two(ist.getUTCDate()), month: MONTHS[ist.getUTCMonth()]! };
}

export function storyLinkName({ district: districtValue, headline, receivedAt }: StoryNameInput): StoryName {
  const d = district(districtValue);
  const { hh, mm, day, month } = istParts(receivedAt);
  const words = headlineWords(headline ?? "", districtValue);

  const slugWords = fit(
    words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean),
    SLUG_HEADLINE_WORDS,
    SLUG_HEADLINE_CHARS,
  );
  const fileWords = fit(
    words.map((w) => w.replace(/[^A-Za-z0-9]/g, "")).filter(Boolean),
    FILE_HEADLINE_WORDS,
    SLUG_HEADLINE_CHARS,
  );

  return {
    linkSlug: [d?.slug ?? NO_DISTRICT_SLUG, ...slugWords, `${hh}${mm}`].join("-"),
    fileStem: [d?.title ?? "News", ...fileWords, `${day}${month}`, `${hh}${mm}`].join("-"),
  };
}

/** A linkSlug's parts for a lookup: the IST hour and minute at its end, and whether it names no district */
export function parseLinkSlug(slug: string): { hour: number; minute: number; noDistrict: boolean; districtPrefix: string } | null {
  const m = /^([a-z0-9][a-z0-9-]*?)-(\d{2})(\d{2})$/.exec(slug);
  if (!m) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, noDistrict: m[1] === NO_DISTRICT_SLUG || m[1]!.startsWith(`${NO_DISTRICT_SLUG}-`), districtPrefix: m[1]!.split("-")[0]! };
}
