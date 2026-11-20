// The desk's handle and hashtag library learns from what the desk posts (owner decision, 20 Nov 2026: no human
// review). Pure parts only; packages/db learn.ts writes what these decide, at the moment a breaking post goes out
// (Approve, Mark posted, Copy & Posted: never on an autosave), and the worker counts the posts behind each keyword.
//
// 1. Handles. A handle the desk typed (handle_directory source "desk") on a posted story learns, as keywords, ONLY
//    the names the system already recognises in that story: its district, the towns and places of the places file,
//    and the names of subject-handles.json found in the headline or points, each in Hindi and English where known.
//    Never an ordinary word. A handle of the data files or a lookalike of one, a party's or an official's handle
//    learns nothing (the same rules as POST /handles/desk: desk-handles.ts deskHandleKeywords), nor does a reporter's.
//    A learned keyword makes the handle SUGGESTED; once DESK_LEARNED_POSTED_USES posted stories carrying the handle
//    name the keyword, the handle is ADDED on its own (desk-handles.ts deskHandleRules), as Settings rows leave
//    suggest-only after SETTINGS_POSTED_USES posts. A keyword found inside the handle string itself (@JhalawarNews →
//    Jhalawar, झालावाड़: what POST /handles/desk gives) is added from the start, as before.
// 2. Hashtags. A tag an editor typed that no rule offered becomes an active topic rule (match_type "entity") at once.
//    Its keywords: a tag naming a known district, place or subject gets that one's Hindi and English names
//    (#Jaisalmer → Jaisalmer, जैसलमेर); any other tag the recognised names of the stories it was posted on plus
//    its own CamelCase words (#JaswantYadav → Jaswant, Yadav). A tag with no usable keyword is saved inactive.
//    Never the footer tags (nor a tag run on from one: "#RajasthanWithFirstIndiaJaipurPolice").

import { fold } from "../fold";
import { Gazetteer, type GazetteerEntry } from "../gazetteer";
import { RAJASTHAN_DISTRICTS } from "../rajasthan";
import { NATIONAL_FOOTER, RAJASTHAN_FOOTER } from "./compose";
import {
  MAX_HANDLE_KEYWORDS, compactLatin, deskHandleKeywords, deskKeywordAuto, districtKeywordCandidates, fileLookalike, keywordsForHandle, usableHandleName,
  type DeskHandleRow, type KeywordCandidate, type KeywordsWithheld,
} from "./desk-handles";
import type { PlaceBook } from "./places";
import type { SubjectRules } from "./subjects";

/** A learned hashtag rule's keywords, at most (the library API's limit for a rule's aliases) */
export const MAX_RULE_KEYWORDS = 30;
/** Learned rules rank below every rule an editor made (the seeded topic rules are 5 to 9) */
export const LEARNED_RULE_PRIORITY = 1;
/** A CamelCase word of a tag shorter than this is not a keyword ("MS" of #MSDhoni, "IPL") */
export const MIN_TAG_WORD_LETTERS = 4;

/** The story a post went out on, as stored */
export interface LearnStory {
  headline: string | null;
  body: string | null;
  /** stories.district: "Sawai Madhopur", "Delhi" */
  district: string | null;
  /** stories.town: a Hindi place-line town */
  town: string | null;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const isHindi = (s: string) => DEVANAGARI.test(s);
const nfc = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const key = (s: string) => fold(nfc(s));
/** One key for a tag or name whatever its spacing, joiners, hyphens or case: "Khairthal-Tijara" = "#khairthaltijara" */
const solidKey = (s: string) => {
  const bare = nfc(s).replace(/^#+/, "");
  return isHindi(bare) ? fold(bare).replace(/[\s_\-]+/g, "") : compactLatin(bare);
};

/** Names in order, each once (folded), usable (3 letters or more), at most `max` */
export function uniqueNames(names: Iterable<string>, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = nfc(raw);
    const k = key(name);
    if (!k || seen.has(k) || !usableHandleName(name) || out.length >= max) continue;
    seen.add(k);
    out.push(name);
  }
  return out;
}

const DISTRICT_BY_NAME = new Map(RAJASTHAN_DISTRICTS.map((d) => [d.name.toLowerCase(), d]));

/** A district's English and Hindi names (Rajasthan's list first, then the places file for a national place) */
function districtNames(name: string, book: PlaceBook | null): string[] {
  const d = DISTRICT_BY_NAME.get(name.toLowerCase());
  if (d) return [d.name, d.hi];
  const info = book?.district(name);
  return info ? [info.name, info.hi] : [];
}

/**
 * The names the system recognises in a story, English then Hindi per name, each once: its district, the place-line
 * town when the places file knows it, the districts, towns and national places the places file finds in the headline
 * and points, and the subjects of subject-handles.json named there (the spelling found, with the subject's main
 * English and Hindi names). Nothing else: an ordinary word is never a name.
 */
export function storyNames(story: LearnStory, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }): string[] {
  const out: string[] = [];
  if (story.district) out.push(...districtNames(story.district, ctx.book));
  const text = [story.headline ?? "", story.body ?? ""].join("\n").normalize("NFC");
  if (ctx.book) {
    const town = story.town ? ctx.book.lookup(story.town) : null;
    if (town) out.push(...(town.kind === "town" ? [town.hi] : [town.districts[0]?.name ?? "", town.hi]));
    for (const m of ctx.book.find(text)) {
      const p = m.entry.data;
      out.push(...(p.kind === "town" ? [p.hi] : [p.districts[0]?.name ?? "", p.hi]));
    }
  }
  for (const m of ctx.subjects?.gazetteer.find(text) ?? []) {
    const spellings = [m.entry.name, ...m.entry.aliases];
    const names = m.entry.data.names.length ? m.entry.data.names : spellings;
    const found = spellings.find((s) => fold(s) === m.matched);
    out.push(names.find((n) => !isHindi(n)) ?? "", names.find(isHindi) ?? "", found ?? "");
  }
  return uniqueNames(out);
}

/** `existing` with the new names after it, each once, at most MAX_HANDLE_KEYWORDS; `added` the ones it did not have */
export function mergeKeywords(existing: readonly string[], names: readonly string[], max = MAX_HANDLE_KEYWORDS): { keywords: string[]; added: string[] } {
  const keywords = [...existing];
  const seen = new Set(existing.map(key));
  const added: string[] = [];
  for (const name of uniqueNames(names)) {
    const k = key(name);
    if (seen.has(k) || keywords.length >= max) continue;
    seen.add(k);
    keywords.push(name);
    added.push(name);
  }
  return { keywords, added };
}

// ─── Handles: which may learn, and when a learned keyword is added on its own ─

/**
 * Why a desk handle may NOT learn keywords, or null when it may. The add rules of POST /handles/desk
 * (deskHandleKeywords: a data-file handle, a lookalike of one, a party's, an official's), with every handle of the
 * four directory files counted as a file handle (a reporter's included), and a lookalike of another handle the org's
 * directory has ("@JhalawarUpdatse" next to "@JhalawarUpdates").
 */
export function handleLearnWithheld(
  handle: string,
  ctx: { candidates: readonly KeywordCandidate[]; fileHandles: Iterable<string>; directoryHandles?: Iterable<string> },
): KeywordsWithheld | null {
  const { withheld } = deskHandleKeywords(handle, { candidates: ctx.candidates, fileHandles: ctx.fileHandles });
  if (withheld) return withheld;
  const self = handle.trim().replace(/^@+/, "").toLowerCase();
  const others = [...(ctx.directoryHandles ?? [])].filter((h) => h.trim().replace(/^@+/, "").toLowerCase() !== self);
  return fileLookalike(handle, others) !== null ? "lookalike" : null;
}

/** The text a story's keywords are counted in: headline, points, its district in both scripts, its town */
function storyText(story: LearnStory): string {
  const district = story.district ? DISTRICT_BY_NAME.get(story.district.toLowerCase()) : undefined;
  return [story.headline ?? "", story.body ?? "", story.district ?? "", district?.hi ?? "", story.town ?? ""].join(" । ");
}

/**
 * For each keyword (keyed by fold()), how many of the stories name it as a whole word: the posted stories behind a
 * desk handle, so a keyword two of them share leaves suggest-only. Each story counts once per keyword.
 */
export function keywordPostedCounts(keywords: readonly string[], stories: readonly LearnStory[]): Map<string, number> {
  const entries: GazetteerEntry<string>[] = uniqueNames(keywords).map((k, i) => ({ id: String(i), name: k, aliases: [], priority: 0, data: key(k) }));
  const out = new Map<string, number>(entries.map((e) => [e.data, 0]));
  if (!entries.length) return out;
  const g = new Gazetteer(entries);
  for (const s of stories) for (const m of g.find(storyText(s))) out.set(m.entry.data, (out.get(m.entry.data) ?? 0) + 1);
  return out;
}

/**
 * A desk row ready for deskHandleRules: its keywords' posted counts (from the stories its posts went out on) and the
 * keywords found inside the handle string itself, which are added from the start.
 */
export function withKeywordUses(row: DeskHandleRow, stories: readonly LearnStory[], candidates: readonly KeywordCandidate[]): DeskHandleRow {
  return { ...row, keywordUses: keywordPostedCounts(row.aliases, stories), handleKeywords: candidates.length ? keywordsForHandle(row.handle, candidates) : [] };
}

/** A stable string of which desk keywords are added on their own: the worker rebuilds its rules when it changes */
export function deskAutoKey(rows: readonly DeskHandleRow[]): string {
  return rows
    .map((r) => `${r.handle.toLowerCase()}=${r.aliases.filter((a) => deskKeywordAuto(r, a)).map(key).sort().join("+")}`)
    .sort()
    .join(",");
}

// ─── Hashtags ───────────────────────────────────────────────────────────────

const FOOTER_KEYS = [RAJASTHAN_FOOTER, NATIONAL_FOOTER].map((t) => solidKey(t));

/** A footer tag, or a tag run on from one ("#RajasthanWithFirstIndiaJaipurPolice"): never a rule */
export function isFooterTag(tag: string): boolean {
  const k = solidKey(tag);
  return !!k && FOOTER_KEYS.some((f) => k === f || k.startsWith(f));
}

/** Words of a tag that say nothing about a story */
const TAG_STOP_WORDS = new Set(["news", "india", "first", "with", "rajasthan", "breaking", "update", "updates", "live", "today", "latest", "alert", "video", "the", "and", "from"]);

/**
 * A tag's own CamelCase words as keywords: "#JaswantYadav" → Jaswant, Yadav; "#RajasthanPanchayatElection2026" →
 * Panchayat, Election. Only from a tag with a capital letter (a lowercase run like "#bbhbh" has no word edges to
 * trust), at least MIN_TAG_WORD_LETTERS letters each, never a stop word.
 */
export function tagWords(tag: string): string[] {
  const bare = nfc(tag).replace(/^#+/, "");
  if (!/[A-Z]/.test(bare)) return [];
  const words = bare.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
  return uniqueNames(words.filter((w) => w.length >= MIN_TAG_WORD_LETTERS && !TAG_STOP_WORDS.has(w.toLowerCase())));
}

let districtCandidates: KeywordCandidate[] | null = null;

/**
 * The Hindi and English names of the district, place or subject a tag names, or null when it names none of them:
 * "#Jaisalmer" → Jaisalmer, जैसलमेर; "#Khairthal" → Khairthal-Tijara, Khairthal, खैरथल-तिजारा...; "#Delhi" → Delhi,
 * दिल्ली; "#गंगापुरसिटी" → the town's name; "#BhajanlalSharma" → the subject's names.
 */
export function knownTagNames(tag: string, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }): string[] | null {
  const k = solidKey(tag);
  if (!k) return null;
  const sameAs = (c: KeywordCandidate) => solidKey(c.latin) === k || c.keywords.some((w) => solidKey(w) === k);
  const district = (districtCandidates ??= districtKeywordCandidates()).find(sameAs);
  if (district) {
    const d = RAJASTHAN_DISTRICTS.find((x) => x.name === district.keywords[0]);
    return uniqueNames([...district.keywords, ...(d ? [d.hi, ...d.aliases] : [])], MAX_RULE_KEYWORDS);
  }
  const place = ctx.book?.hashtag(nfc(tag));
  if (place) {
    const names = place.kind === "town" ? [place.hi, place.tag] : [place.districts[0]?.name ?? "", place.hi];
    const out = uniqueNames(names, MAX_RULE_KEYWORDS);
    if (out.length) return out;
  }
  const subject = ctx.subjects?.keywordCandidates?.find(sameAs);
  if (subject) return uniqueNames(subject.keywords, MAX_RULE_KEYWORDS);
  return null;
}

/**
 * A learned rule's keywords for a tag posted on a story: a known district, place or subject's own names; otherwise the
 * story's recognised names, then the tag's CamelCase words. At most MAX_RULE_KEYWORDS; [] means the rule is saved
 * inactive (nothing to match it on).
 */
export function tagRuleKeywords(tag: string, names: readonly string[], ctx: { book: PlaceBook | null; subjects: SubjectRules | null }): { keywords: string[]; known: boolean } {
  const known = knownTagNames(tag, ctx);
  if (known) return { keywords: known, known: true };
  return { keywords: uniqueNames([...names, ...tagWords(tag)], MAX_RULE_KEYWORDS), known: false };
}

// ─── Everything the learning needs, in one place ────────────────────────────

/** The data files the learning reads, as loaded */
export interface PostedLearnerData {
  book: PlaceBook;
  subjects: SubjectRules;
  /** Every handle of the district-, subject-, party- and reporter-handles files, verified or not */
  fileHandles: Iterable<string>;
}

/** The learning's decisions for one org's posts, built once per data-file version */
export class PostedLearner {
  readonly candidates: readonly KeywordCandidate[];
  readonly fileHandles: ReadonlySet<string>;
  private readonly ctx: { book: PlaceBook; subjects: SubjectRules };

  constructor(data: PostedLearnerData) {
    this.ctx = { book: data.book, subjects: data.subjects };
    this.candidates = [...(districtCandidates ??= districtKeywordCandidates()), ...(data.subjects.keywordCandidates ?? [])];
    this.fileHandles = new Set([...data.fileHandles].map((h) => h.trim().replace(/^@+/, "").toLowerCase()));
  }

  storyNames(story: LearnStory): string[] {
    return storyNames(story, this.ctx);
  }

  handleWithheld(handle: string, directoryHandles: Iterable<string> = []): KeywordsWithheld | null {
    return handleLearnWithheld(handle, { candidates: this.candidates, fileHandles: this.fileHandles, directoryHandles });
  }

  tagKeywords(tag: string, names: readonly string[]): { keywords: string[]; known: boolean } {
    return tagRuleKeywords(tag, names, this.ctx);
  }
}
