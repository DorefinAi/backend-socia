// The desk's handle and hashtag library learns from what the desk posts (owner decision, 20 Nov 2026: no human
// review). Pure parts only; packages/db learn.ts writes what these decide, at the moment a breaking post goes out
// (Approve, Mark posted, Copy & Posted: never on an autosave), and the worker counts the posts behind each keyword.
//
// 1. Handles. A handle the DESK TYPED on a posted story (handle_directory source "desk"; never one the composer put on
//    the post or offered: db learn.ts typedHandles) learns, as keywords, only names of its own (learning fix, 25 Nov
//    2026, after @jpr_rural learned Air India and Hyderabad and @NitinNabin learned Punjab and Jaipur):
//      - places only from the story's own district and place-line town, never every place in the body, and only
//        when that place is in the handle's own district (handleDistricts: a district or its file code in the handle
//        string, "@jpr_rural" → Jaipur). A handle with no district of its own (a person's, a party's, a national
//        one) learns no place at all;
//      - subjects only when the subject is the handle's own (its name is in the handle string).
//    A handle of the data files or a lookalike of one (or of another directory handle: also a strict prefix of one,
//    "@forest" of "@forestRajasthan"), a party's or an official's handle learns nothing, nor does a reporter's.
//    A learned keyword is used only once DESK_LEARNED_POSTED_USES stories on which the desk typed the handle name it;
//    then it is OFFERED. A place never makes the handle ADDED on its own; a subject does from DESK_LEARNED_AUTO_USES.
//    A keyword found inside the handle string itself (@JhalawarNews → Jhalawar, झालावाड़: what POST /handles/desk
//    gives) is added from the start, as before. A desk handle the desk keeps ignoring is offered no more
//    (desk-handles.ts suggestionRetired).
// 2. Hashtags. A tag an editor typed that no rule offered becomes an active topic rule (match_type "entity") at once.
//    Its keywords: a tag naming a known district, place or subject gets that one's Hindi and English names
//    (#Jaisalmer → Jaisalmer, जैसलमेर); any other tag only its own words that are not places and the subjects named
//    inside it (#JaswantYadav → Jaswant, Yadav; never the story's places: #RajasthanPanchayatElection2026 learned
//    Jaipur, Hanumangarh...). A tag with no usable keyword is saved inactive. Never the footer tags (nor a tag run on
//    from one: "#RajasthanWithFirstIndiaJaipurPolice"), nor a tag that is a handle typed with a # ("#Balotrapolice").

import { fold } from "../fold";
import { Gazetteer, type GazetteerEntry } from "../gazetteer";
import { RAJASTHAN_DISTRICTS } from "../rajasthan";
import { NATIONAL_FOOTER, RAJASTHAN_FOOTER } from "./compose";
import {
  MAX_HANDLE_KEYWORDS, compactLatin, deskHandleKeywords, deskKeywordAuto, deskKeywordOffered, districtKeywordCandidates, handleTypoOf, keywordsForHandle,
  matchHandleKeywords, suggestionRetired, usableHandleName, type DeskHandleRow, type KeywordCandidate, type KeywordsWithheld, type SuggestStats,
} from "./desk-handles";
import type { Place, PlaceBook } from "./places";
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
 * four directory files counted as a file handle (a reporter's included), and a typo or stub of another handle the
 * org's directory or the files have (handleTypoOf: "@forest" next to "@forestRajasthan"). `protectedHandles` (the
 * Settings-verified directory rows) are never typos; the files' handles never are either.
 */
export function handleLearnWithheld(
  handle: string,
  ctx: { candidates: readonly KeywordCandidate[]; fileHandles: Iterable<string>; directoryHandles?: Iterable<string>; protectedHandles?: Iterable<string> },
): KeywordsWithheld | null {
  const { withheld } = deskHandleKeywords(handle, { candidates: ctx.candidates, fileHandles: ctx.fileHandles });
  if (withheld) return withheld;
  return handleLookalikeOf(handle, [...ctx.fileHandles, ...(ctx.directoryHandles ?? [])], [...ctx.fileHandles, ...(ctx.protectedHandles ?? [])]) !== null ? "lookalike" : null;
}

/**
 * The other known handle this one is a typo or stub of, as written there (bare), or null (desk-handles.ts handleTypoOf:
 * a stub, the same without "_" and trailing digits, or one edit at 8 letters or more). A handle in `protectedHandles`
 * is never one. What the desk is pointed to instead ("did you mean").
 */
export function handleLookalikeOf(handle: string, known: Iterable<string>, protectedHandles: Iterable<string> = []): string | null {
  return handleTypoOf(handle, known, protectedHandles);
}

// ─── Handles: which names are a handle's own ────────────────────────────────

/** Not in the places file, but a place: a state's name is never a local handle's own keyword */
const STATE_NAMES = new Set(["Rajasthan", "राजस्थान"].map((s) => key(s)));
const districtName = (name: string) => RAJASTHAN_DISTRICTS.find((x) => compactLatin(x.name) === compactLatin(name))?.name ?? name;
const bareHandle = (h: string) => h.trim().replace(/^@+/, "");

/**
 * The Rajasthan districts (their English names, as stories.district holds them) a handle is of: a district's name
 * inside the handle string ("@JaipurDiscom1" → Jaipur, the matcher of POST /handles/desk) or a district's file-name
 * code as a whole word of it ("@jpr_rural", "@JprRuralPolice" → Jaipur). None for a person's, party's or national handle.
 */
export function handleDistricts(handle: string, book: PlaceBook | null): string[] {
  const out = new Set<string>();
  for (const m of matchHandleKeywords(handle, (districtCandidates ??= districtKeywordCandidates()))) out.add(m.keywords[0]!);
  if (book) {
    const words = bareHandle(handle).split(/[^A-Za-z]+/).flatMap((p) => p.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []);
    for (const w of words) {
      const d = w.length === 3 ? book.codes[w.toUpperCase()] : undefined;
      if (d) out.add(districtName(d));
    }
  }
  return [...out];
}

/**
 * The districts a name is a place of, or null when it is not a place: a Rajasthan district (any spelling) → itself;
 * a town → its districts; a national place or a state → [] (a place of no Rajasthan district). "Jaipur Discom",
 * "DRM Jaipur", "Air India" are not places.
 */
export function placeDistricts(name: string, book: PlaceBook | null): string[] | null {
  const k = key(name);
  if (!k) return null;
  if (STATE_NAMES.has(k)) return [];
  const district = (districtCandidates ??= districtKeywordCandidates()).find((c) => key(c.latin) === k || c.keywords.some((w) => key(w) === k));
  if (district) return [district.keywords[0]!];
  const place = book?.hashtag(nfc(name)) ?? null;
  if (!place) return null;
  if (place.kind === "national") return [];
  return place.districts.map((d) => districtName(d.name));
}

/**
 * The districts whose places a handle may have as keywords: handleDistricts, except for a handle that is a subject's
 * own (an institution, a person: its name is in the handle string), which has none, as POST /handles/desk gives such
 * a handle its subject's names and not the district in it ("@RuhsJaipur" → RUHS, not Jaipur; "@JaipurDiscom1").
 */
export function handlePlaceDistricts(handle: string, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }): string[] {
  return handleOwnSubjectNames(handle, ctx.subjects).length ? [] : handleDistricts(handle, ctx.book);
}

/**
 * Whether a keyword is a place OUTSIDE the districts the handle may have places of (handlePlaceDistricts): the
 * pollution the learning fix stops and learn-cleanup removes. A handle with no district of its own (a person's, a
 * party's, a national one, an institution's) has every place outside. Not a place: false.
 */
export function placeOutsideHandle(handle: string, keyword: string, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }): boolean {
  const of = placeDistricts(keyword, ctx.book);
  if (of === null) return false;
  const own = new Set(handlePlaceDistricts(handle, ctx));
  return !of.some((d) => own.has(d));
}

/** handle_directory.entity_type values that make a handle known NOT local: it learns no place */
const NOT_LOCAL_TYPES = new Set(["person", "party", "organisation"]);

/**
 * Whether a handle is LOCAL: not known as a person's, party's, institution's or national handle. Known means an editor
 * typed it so (`type`: person, party, organisation), it is a subject's own handle (its name is in the handle string),
 * or it names a place outside Rajasthan ("@DelhiUpdates"). Party and data-file handles never learn anyway. A local
 * handle may learn the places of the stories the desk typed it on.
 */
export function handleIsLocal(handle: string, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }, type?: string | null): boolean {
  if (type && NOT_LOCAL_TYPES.has(type)) return false;
  if (handleOwnSubjectNames(handle, ctx.subjects).length) return false;
  const words = compactLatin(handle);
  return !(ctx.book?.nationals() ?? []).some((n) => compactLatin(n.name).length >= 4 && words.includes(compactLatin(n.name)));
}

/**
 * A story's own places: its stated district (Rajasthan) and its own town, the place-line town or else the town its
 * headline names inside that district ("चाकसू में हादसा", district Jaipur). Never a place from the rest of the body.
 * Each as the district it is of and the names to learn.
 */
function storyOwnPlaces(story: LearnStory, book: PlaceBook | null): { district: string; names: string[] }[] {
  const out: { district: string; names: string[] }[] = [];
  const district = story.district ? (placeDistricts(story.district, book) ?? [])[0] : undefined;
  if (district) out.push({ district, names: districtNames(district, book) });
  if (!book) return out;
  const asPlace = (p: Place | null): { district: string; names: string[] } | null => {
    if (!p || p.kind === "national") return null;
    const of = placeDistricts(p.hi, book) ?? [];
    const d = district ? of.find((x) => x === district) : of.length === 1 ? of[0] : undefined;
    if (!d) return null;
    return { district: d, names: p.kind === "town" ? [p.hi] : districtNames(d, book) };
  };
  const town = (story.town ? asPlace(book.lookup(story.town)) : null) ?? book.find(story.headline ?? "").map((m) => (m.entry.data.kind === "town" ? asPlace(m.entry.data) : null)).find((x) => x !== null) ?? null;
  if (town) out.push(town);
  return out;
}

/**
 * The names a desk handle learns from a story it was typed on (learning fix 3): the story's own places
 * (storyOwnPlaces: its district and its own town), when they are in the handle's own district (handlePlaceDistricts);
 * a local handle with no district in its string (handleIsLocal: "@ChaksuNews") takes them as they are, a person's,
 * party's, institution's or national handle never. And the subjects named in the story that are the handle's own (the
 * subject's name is in the handle string). Nothing else from the body.
 */
export function handleStoryNames(handle: string, story: LearnStory, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }, type?: string | null): string[] {
  const out: string[] = [];
  const own = new Set(handlePlaceDistricts(handle, ctx));
  const typedNotLocal = !!type && NOT_LOCAL_TYPES.has(type);
  const local = !own.size && handleIsLocal(handle, ctx, type);
  for (const p of !typedNotLocal && (own.size || local) ? storyOwnPlaces(story, ctx.book) : []) {
    if (local || own.has(p.district)) out.push(...p.names);
  }
  const ownSubject = new Set(handleOwnSubjectNames(handle, ctx.subjects).map(key));
  if (ownSubject.size) {
    const text = [story.headline ?? "", story.body ?? ""].join("\n").normalize("NFC");
    for (const m of ctx.subjects?.gazetteer.find(text) ?? []) {
      const names = m.entry.data.names.length ? m.entry.data.names : [m.entry.name, ...m.entry.aliases];
      if (names.some((n) => ownSubject.has(key(n)))) out.push(names.find((n) => !isHindi(n)) ?? "", names.find(isHindi) ?? "");
    }
  }
  return uniqueNames(out);
}

/**
 * Every name of the subjects that are the handle's own: a subject of subject-handles.json whose English name or
 * keyword is inside the handle string ("@JaipurDiscom1" → Jaipur Discom, जयपुर डिस्कॉम, JVVNL...). None for most handles.
 */
export function handleOwnSubjectNames(handle: string, subjects: SubjectRules | null): string[] {
  const candidates = subjects?.keywordCandidates ?? [];
  const found = candidates.length ? keywordsForHandle(handle, candidates.filter((c) => c.kind === "subject")) : [];
  if (!subjects || !found.length) return [];
  const whole = new Set(found.map((f) => fold(nfc(f))));
  const out = [...found];
  for (const m of subjects.gazetteer.find(found.join(" । "))) {
    if (!whole.has(m.matched)) continue;
    out.push(...(m.entry.data.names.length ? m.entry.data.names : [m.entry.name, ...m.entry.aliases]));
  }
  return uniqueNames(out);
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
 * The keywords inside a handle string that are added from the start: a subject's names when the handle has one,
 * otherwise the districts in it (deskHandleKeywords' rule without its withholds: "@JaipurDiscom1" → Jaipur Discom...,
 * never Jaipur, so a learned "Jaipur" cannot put it on every Jaipur story).
 */
export function ownHandleKeywords(handle: string, candidates: readonly KeywordCandidate[]): string[] {
  const matches = matchHandleKeywords(handle, candidates);
  const subjects = matches.filter((m) => m.kind === "subject");
  return uniqueNames((subjects.length ? subjects : matches).flatMap((m) => m.keywords), MAX_HANDLE_KEYWORDS);
}

/** What the worker reads behind a desk handle (db composer.ts deskHandleEvidence) */
export interface DeskHandleEvidence {
  /** The stories of the org's live posts on which the desk itself typed the handle (post_decisions desk_added) */
  stories: LearnStory[];
  /** Its record as a desk suggestion */
  suggest: SuggestStats;
  /** The stories of ALL the org's live posts carrying the handle (the count of before the fix: an editor's keywords) */
  postedStories?: LearnStory[];
  /**
   * The keywords the learning added (audit handle.keywords_learned after the row's last editor handle.update); absent,
   * every keyword counts as learned
   */
  learned?: string[];
}

/**
 * A desk row ready for deskHandleRules: its keywords' counts over the stories the desk typed it on, the keywords
 * found inside the handle string itself (added from the start), which of its keywords name a subject and no place
 * (the only learned ones that may be added on their own), its suggestion record, which keywords were learned (the
 * rest are an editor's and work at once) and their counts over all its posts. `evidence` may be the stories alone.
 */
export function withKeywordUses(row: DeskHandleRow, evidence: readonly LearnStory[] | DeskHandleEvidence, candidates: readonly KeywordCandidate[]): DeskHandleRow {
  const stories = "stories" in evidence ? evidence.stories : evidence;
  const places = new Set(candidates.filter((c) => c.kind === "district").flatMap((c) => [c.latin, ...c.keywords]).map(key));
  const subjectKeywords = new Set(candidates.filter((c) => c.kind === "subject").flatMap((c) => [c.latin, ...c.keywords]).map(key).filter((k) => !places.has(k)));
  const full = "stories" in evidence ? evidence : null;
  return {
    ...row,
    keywordUses: keywordPostedCounts(row.aliases, stories),
    handleKeywords: candidates.length ? ownHandleKeywords(row.handle, candidates) : [],
    subjectKeywords,
    ...(full && { suggestStats: full.suggest }),
    ...(full?.learned && { learnedKeywords: new Set(full.learned.map(key)) }),
    ...(full?.postedStories && { postedKeywordUses: keywordPostedCounts(row.aliases, full.postedStories) }),
  };
}

/** A stable string of which desk keywords are added on their own and which offered: the worker rebuilds its rules when it changes */
export function deskAutoKey(rows: readonly DeskHandleRow[]): string {
  return rows
    .map((r) => {
      const auto = r.aliases.filter((a) => deskKeywordAuto(r, a)).map(key).sort();
      const offered = r.aliases.filter((a) => !deskKeywordAuto(r, a) && deskKeywordOffered(r, a)).map(key).sort();
      return `${r.handle.toLowerCase()}=${auto.join("+")};${offered.join("+")};${suggestionRetired(r.suggestStats) ? "retired" : ""}`;
    })
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
 * A learned rule's keywords for a tag: a known district, place or subject's own names; otherwise only the tag's own
 * CamelCase words that are not places, and the names of a subject whose name is inside the tag. Never the places of
 * the story it went out on (learning fix 6). At most MAX_RULE_KEYWORDS; [] means the rule is saved inactive.
 */
export function tagRuleKeywords(tag: string, ctx: { book: PlaceBook | null; subjects: SubjectRules | null }): { keywords: string[]; known: boolean } {
  const known = knownTagNames(tag, ctx);
  if (known) return { keywords: known, known: true };
  const k = solidKey(tag);
  const subjects = (ctx.subjects?.keywordCandidates ?? []).filter((c) => {
    const name = compactLatin(c.latin);
    return name.length >= 5 && !!k && k.includes(name) && placeDistricts(c.latin, ctx.book) === null;
  });
  const words = tagWords(tag).filter((w) => placeDistricts(w, ctx.book) === null);
  return { keywords: uniqueNames([...words, ...subjects.flatMap((c) => c.keywords)], MAX_RULE_KEYWORDS), known: false };
}

/** The office a district handle names after the district: <District>Police, <District>DM, <District>Collector */
const DISTRICT_OFFICE_ENDINGS = ["police", "dm", "collector"];

/**
 * Whether a typed hashtag is really a handle written with a # ("#Balotrapolice" for @BalotraPolice): it is a known
 * handle's name (case, @ and underscores ignored), or a <District>Police / <District>DM / <District>Collector tag
 * for which such a handle exists ("#JaipurPolice" when @jaipur_police_rj is known). A topic tag that merely ends in
 * "police" is not one: #RajasthanPolice is a topic. Never learned as a rule.
 */
export function tagLooksLikeHandle(tag: string, knownHandles: Iterable<string> = []): boolean {
  const bare = nfc(tag).replace(/^#+/, "");
  if (!bare || isHindi(bare)) return false;
  const k = compactLatin(bare);
  if (!k) return false;
  const known = [...knownHandles].map(compactLatin).filter(Boolean);
  if (known.includes(k)) return true;
  const ending = DISTRICT_OFFICE_ENDINGS.find((e) => k.endsWith(e));
  if (!ending) return false;
  const place = k.slice(0, -ending.length);
  const isDistrict = (districtCandidates ??= districtKeywordCandidates()).some((c) => compactLatin(c.latin) === place);
  return isDistrict && known.some((h) => h.startsWith(k));
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

  /** The places file the learner reads */
  get book(): PlaceBook {
    return this.ctx.book;
  }

  storyNames(story: LearnStory): string[] {
    return storyNames(story, this.ctx);
  }

  /** The names this handle learns from a story the desk typed it on (handleStoryNames) */
  handleNames(handle: string, story: LearnStory, type?: string | null): string[] {
    return handleStoryNames(handle, story, this.ctx, type);
  }

  /**
   * What a desk handle learns from the stories the desk typed it on: nothing when the add rules withhold it
   * (handleWithheld), else every name handleStoryNames gives for those stories, each once. The ONE rule both the
   * learning (db learnFromPost, one story at a time) and learn-cleanup (re-run over the stories the audit names) use.
   */
  learnable(
    handle: string,
    stories: readonly LearnStory[],
    opts: { directory?: Iterable<string>; curated?: Iterable<string>; reporters?: Iterable<string>; type?: string | null } = {},
  ): { withheld: KeywordsWithheld | null; names: string[] } {
    const directory = [...(opts.directory ?? [])];
    const curated = [...(opts.curated ?? [])];
    // A reporter's handle (a directory row the desk taught as a reporter's) never learns, as one of the files' never does
    const self = handle.trim().replace(/^@+/, "").toLowerCase();
    if ([...(opts.reporters ?? [])].some((r) => r.trim().replace(/^@+/, "").toLowerCase() === self)) return { withheld: "file_handle", names: [] };
    const withheld = this.handleWithheld(handle, directory, curated);
    if (withheld) return { withheld, names: [] };
    return { withheld: null, names: uniqueNames(stories.flatMap((s) => handleStoryNames(handle, s, this.ctx, opts.type))) };
  }

  /** `protectedHandles`: the Settings-verified directory rows, never typos (nor are the files' handles) */
  handleWithheld(handle: string, directoryHandles: Iterable<string> = [], protectedHandles: Iterable<string> = []): KeywordsWithheld | null {
    return handleLearnWithheld(handle, { candidates: this.candidates, fileHandles: this.fileHandles, directoryHandles, protectedHandles });
  }

  /** The file or directory handle this one is a typo or stub of ("did you mean"), or null (handleTypoOf) */
  handleLookalike(handle: string, directoryHandles: Iterable<string> = [], protectedHandles: Iterable<string> = []): string | null {
    return handleLookalikeOf(handle, [...directoryHandles, ...this.fileHandles], [...this.fileHandles, ...protectedHandles]);
  }

  tagKeywords(tag: string): { keywords: string[]; known: boolean } {
    return tagRuleKeywords(tag, this.ctx);
  }

  /** Every name of the subjects that are the handle's own (handleOwnSubjectNames) */
  ownSubjectNames(handle: string): string[] {
    return handleOwnSubjectNames(handle, this.ctx.subjects);
  }

  /** Whether a keyword is a place outside the handle's own district (placeOutsideHandle) */
  placeOutside(handle: string, keyword: string): boolean {
    return placeOutsideHandle(handle, keyword, this.ctx);
  }

  /** Whether a tag names a known district, place or subject (knownTagNames) */
  tagKnown(tag: string): boolean {
    return knownTagNames(tag, this.ctx) !== null;
  }

  /**
   * Whether a typed tag is a handle written with a # (tagLooksLikeHandle), against the files' and the directory's
   * handles. A tag naming a known place or subject never is: "#NarendraModi" is a topic although @narendramodi exists.
   */
  tagIsHandle(tag: string, directoryHandles: Iterable<string> = []): boolean {
    return !this.tagKnown(tag) && tagLooksLikeHandle(tag, [...this.fileHandles, ...directoryHandles]);
  }
}
