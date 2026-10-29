// The rule rewriter: rebuilds a headline and a short body from what the publishers wrote, in other words,
// without AI and without any network. Facts stay as they were: numbers, names, places, dates, quotations
// and hashtags are never touched (only whole common phrases from ./phrases are swapped, and quotations and
// hashtags are masked first). Every choice comes from the seed, so a seed always gives the same text.

import { RAJASTHAN_DISTRICTS } from "../rajasthan";
import { seededRng, type Rng } from "./rng";
import { wordTokens } from "./similarity";
import {
  capText, capitalise, hasQuote, isDevanagari, isTitleCase, mask, oneLine, splitSentences, swapPhrases, terminate, unmask, wordCount,
} from "./text";
import type { RewriteInput, RewriteOutput, Rewriter } from "./types";

/** At most this much body: the post shows only its start, the story keeps the rest for the desk */
const MAX_UNITS = 3;
const MAX_BODY_CHARS = 520;
/** Two sentences sharing this share of their content words tell the same fact */
const SAME_FACT = 0.5;

const DISTRICT_NAMES = new Set(RAJASTHAN_DISTRICTS.flatMap((d) => [d.name.toLowerCase(), d.hi, ...d.aliases.map((a) => a.toLowerCase())]));
const isPlace = (s: string) => DISTRICT_NAMES.has(s.trim().toLowerCase()) || /^(?:राजस्थान|rajasthan)$/iu.test(s.trim());

// ─── Noise the publishers add ────────────────────────────────────────────────

/** Leading tags ("LIVE", "Exclusive", "बड़ी खबर") */
const LEAD_TAG =
  /^(?:(?:LIVE(?: Updates?)?|Live Updates?|BREAKING(?: NEWS)?|Breaking(?: News)?|EXCLUSIVE|Exclusive|Big News|ब्रेकिंग(?: न्यूज़?)?|बड़ी खबर|एक्सक्लूसिव|लाइव)\s*[:|\-–—]?\s+|(?:जानिए|जानें|जानिये|देखिए|देखें)\s*[:\-–—]\s*)/u;

/** Hindi labels before a colon that carry nothing the post needs */
const HI_LABELS = new Set(["राजस्थान", "राजस्थान न्यूज़", "राजस्थान न्यूज", "राजस्थान समाचार", "राजस्थान की खबरें", "बड़ी खबर", "ताजा खबर", "आज का मौसम", "मौसम अपडेट", "लाइव", "ब्रेकिंग न्यूज़", "ब्रेकिंग न्यूज"]);
/** English labels: short, and one of these words */
const EN_LABEL_WORD = /\b(?:news|update|updates|live|alert|breaking|exclusive|today|explained|watch|video|photos|pics)\b/i;

/** Click-bait endings, cut from the end (repeated) */
const HI_TAILS: RegExp[] = [
  /(?:^|[\s,;:।|…\-–—]+)(?:यहां |यहाँ |ऐसे |अभी )?(?:जानें|जानिए|जानिये|देखें|देखिए|देखिये|पढ़ें|पढ़िए)(?: [^,;:|।]*)?[?!।]*$/u,
  /(?:^|[\s,;:।|…\-–—]+)(?:जानें |जानिए )?(?:क्या है )?पूरा मामला[?!]*$|(?:^|[\s,;:।|…\-–—]+)क्या है मामला[?!]*$/u,
  /(?:^|[\s,;:।|…\-–—]+)जानकर (?:करेंगे तारीफ|हैरान रह जाएंगे|चौंक जाएंगे|उड़ जाएंगे होश)[^,;|।]*$/u,
  /(?:^|[\s,;:।|…\-–—]+)(?:गजब है ये|हैरान कर देगी)[^,;|।]*$/u,
  /[,;:।|…\-–—]\s*(?:देखें |देखिए )?(?:वीडियो|फोटो|तस्वीरें|Video|VIDEO|Photos?|PHOTOS?)$/u,
];
const EN_TAILS: RegExp[] = [
  /(?:[,;:|…\-–—]\s*|\s+)(?:here'?s why|here’s why|here'?s what (?:we know|happened)|here’s what (?:we know|happened)|details inside|check details|know more|full details|all you need to know|what we know(?: so far)?|read more|find out)[.!?]*$/i,
  /[,;:|…\-–—]\s*(?:watch(?: the)? video|watch|video|photos|pics|see pics)[.!?]*$/i,
];

/** Whole sentences that are site furniture */
const BOILERPLATE =
  /(?:ये भी पढ़ें|यह भी पढ़ें|यह भी पढे़ं|इसे भी पढ़ें|also read|read more|follow us|हमें फॉलो करें|फॉलो करें|copyright|©|all rights reserved|सर्वाधिकार सुरक्षित|disclaimer|डिस्क्लेमर|click here|यहां क्लिक करें|subscribe|सब्सक्राइब|download (?:the )?app|ऐप डाउनलोड|सिलसिलेवार|पढ़ें पूरी खबर|पूरी खबर पढ़ें|लाइव अपडेट्स के लिए|for (?:the )?latest updates|join our|व्हाट्सऐप चैनल|whatsapp चैनल|get the latest)/iu;
/** The publisher talking about itself ("भास्कर ने किया था खुलासा") */
const SELF_PROMO = /(?:भास्कर|पत्रिका|अमर उजाला|न्यूज18|न्यूज़18|news18|bhaskar|patrika)\s?(?:ने (?:किया था |की थी |किया |प्रमुखता से )?(?:खुलासा|खबर)|की खबर|की पड़ताल|reported first)/iu;
/** Bylines */
const BYLINE = /^(?:by|written by|edited by|reported by|report by|रिपोर्ट|लेखक|संवाददाता|रिपोर्टर)\b\s*[:\-–]?\s*\S/iu;
/** Picture captions and agency credits inside a sentence */
const CREDIT =
  /\s*[([](?:file photo|फाइल फोटो|फ़ाइल फ़ोटो|सांकेतिक तस्वीर|सांकेतिक फोटो|प्रतीकात्मक तस्वीर|प्रतीकात्मक फोटो|representative image|representational image|photo ?: [^)\]]*|फोटो ?: [^)\]]*|image ?: [^)\]]*|source ?: [^)\]]*|with inputs from [^)\]]*|इनपुट[^)\]]*|एजेंसी|भाषा|PTI|IANS|ANI|UNI)[)\]]/giu;

/** Dateline at the start of a story: "जयपुर।", "अजमेर.", "JAIPUR:", "Jaipur, Oct 29 (PTI):" */
const HI_DATELINE = /^\p{Script=Devanagari}+(?: \p{Script=Devanagari}+)?\s*(?:\([^)]{1,20}\))?\s*[।.:]\s+/u;
const EN_DATELINE = /^(?:[A-Z]{3,}(?: [A-Z]{3,})?|[A-Z][a-z]+(?: [A-Z][a-z]+)?,\s*[A-Z][a-z]{2,8}\.? \d{1,2})(?:\s*\((?:PTI|IANS|ANI|Reuters|UNI)\))?\s*[:–—-]\s+/u;
/** A Latin SEO line before a Hindi story ("Karwa Chauth Moonrise Time 29 Oct: आज ...") */
const SEO_PREFIX = /^([^\p{Script=Devanagari}:।]{2,140}):\s+/u;

/** A sentence that leans on the one before ("उन्होंने ...", "He said ...") travels with it */
const LEANS_ON_PREVIOUS =
  /^(?:उन्होंने|उसने|उनके|उनकी|उनका|उन्हें|इन्होंने|इसके|इससे|इसमें|इसे|इस पर|वहीं|साथ ही|हालांकि|लेकिन|मगर|इसलिए|ऐसे में|यह|ये|वह|वे|उस|इसी)(?=[\s,])|^(?:He|She|They|It|This|These|Those|His|Her|Their|However|But|Meanwhile|Also|Later)\b/u;
/** A part of a headline that is someone speaking stays after its speaker */
const SPEECH = /^(?:कहा|बोले|बोलीं|बोला|said|says)\b|^(?:कहा|बोले|बोलीं)\s*[-–—]/iu;
/** A clause starting with these hangs on the one before it */
const DEPENDENT = /^(?:जिससे|जिसमें|जिसके|जो|जब|तो|और|लेकिन|मगर|पर|वहीं|क्योंकि|ताकि|बल्कि|जबकि|यानी|and|but|which|who|as|while|after|before)(?=[\s,])/iu;

const STOPWORDS = new Set([
  "के", "का", "की", "में", "से", "को", "ने", "पर", "और", "है", "हैं", "था", "थे", "थी", "हो", "गया", "गई", "गए", "कर", "करने", "किया", "एक", "यह", "वह", "इस", "उस",
  "जो", "तो", "भी", "ही", "तक", "लिए", "साथ", "बाद", "रहा", "रही", "रहे", "जा", "रहे", "होगा", "होगी", "दिया", "दी", "हुआ", "हुई", "हुए", "अब", "कि", "न", "नहीं",
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "is", "are", "was", "were", "be", "been", "by", "with", "at", "from", "that", "this", "it", "as", "has",
  "have", "had", "will", "would", "said", "after", "over", "its", "his", "her", "their",
]);
const contentWords = (text: string) => new Set(wordTokens(text).filter((w) => !STOPWORDS.has(w) && !/^\d/.test(w)));
const numbersIn = (text: string) => new Set(text.match(/\d+(?:[.,:]\d+)*/g) ?? []);

/** Overlap of two word sets against the smaller one */
function overlapShare(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

const MONTHS_DAYS =
  /(?:जनवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार|January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/u;
const OFFICIALS =
  /(?:मंत्री|विधायक|सांसद|कलेक्टर|एसपी|पुलिस|अधिकारी|आयुक्त|न्यायालय|कोर्ट|अदालत|सरकार|विभाग|बोर्ड|आयोग|\bminister|\bMLA\b|\bMP\b|collector|police|official|court|government|department|\bSP\b|\bDGP\b|\bCM\b|commission)/iu;

/** How much a sentence carries: numbers, dates, quotations, officials, places, names */
export function factScore(text: string): number {
  let score = numbersIn(text).size * 2;
  if (MONTHS_DAYS.test(text)) score += 1;
  if (hasQuote(text)) score += 1;
  if (OFFICIALS.test(text)) score += 1;
  if (wordTokens(text).some((w) => DISTRICT_NAMES.has(w))) score += 1;
  // A capitalised word after the first: a name
  if (/\s[A-Z][a-z]+/.test(text)) score += 1;
  return score;
}

function cutTails(text: string, tails: RegExp[]): string {
  let out = text;
  for (let pass = 0; pass < 4; pass++) {
    const before = out;
    for (const re of tails) {
      const cut = out.replace(re, "");
      // Never cut a headline down to almost nothing
      if (cut !== out && wordCount(cut) >= 3) out = cut;
    }
    if (out === before) break;
  }
  return out;
}

const trimSeparators = (s: string) => s.replace(/^[\s,;:|.\-–—…]+/u, "").replace(/[\s,;:|\-–—…]+$/u, "").trim();

/** The publisher's own name at the end ("… - Dainik Bhaskar", "… | Patrika", "… ThePrint") */
function dropSiteName(text: string, sources: string[]): string {
  let out = text;
  for (const name of sources.filter((s) => s.trim().length >= 3)) {
    const re = new RegExp(`(?:\\s*[-|–—:]\\s*|\\s+)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "iu");
    out = out.replace(re, "");
  }
  return out.replace(/\s*[-|–—]\s*(?:[A-Z][\w.]*(?: [A-Z][\w.]*){0,3}|दैनिक भास्कर|अमर उजाला|राजस्थान पत्रिका|पत्रिका|नवज्योति)\s*$/u, (m) =>
    /(?:news|times|express|bhaskar|patrika|ujala|ndtv|abp|hindustan|jagran|tv9|news18|etv|india|today|post|print|herald|live|भास्कर|उजाला|पत्रिका|नवज्योति)/iu.test(m) ? "" : m,
  );
}

/** Google News cuts long headlines with "..." (often mid-word): drop the cut word and the dots */
function dropTruncation(text: string): string {
  const m = text.match(/^(.*?)(\s?)(?:\.{3}|…)\s*$/su);
  if (!m) return text;
  const body = m[1]!;
  return m[2] ? body : body.replace(/\s*[^\s]*$/u, "");
}

// ─── Headline ────────────────────────────────────────────────────────────────

interface HeadlineCtx {
  district: string | null;
  sources: string[];
  rng: Rng;
}

/** A label before the first colon that the post does not need */
function isDroppableLabel(label: string, rest: string, ctx: Omit<HeadlineCtx, "rng">): boolean {
  const l = label.trim();
  if (!l || wordCount(rest) < 3) return false;
  const latinOnly = !/\p{Script=Devanagari}/u.test(l);
  if (latinOnly && /\p{Script=Devanagari}/u.test(rest)) return true;
  if (HI_LABELS.has(l)) return true;
  if (latinOnly && wordCount(l) <= 4 && EN_LABEL_WORD.test(l)) return true;
  if (isPlace(l)) {
    if (/^(?:राजस्थान|rajasthan)$/iu.test(l)) return true;
    const district = ctx.district?.toLowerCase();
    const d = RAJASTHAN_DISTRICTS.find((x) => x.name.toLowerCase() === l.toLowerCase() || x.hi === l || x.aliases.includes(l));
    // Line 1's #District already says it, or the rest of the headline does
    return (!!d && d.name.toLowerCase() === district) || (!!d && (rest.includes(d.hi) || rest.toLowerCase().includes(d.name.toLowerCase())));
  }
  return false;
}

/** The headline cleaned of site names, tags, labels and click-bait, but not reworded */
export function cleanHeadline(raw: string, ctx: Omit<HeadlineCtx, "rng">): string {
  // "2026:जयपुर" → "2026: जयपुर" (never a time like 8:23)
  let h = oneLine(raw)
    .replace(/([^\s\p{Script=Devanagari}]):(?=\p{L})/gu, "$1: ")
    // "'डांस':'बोतल वाले'": a part ends at a quotation's end, or the unquoted words would join ("डांस:बोतल")
    .replace(/([’'"”]):(?=[‘'"“\p{L}])/gu, "$1; ");
  h = dropSiteName(h, ctx.sources);
  h = dropTruncation(h);
  for (let i = 0; i < 3; i++) {
    const before = h;
    h = h.replace(LEAD_TAG, "");
    const m = h.match(/^([^:|]{1,60}?)\s*(?::|\|)\s*(.+)$/u);
    if (m && isDroppableLabel(m[1]!, m[2]!, ctx)) h = m[2]!;
    if (h === before) break;
  }
  h = cutTails(h, [...HI_TAILS, ...EN_TAILS]);
  return trimSeparators(h.replace(CREDIT, ""));
}

/** Headline parts: Bhaskar's "a:b", " : ", " | ", "; " and TV9's "a… b" */
function headlineParts(h: string): string[] {
  return h
    .replace(/(\p{Script=Devanagari}) ?:(?=\p{Script=Devanagari})/gu, "$1\u0000")
    .replace(/\s+:\s+|\s*\|\s*|;\s+|…\s+/gu, "\u0000")
    .split("\u0000")
    // "…, भास्कर ने किया था खुलासा": only that clause goes
    .map((p) => trimSeparators(p.split(/,\s+/u).filter((c) => !SELF_PROMO.test(c)).join(", ")))
    .filter(Boolean);
}

const isSpeech = (part: string) => SPEECH.test(part.trim());

/** "a, b" → "b, a" when both are whole clauses (3+ words, neither hangs on the other, nobody speaking) */
function swapClauses(part: string, rng: Rng): string {
  const clauses = part.split(/,\s+/u);
  if (clauses.length !== 2) return part;
  const [a, b] = clauses as [string, string];
  if (wordCount(a) < 3 || wordCount(b) < 3 || DEPENDENT.test(b) || isSpeech(a) || isSpeech(b) || //u.test(b.slice(0, 2))) return part;
  return rng.chance(0.55) ? `${b}, ${a}` : part;
}

export function rewriteHeadline(raw: string, ctx: HeadlineCtx): string {
  const cleaned = cleanHeadline(raw, ctx);
  if (!cleaned) return oneLine(raw);
  const { rng } = ctx;
  // A place label that stays ("जोधपुर: …") keeps its place at the front
  const kept = cleaned.match(/^([^:|]{1,30}):\s+(.+)$/u);
  if (kept && isPlace(kept[1]!)) return `${kept[1]}: ${rewriteHeadline(kept[2]!, ctx)}`;
  const m = mask(cleaned);
  const hindi = isDevanagari(unmask(m.text, m.slots));
  const titleCase = !hindi && isTitleCase(cleaned);

  let parts = headlineParts(m.text);
  if (!parts.length) parts = [m.text];
  // Subject first: the part with the most facts leads (never someone's words before the speaker)
  if (parts.length > 1 && rng.chance(0.6)) {
    const scored = parts.map((p, i) => ({ p, i, s: factScore(unmask(p, m.slots)) }));
    const lead = scored.filter((x) => !isSpeech(x.p) && x.i > 0 && !isSpeech(parts[x.i + 1] ?? "")).sort((a, b) => b.s - a.s)[0];
    if (lead && lead.s >= scored[0]!.s) parts = [lead.p, ...parts.filter((_, i) => i !== lead.i)];
  }
  if (hindi) parts = parts.map((p) => swapClauses(p, rng));
  else {
    // "3 Dead After Thar Crashes Into Bike" → "Thar Crashes Into Bike, 3 Dead"
    parts = parts.map((p) => {
      const a = p.match(/^(.+?) (After|after) (.+)$/u);
      if (!a || wordCount(a[1]!) > 5 || wordCount(a[1]!) < 2 || wordCount(a[3]!) < 2 || !rng.chance(0.6)) return p;
      return `${capitalise(a[3]!)}, ${titleCase ? a[1]! : a[1]!.charAt(0).toLowerCase() + a[1]!.slice(1)}`;
    });
  }
  const joiner = hindi ? rng.pick([", ", "; "]) : rng.pick(["; ", " — "]);
  // "…एंट्री?, जोधपुर" → "…एंट्री? जोधपुर"
  let out = parts.join(joiner).replace(/([?!])[,;] /gu, "$1 ");
  out = swapPhrases(out, rng, { headline: true, titleCase, rate: 0.9 });
  out = unmask(out, m.slots);
  return trimSeparators(oneLine(out)) || cleaned;
}

// ─── Body ────────────────────────────────────────────────────────────────────

interface Unit {
  source: string;
  /** Position of the source (0 = the lead item's) */
  rank: number;
  /** Order within its source */
  order: number;
  sentences: string[];
  text: string;
  score: number;
}

/** A publisher's text: datelines, SEO lines and greetings off, then clean sentences */
export function storySentences(text: string, sources: string[]): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/u)) {
    let t = oneLine(para);
    if (!t) continue;
    t = dropSiteName(t, sources);
    // SEO line, label, dateline and greeting can come in any order ("Jaipur News: जयपुर। नमस्कार, …")
    for (let pass = 0; pass < 3; pass++) {
      const before = t;
      t = t.replace(/^नमस्कार\s*[,।!]\s*/u, "");
      const seo = t.match(SEO_PREFIX);
      if (seo && isDevanagari(t.slice(seo[0].length))) t = t.slice(seo[0].length);
      const label = t.match(/^([^:।.]{1,30}):\s+/u);
      if (label && (HI_LABELS.has(label[1]!.trim()) || (wordCount(label[1]!) <= 3 && /\p{Script=Devanagari}/u.test(label[1]!) && !/[।.?!]/u.test(label[1]!) && isPlace(label[1]!)))) t = t.slice(label[0].length);
      t = t.replace(HI_DATELINE, (d) => (wordCount(d) <= 2 ? "" : d)).replace(EN_DATELINE, "");
      if (t === before) break;
    }
    t = t.replace(CREDIT, "");
    let sentences = splitSentences(t);
    // A summary cut short ends with "…": its last sentence is not whole
    const last = sentences.at(-1);
    if (last && /(?:\.{3}|…)$/u.test(last)) {
      if (sentences.length > 1) sentences = sentences.slice(0, -1);
      else sentences = [last.replace(/\s*(?:\.{3}|…)$/u, "")];
    }
    for (const s of sentences) {
      let c = trimSeparators(cutTails(s.replace(LEAD_TAG, ""), [...HI_TAILS, ...EN_TAILS]));
      if (!c || BOILERPLATE.test(c) || SELF_PROMO.test(c) || BYLINE.test(c) || wordCount(c) < 3) continue;
      c = c.replace(/^[,;:\-–—]+\s*/u, "");
      out.push(c);
    }
  }
  return out;
}

/** Sentences grouped so a "he said" or "उन्होंने" sentence is never parted from the one naming the person */
function units(sentences: string[], source: string, rank: number): Unit[] {
  const out: Unit[] = [];
  for (const s of sentences) {
    const prev = out.at(-1);
    if (prev && LEANS_ON_PREVIOUS.test(s)) {
      prev.sentences.push(s);
      prev.text = `${prev.text} ${s}`;
      prev.score = factScore(prev.text);
    } else out.push({ source, rank, order: out.length, sentences: [s], text: s, score: factScore(s) });
  }
  return out;
}

/** Words that end a Hindi place / time / object phrase before the subject */
const PHRASE_END = /(?:^|\s)(?:में|को|से|पर|तक|से पहले|के बाद|के दौरान|के तहत|के अंतर्गत|के मामले में)$/u;
const POSTPOSITION = /^(?:में|से|को|पर|तक|के|की|का|ने|द्वारा|लिए|बाद|पहले|दौरान|तहत|बीच|साथ|खिलाफ|विरुद्ध|ओर|तरफ|अंतर्गत)$/u;
const DAY_TIME = /^((?:सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार|रविवार)(?: (?:को|सुबह|शाम|रात|देर रात|दोपहर))?|आज|देर रात|बीते दिन) /u;

/**
 * Hindi word order, which the language leaves free: "<place/time phrase> <subject> ने …" → "<subject> ने
 * <place/time phrase> …", and "<subject> ने गुरुवार को …" → "गुरुवार को <subject> ने …". The subject is the
 * words after the last postposition (at most 5, no comma); a genitive ("राजस्थान के मुख्यमंत्री") is never split.
 */
function hindiWordOrder(s: string, rng: Rng): string {
  const at = s.indexOf(" ने ");
  if (at < 0 || s.indexOf(" ने ", at + 1) >= 0) return s;
  const before = s.slice(0, at);
  const after = s.slice(at + 4);
  const day = after.match(DAY_TIME);
  if (day && !DAY_TIME.test(`${before} `) && rng.chance(0.6)) return `${day[1]} ${before} ने ${after.slice(day[0].length)}`;
  const words = before.split(" ");
  let k = -1;
  for (let j = words.length - 1; j >= 0; j--) {
    if (POSTPOSITION.test(words[j]!.replace(/,$/u, ""))) {
      k = j;
      break;
    }
  }
  if (k < 1) {
    // "<subject> ने <… के मामले में> <rest>" → "<… के मामले में> <subject> ने <rest>"
    const chunk = after.match(/^(.+? (?:के मामले में|के तहत|के अंतर्गत|के दौरान|के बाद|से पहले|के चलते|की वजह से|के कारण|को लेकर)) (.+)$/u);
    if (chunk && wordCount(chunk[1]!) >= 3 && wordCount(chunk[2]!) >= 3 && !//u.test(chunk[1]!) && wordCount(before) <= 6 && rng.chance(0.7)) {
      return `${chunk[1]} ${before} ने ${chunk[2]}`;
    }
    return s;
  }
  const phrase = words.slice(0, k + 1).join(" ");
  const subject = words.slice(k + 1).join(" ");
  if (!subject || wordCount(subject) > 5 || /[,।]/u.test(subject) || DEPENDENT.test(subject) || !PHRASE_END.test(phrase) || //u.test(subject)) return s;
  return rng.chance(0.7) ? `${subject} ने ${phrase} ${after}` : s;
}

const EN_DAY = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?: (?:morning|afternoon|evening|night))?";
/** A common word that started a sentence, lower-cased once the sentence starts elsewhere (never a name) */
const lowerArticle = (t: string) =>
  /^(?:The|A|An|There|It|This|These|Those|Their|His|Her|Its|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Several|Many|Some|All|Both|Over|More|At)\b/.test(t)
    ? t.charAt(0).toLowerCase() + t.slice(1)
    : t;

/** English: "On Monday, X …" ↔ "X … on Monday" */
function englishWordOrder(s: string, rng: Rng): string {
  const lead = s.match(new RegExp(`^(On ${EN_DAY}|Earlier on ${EN_DAY}|Late on ${EN_DAY}), (.+?)([.!?]*)$`, "u"));
  if (lead && wordCount(lead[2]!) >= 4 && rng.chance(0.6)) return `${capitalise(lead[2]!)} ${lead[1]!.charAt(0).toLowerCase()}${lead[1]!.slice(1)}${lead[3] || "."}`;
  const tail = s.match(new RegExp(`^(.+?) (on ${EN_DAY})([.!?]*)$`, "u"));
  if (tail && wordCount(tail[1]!) >= 4 && rng.chance(0.6)) return `${capitalise(tail[2]!)}, ${lowerArticle(tail[1]!)}${tail[3] || "."}`;
  return s;
}

/** Hindi "X ने बताया कि Y।" → "Y, X ने बताया।"; English "Y, police said." ↔ "Police said Y." */
function restructure(masked: string, rng: Rng): string {
  const s = masked.trim();
  const hi = s.match(/^([^,।:]{2,80}?) ने (बताया|कहा) कि (.+?)([।.!?]*)$/u);
  if (hi && wordCount(hi[1]!) <= 8 && wordCount(hi[3]!) >= 3 && !/ कि /u.test(hi[1]!) && rng.chance(0.6)) {
    return `${hi[3]!.replace(/[,\s]+$/u, "")}, ${hi[1]} ने ${hi[2]}${hi[4] || "।"}`;
  }
  const pro = s.match(/^(उन्होंने|उसने|इन्होंने) (बताया|कहा) कि (.+?)([।.!?]*)$/u);
  if (pro && wordCount(pro[3]!) >= 3 && rng.chance(0.6)) return `${pro[3]!.replace(/[,\s]+$/u, "")}, ${pro[1]} ${pro[2]}${pro[4] || "।"}`;

  const lowerStart = lowerArticle;
  const said = s.match(/^(.+?),\s(police|officials|authorities|sources)\s(said|added|stated)([.!?]*)$/iu);
  if (said && wordCount(said[1]!) >= 4 && rng.chance(0.6)) return `${capitalise(said[2]!.toLowerCase())} ${said[3]} ${lowerStart(said[1]!)}${said[4] || "."}`;
  const says = s.match(/^(Police|Officials|Authorities) (said|stated) (?:that )?(.+?)([.!?]*)$/u);
  if (says && wordCount(says[3]!) >= 4 && rng.chance(0.6)) return `${capitalise(says[3]!)}, ${says[1]!.toLowerCase()} ${says[2]}${says[4] || "."}`;
  const acc = s.match(/^According to ([^,]{2,60}), (.+?)([.!?]*)$/u);
  if (acc && wordCount(acc[2]!) >= 4 && rng.chance(0.6)) return `${capitalise(acc[2]!)}, according to ${acc[1]}${acc[3] || "."}`;
  return isDevanagari(s) ? hindiWordOrder(s, rng) : englishWordOrder(s, rng);
}

/** Hindi ", जिसमें …" / ", जिससे …" / ", जहां …" → a sentence of its own ("। इसमें …") */
function splitRelative(masked: string, rng: Rng): string {
  return masked.replace(/^(.+?), (जिसमें|जिससे|जिसके|जिसे|जहां|जहाँ) (.+)$/u, (all, a: string, rel: string, b: string) => {
    if (wordCount(a) < 4 || wordCount(b) < 3 || !rng.chance(0.8)) return all;
    const to: Record<string, string> = { "जिसमें": "इसमें", "जिससे": "इससे", "जिसके": "इसके", "जिसे": "इसे", "जहां": "वहां", "जहाँ": "वहां" };
    return `${a}। ${to[rel]} ${b}`;
  });
}

function rewriteSentence(sentence: string, rng: Rng): string {
  // A Title Case line in a body is another publisher's headline: headline rules
  if (!isDevanagari(sentence) && isTitleCase(sentence)) return terminate(rewriteHeadline(sentence, { district: null, sources: [], rng }));
  const m = mask(sentence);
  let t = restructure(m.text, rng);
  t = splitRelative(t, rng);
  t = swapPhrases(t, rng, { headline: false, titleCase: false, rate: 0.9 });
  return terminate(oneLine(unmask(t, m.slots)));
}

/** Longest headline and summary read (longer ones are cut on a space): keeps every rule linear-ish in time */
export const REWRITE_MAX_HEADLINE_CHARS = 300;
export const REWRITE_MAX_SUMMARY_CHARS = 4096;
/** Publishers read at most */
const MAX_SOURCES = 3;

/** Input capped and cleared of the mask's private-use markers */
export function boundInput(input: RewriteInput): RewriteInput {
  return {
    ...input,
    headline: capText(input.headline ?? "", REWRITE_MAX_HEADLINE_CHARS),
    summaries: (input.summaries ?? []).slice(0, MAX_SOURCES).map((s) => ({ source: capText(s.source ?? "", 200), text: capText(s.text ?? "", REWRITE_MAX_SUMMARY_CHARS) })),
  };
}

export class RuleRewriter implements Rewriter {
  readonly name = "rules" as const;

  async rewrite(input: RewriteInput, seed: string): Promise<RewriteOutput> {
    return this.rewriteSync(input, seed);
  }

  rewriteSync(raw: RewriteInput, seed: string): RewriteOutput {
    const input = boundInput(raw);
    const rng = seededRng(seed);
    const sources = input.summaries.map((s) => s.source).filter(Boolean);
    const district = input.district ?? null;
    const headline = rewriteHeadline(input.headline, { district, sources, rng });

    // Facts already in the headline are not told again in the body
    const told = contentWords(cleanHeadline(input.headline, { district, sources }));
    const chosen: Unit[] = [];
    // Round robin over the publishers (lead first), so the body blends them instead of copying one
    const candidates = input.summaries
      .flatMap((s, rank) => units(storySentences(s.text, sources), s.source, rank))
      .sort((a, b) => a.order - b.order || a.rank - b.rank);
    // The lead source first, then the others, each in its own order: up to 3 publishers
    const publishers = new Set<string>();
    for (const u of candidates) {
      if (chosen.length >= MAX_UNITS) break;
      if (!publishers.has(u.source) && publishers.size >= 3) continue;
      const words = contentWords(u.text);
      if (overlapShare(words, told) >= 0.6 && words.size <= told.size + 3) continue;
      const nums = numbersIn(u.text);
      const repeats = chosen.some((c) => {
        const share = overlapShare(words, contentWords(c.text));
        const cNums = numbersIn(c.text);
        const sameNumbers = nums.size > 0 && [...nums].every((n) => cNums.has(n));
        return share >= SAME_FACT || (sameNumbers && share >= 0.3);
      });
      if (repeats) continue;
      if (chosen.reduce((n, c) => n + c.text.length, 0) + u.text.length > MAX_BODY_CHARS && chosen.length) continue;
      chosen.push(u);
      publishers.add(u.source);
    }

    // Fact-bearing units first; the lead's opening stays first, the other facts may trade places
    const facts = chosen.filter((u) => u.score > 0);
    const rest = chosen.filter((u) => u.score === 0);
    const [lead, ...others] = facts;
    const ordered = [...(lead ? [lead] : []), ...(rng.chance(0.5) ? rng.shuffle(others) : others), ...rest];
    const body = ordered.map((u) => u.sentences.map((s) => rewriteSentence(s, rng)).join(" ")).join(" ");

    const used = [...new Set([...(input.summaries[0]?.source ? [input.summaries[0].source] : []), ...ordered.map((u) => u.source)])].filter(Boolean);
    return { headline, body: oneLine(body), usedSources: used };
  }
}

