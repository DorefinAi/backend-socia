// Handles the desk adds by typing them on a post's tag line (owner decision: no admin approval). Two pure parts:
//
// 1. keywordsForHandle(): which known names a new handle contains, so it can be suggested later. A keyword is a
//    district (English and Hindi), or an English name/keyword from subject-handles.json with its Hindi spellings,
//    found inside the handle: @JhalawarPolice → Jhalawar, झालावाड़; @CP_Jodhpur → Jodhpur, जोधपुर.
// 2. deskHandleRules() / pickHandles(): a desk-added handle with keywords is suggested on a story whose headline or
//    points name one of them as a whole word (Hindi or English), after the file rules and within their cap.
//
// Matching a keyword inside a handle (Latin only: handles are \w):
//   - the handle loses its @ and is split on digits into pieces ("Jaipur1stIndia" → "jaipur", "stindia"); a piece
//     is its words (CamelCase and underscores split them) joined and lowercased, so a keyword may run across words
//     ("SawaiMadhopurPolice" holds "sawaimadhopur"; "CP_Jodhpur" → "cpjodhpur"), and the word edges are kept;
//   - a keyword (lowercase, letters and digits only) is found exactly anywhere in a piece when it has
//     ANYWHERE_LENGTH (6) letters or more; a shorter one must start or end on a word edge or the handle's edge
//     ("@sp_kota", "@uniofkota", "@RPSC_Ajmer"), so "NHAI" is not in "@OnlineKanhaiya" nor "Pali" in "@spalika";
//   - a long keyword (LONG_KEYWORD_LENGTH, 9 letters, or more) may also be near: every window of the piece of its
//     length ±1 that starts on a word edge is scored by Jaro-Winkler, and ≥ 0.95 is a match. That forgives about
//     one wrong, missing, extra or swapped letter in Sawai Madhopur, Chittorgarh or Hanumangarh when the first
//     letters are right. Not 1 - edits / length: at 95% that allows no typo below 20 letters, and no Rajasthan
//     district is that long. A shorter keyword must be exact: Jaro-Winkler alone finds "Dholpur" in
//     "SawaiMadhopur" (dhopur, 0.967), and the word-edge start keeps "CEO Rajasthan" out of "@PoliceRajasthan";
//   - keywords shorter than MIN_KEYWORD_LENGTH (4) letters are never looked for: "PMO", "MHA", "JDA" turn up inside
//     unrelated handles, and three letters are too few to judge.
// Towns are not candidates: the places file has their Hindi names only, and a handle is Latin.

import { fold } from "../fold";
import { Gazetteer, type GazetteerEntry } from "../gazetteer";
import { RAJASTHAN_DISTRICTS } from "../rajasthan";
import type { SubjectHandleEntry } from "./subjects";
import { DISTRICT_MATCHED_TYPES, isSettingsHandleType, type SettingsHandleType } from "./handle-types";

/** A Latin name looked for inside handles, and the keywords a handle gets when it is found (display first) */
export interface KeywordCandidate {
  /** A district's name, or a subject's (person, department, institution, company) */
  kind: "district" | "subject";
  /** "Sawai Madhopur" */
  latin: string;
  /** ["Sawai Madhopur", "सवाई माधोपुर"]: English first, then Hindi */
  keywords: string[];
}

export const MIN_KEYWORD_LENGTH = 4;
/** From this many letters a keyword may sit anywhere in the handle; a shorter one must touch a word edge */
export const ANYWHERE_LENGTH = 6;
/** Below this many letters a keyword must appear exactly; from it on, one typo can pass */
export const LONG_KEYWORD_LENGTH = 9;
export const HANDLE_KEYWORD_SIMILARITY = 0.95;
/** The handle_directory aliases column takes at most this many (the library API's limit) */
export const MAX_HANDLE_KEYWORDS = 30;

const DEVANAGARI = /[ऀ-ॿ]/;
const isHindi = (s: string) => DEVANAGARI.test(s);
/** Lowercase letters and digits only: "Sawai Madhopur" → "sawaimadhopur" */
export const compactLatin = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A run of the handle between digits: its words joined, lowercase, and where each word starts and ends */
export interface HandlePiece {
  text: string;
  edges: ReadonlySet<number>;
}

/** "@CP_Jodhpur" → [{ text: "cpjodhpur", edges: {0, 2, 9} }]; "@Jaipur1stIndia" → "jaipur", "stindia" */
export function handlePieces(handle: string): HandlePiece[] {
  return handle
    .trim()
    .replace(/^@+/, "")
    .split(/[0-9]+/)
    .map((part) => {
      // "SPJhalawarCity" → SP, Jhalawar, City; underscores fall between matches
      const words = part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? [];
      let text = "";
      const edges = new Set<number>([0]);
      for (const w of words) {
        text += w.toLowerCase();
        edges.add(text.length);
      }
      return { text, edges };
    })
    .filter((p) => p.text);
}

/** Jaro-Winkler similarity of two strings, 0..1 (prefix scale 0.1, up to 4 letters) */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let halfSwaps = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) halfSwaps++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - halfSwaps / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** How well `keyword` (compact) is in the piece: 1 found, a Jaro-Winkler score for a long keyword's near miss, else 0 */
export function keywordInPiece(keyword: string, piece: HandlePiece): number {
  const { text, edges } = piece;
  for (let i = text.indexOf(keyword); i !== -1; i = text.indexOf(keyword, i + 1)) {
    if (keyword.length >= ANYWHERE_LENGTH || edges.has(i) || edges.has(i + keyword.length)) return 1;
  }
  if (keyword.length < LONG_KEYWORD_LENGTH) return 0;
  let best = 0;
  for (const start of edges) {
    for (let len = keyword.length - 1; len <= keyword.length + 1; len++) {
      if (start + len > text.length) break;
      best = Math.max(best, jaroWinkler(keyword, text.slice(start, start + len)));
    }
  }
  return best;
}

/** Rajasthan's districts, each Latin spelling a candidate that brings the district's English and Hindi names */
export function districtKeywordCandidates(): KeywordCandidate[] {
  const out: KeywordCandidate[] = [];
  for (const d of RAJASTHAN_DISTRICTS) {
    const hindi = [d.hi, ...d.aliases.filter(isHindi)];
    for (const latin of [d.name, ...d.aliases.filter((a) => !isHindi(a))]) {
      out.push({ kind: "district", latin, keywords: [d.name, ...(latin === d.name ? [] : [latin]), ...hindi] });
    }
  }
  return out;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.normalize("NFC").trim()) : []);

/**
 * The English names and keywords of subject-handles.json as candidates: a matched name brings the entry's Hindi
 * names, a matched keyword its Hindi keywords. Only verified, non-party entries: an unverified entry's names are
 * not checked, and no party is ever tagged. A file that is not the right shape gives none.
 */
export function subjectKeywordCandidates(json: unknown): KeywordCandidate[] {
  const entries = (json as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  const out: KeywordCandidate[] = [];
  for (const raw of entries) {
    const e = raw as Partial<SubjectHandleEntry> | null;
    if (!e || typeof e !== "object" || e.kind === "party" || e.verified !== true) continue;
    for (const [en, hi] of [[strings(e.names_en), strings(e.names_hi)], [strings(e.keywords_en), strings(e.keywords_hi)]] as const) {
      for (const latin of en) out.push({ kind: "subject", latin, keywords: [latin, ...hi] });
    }
  }
  return out;
}

export interface HandleKeywordMatch {
  kind: KeywordCandidate["kind"];
  latin: string;
  similarity: number;
  keywords: string[];
}

/** Every candidate found in the handle, best first (similarity, then the longer name) */
export function matchHandleKeywords(handle: string, candidates: readonly KeywordCandidate[], threshold = HANDLE_KEYWORD_SIMILARITY): HandleKeywordMatch[] {
  const pieces = handlePieces(handle);
  const found: HandleKeywordMatch[] = [];
  for (const c of candidates) {
    const keyword = compactLatin(c.latin);
    if (keyword.length < MIN_KEYWORD_LENGTH) continue;
    let similarity = 0;
    for (const piece of pieces) similarity = Math.max(similarity, keywordInPiece(keyword, piece));
    if (similarity >= threshold) found.push({ kind: c.kind, latin: c.latin, similarity, keywords: c.keywords });
  }
  return found.sort((a, b) => b.similarity - a.similarity || compactLatin(b.latin).length - compactLatin(a.latin).length);
}

/**
 * The keywords of every candidate found inside the handle, best match first, each once (case and spelling
 * variants folded), at most MAX_HANDLE_KEYWORDS. The raw matcher: deskHandleKeywords() adds the safety rules.
 */
export function keywordsForHandle(handle: string, candidates: readonly KeywordCandidate[], threshold = HANDLE_KEYWORD_SIMILARITY): string[] {
  return flatten(matchHandleKeywords(handle, candidates, threshold));
}

function flatten(matches: readonly HandleKeywordMatch[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    for (const k of m.keywords) {
      const key = k.normalize("NFC").toLowerCase();
      if (seen.has(key) || out.length >= MAX_HANDLE_KEYWORDS) continue;
      seen.add(key);
      out.push(k.normalize("NFC"));
    }
  }
  return out;
}

// ─── Safety: which handles never get keywords ───────────────────────────────
//
// Keywords make a handle auto-suggested, so a desk-added handle gets none (it is still added, and can be tagged by
// hand) when it is:
//   - a handle of district-handles.json or subject-handles.json, verified or not, or a lookalike of one
//     (at most 2 edits, a swap counting as one, or Jaro-Winkler ≥ 0.95): the files decide when those are tagged ("police only when acting",
//     unverified = never), and a near copy of an official handle is how impersonation works;
//   - a party's (BJP, INC, Congress, AAP, RLP, BSP, CPI, BAP...): no party handles;
//   - an official's (Police, SP, CP, DM, Collector, IG, DIG, Thana, SHO, DCDM...): officials are the files' job.
// A marker counts as a word of the handle (split on CamelCase, underscores and digits) or as what is left of it
// once the matched names are taken out ("spjhalawar" → "sp"); a few long, unambiguous ones count anywhere
// ("jhalawarpolice", "bjpjaipur").

const PARTY_WORDS = new Set(["bjp", "inc", "congress", "aap", "rlp", "bsp", "cpi", "cpim", "cpm", "bap", "bjym", "nsui", "abvp", "iyc", "jjp", "samajwadi"]);
const PARTY_ANYWHERE = ["bjp", "congress", "samajwadi"];
const OFFICIAL_WORDS = new Set([
  "police", "sp", "asp", "dsp", "ssp", "cp", "dcp", "acp", "dm", "adm", "sdm", "dc", "dcdm", "dmdc", "collector", "collectorate", "ig", "igp", "dig",
  "dgp", "thana", "sho", "ps", "ips", "ias", "commissioner", "kotwali",
]);
const OFFICIAL_ANYWHERE = ["police", "collector", "thana"];
export const LOOKALIKE_SIMILARITY = 0.95;
export const LOOKALIKE_EDITS = 2;

const bareLower = (h: string) => h.trim().replace(/^@+/, "").toLowerCase();

/** Edits between two strings: insert, delete, substitute, or swap two neighbours */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** The file handle this handle is or looks like (case and @ ignored), lowercase; null when none */
export function fileLookalike(handle: string, fileHandles: Iterable<string>): string | null {
  const h = bareLower(handle);
  for (const raw of fileHandles) {
    const f = bareLower(raw);
    if (h === f || jaroWinkler(h, f) >= LOOKALIKE_SIMILARITY || editDistance(h, f) <= LOOKALIKE_EDITS) return f;
  }
  return null;
}

/** Whether the handle carries a party's or an official's marker; `names` are the compact names found in it */
export function handleMarkers(handle: string, names: readonly string[] = []): { party: boolean; official: boolean } {
  const pieces = handlePieces(handle);
  const words = new Set<string>();
  const longestFirst = [...names].filter(Boolean).sort((x, y) => y.length - x.length);
  for (const { text, edges } of pieces) {
    const cuts = [...edges].sort((x, y) => x - y);
    for (let i = 1; i < cuts.length; i++) words.add(text.slice(cuts[i - 1], cuts[i]));
    let rest = text;
    for (const n of longestFirst) rest = rest.split(n).join(" ");
    for (const w of rest.split(" ")) if (w) words.add(w);
  }
  const joined = pieces.map((p) => p.text).join(" ");
  return {
    party: [...words].some((w) => PARTY_WORDS.has(w)) || PARTY_ANYWHERE.some((m) => joined.includes(m)),
    official: [...words].some((w) => OFFICIAL_WORDS.has(w)) || OFFICIAL_ANYWHERE.some((m) => joined.includes(m)),
  };
}

/** Why a handle got no keywords although names may be in it */
export type KeywordsWithheld = "file_handle" | "lookalike" | "party" | "official";

export interface DeskKeywordContext {
  candidates: readonly KeywordCandidate[];
  /** Every handle of both data files, verified or not */
  fileHandles: Iterable<string>;
}

/**
 * The keywords a handle the desk adds gets, under the safety rules above (`withheld` says which one held them
 * back). A handle with a subject's or institution's name gets that, not also the district in it: "@RuhsJaipur"
 * → RUHS, not Jaipur.
 */
export function deskHandleKeywords(handle: string, ctx: DeskKeywordContext): { keywords: string[]; withheld: KeywordsWithheld | null } {
  const like = fileLookalike(handle, ctx.fileHandles);
  if (like !== null) return { keywords: [], withheld: like === bareLower(handle) ? "file_handle" : "lookalike" };
  const matches = matchHandleKeywords(handle, ctx.candidates);
  const markers = handleMarkers(handle, matches.filter((m) => m.similarity === 1).map((m) => compactLatin(m.latin)));
  if (markers.party) return { keywords: [], withheld: "party" };
  if (markers.official) return { keywords: [], withheld: "official" };
  const subjects = matches.filter((m) => m.kind === "subject");
  return { keywords: flatten(subjects.length ? subjects : matches), withheld: null };
}

// ─── Suggesting desk-added handles ──────────────────────────────────────────

/** A desk-added handle_directory row, as the worker reads it */
export interface DeskHandleRow {
  /** With or without the @ */
  handle: string;
  entityName: string;
  aliases: string[];
  /**
   * Learned keywords (learn.ts): for each keyword (keyed by fold()), how many posted stories carrying the handle name
   * it. Given, a keyword is OFFERED only until DESK_LEARNED_POSTED_USES of them do (a keyword in `handleKeywords`
   * excepted); absent (a row read without its posts), every keyword is added on its own, as before.
   */
  keywordUses?: ReadonlyMap<string, number>;
  /** The keywords found inside the handle string itself (keywordsForHandle): added on their own from the start */
  handleKeywords?: readonly string[];
  /**
   * The row's keywords (fold() form) that name a subject of subject-handles.json and no place: the only learned
   * keywords that may ever be added on their own. A place (district, town, national place) a handle learned stays
   * offered only, unless it is in `handleKeywords` (learning fix, 25 Nov 2026: @jpr_rural was put on every Jaipur story).
   */
  subjectKeywords?: ReadonlySet<string>;
  /** How often the desk was offered this handle as a suggestion (post_decisions, source "desk") and took it */
  suggestStats?: SuggestStats;
  /**
   * The row's keywords (fold() form) the LEARNING added (audit handle.keywords_learned with no editor handle.update
   * since): only these wait for desk-typed evidence. Every other keyword was typed by an editor in Settings (or given
   * at the desk add) and works at once, as before the learning fix. Absent: every keyword counts as learned.
   */
  learnedKeywords?: ReadonlySet<string>;
  /**
   * For each keyword (fold()), how many stories of ALL the org's live posts carrying the handle name it (the count of
   * before the learning fix): what an editor's keyword leaves suggest-only on. Absent: keywordUses.
   */
  postedKeywordUses?: ReadonlyMap<string, number>;
}

/** A handle's suggestion record: offered (accepted + ignored) and accepted */
export interface SuggestStats {
  offered: number;
  accepted: number;
}

/**
 * A learned desk keyword is OFFERED once this many posted stories on which the desk itself typed the handle name it
 * (as SETTINGS_POSTED_USES); before that it is not used at all (learning fix 4).
 */
export const DESK_LEARNED_POSTED_USES = 2;
/** A learned keyword that names a subject (never a place) is ADDED on its own from this many such stories */
export const DESK_LEARNED_AUTO_USES = 3;
/** A desk handle offered this many times... */
export const SUGGEST_RETIRE_OFFERS = 20;
/** ...and taken by the desk on fewer than this share of them is no longer offered (@hbh: 0 of 123) */
export const SUGGEST_RETIRE_RATE = 0.05;

const foldKey = (s: string) => fold(s.normalize("NFC"));
const inHandle = (row: Pick<DeskHandleRow, "handleKeywords">, k: string) => !!row.handleKeywords?.some((h) => foldKey(h) === k);
const learnedKeyword = (row: Pick<DeskHandleRow, "learnedKeywords">, k: string) => !row.learnedKeywords || row.learnedKeywords.has(k);

/**
 * Whether a desk row's keyword is added on its own (true) or at most offered (deskHandleRules' rule, see DeskHandleRow).
 * A row read without its posts (no keywordUses) keeps the old rule: every keyword is added. Otherwise a keyword inside
 * the handle string is added from the start; an editor's keyword (not learned) after DESK_LEARNED_POSTED_USES posted
 * stories name it, as before the learning fix; a learned one only if it names a subject (never a place) and
 * DESK_LEARNED_AUTO_USES desk-typed stories name it.
 */
export function deskKeywordAuto(row: Pick<DeskHandleRow, "keywordUses" | "handleKeywords" | "subjectKeywords" | "learnedKeywords" | "postedKeywordUses">, keyword: string): boolean {
  if (!row.keywordUses) return true;
  const k = foldKey(keyword);
  if (inHandle(row, k)) return true;
  if (!learnedKeyword(row, k)) return ((row.postedKeywordUses ?? row.keywordUses).get(k) ?? 0) >= DESK_LEARNED_POSTED_USES;
  if (!row.subjectKeywords?.has(k)) return false;
  return (row.keywordUses.get(k) ?? 0) >= DESK_LEARNED_AUTO_USES;
}

/**
 * Whether a desk row's keyword is used at all (added or offered): inside the handle, an editor's keyword (at once), or a
 * learned one on DESK_LEARNED_POSTED_USES desk-typed stories
 */
export function deskKeywordOffered(row: Pick<DeskHandleRow, "keywordUses" | "handleKeywords" | "learnedKeywords">, keyword: string): boolean {
  if (!row.keywordUses) return true;
  const k = foldKey(keyword);
  return inHandle(row, k) || !learnedKeyword(row, k) || (row.keywordUses.get(k) ?? 0) >= DESK_LEARNED_POSTED_USES;
}

/** A handle the desk has been offered SUGGEST_RETIRE_OFFERS times and took on under SUGGEST_RETIRE_RATE of them: offered no more */
export function suggestionRetired(stats: SuggestStats | null | undefined): boolean {
  return !!stats && stats.offered >= SUGGEST_RETIRE_OFFERS && stats.accepted < stats.offered * SUGGEST_RETIRE_RATE;
}

/** Shortest handle that counts as a strict prefix of a longer one ("@nwr" of "@NWRailways", "@forest" of "@forestRajasthan") */
export const LOOKALIKE_PREFIX_LETTERS = 3;
/** ...and the longer one has at least this many letters more ("@JhalawarPolic" is not a stub of "@jhalawarpolice") */
export const LOOKALIKE_PREFIX_EXTRA = 4;
/** Both handles at least this long for one edit to count as a typo (Khirthalpolice ~ khairthalpolice) */
export const TYPO_EDIT_MIN_LETTERS = 8;

const bareLow = (h: string) => h.trim().replace(/^@+/, "").toLowerCase();

/** Whether handle `a` is a stub of handle `b`: a strict prefix (case and @ ignored), 3 letters or more, `b` 4 or more longer */
export function strictHandlePrefix(a: string, b: string): boolean {
  const x = bareLow(a);
  const y = bareLow(b);
  return x.length >= LOOKALIKE_PREFIX_LETTERS && y.length >= x.length + LOOKALIKE_PREFIX_EXTRA && y.startsWith(x);
}

/** A handle lower-cased without "_" and trailing digits: "jaipur_police" = "jaipurpolice", "avinashgehlot_" = "avinashgehlot" */
const squashHandle = (h: string) => bareLow(h).replace(/_/g, "").replace(/[0-9]+$/, "");

/**
 * The known handle (as written there, bare) this one is a typo or stub of, or null. Only (a) a stub: a strict prefix of
 * it (strictHandlePrefix: "@forest" of "@forestRajasthan", "@nwr" of "@NWRailways"); (b) the same once lower-cased
 * without "_" and trailing digits ("@jaipurpolice" ~ "@jaipur_police"); (c) one edit away when both have 8 letters or
 * more ("@Khirthalpolice" ~ "@khairthalpolice"). Different real handles that merely look alike (@INCRajasthan and
 * @secrajasthan, @BJP4Rajasthan and @bjprajasthan) are not. A handle in `protectedHandles` (the data files', the
 * Settings-verified directory's) is never a typo of anything.
 */
export function handleTypoOf(handle: string, known: Iterable<string>, protectedHandles: Iterable<string> = []): string | null {
  const self = bareLow(handle);
  if (!self || new Set([...protectedHandles].map(bareLow)).has(self)) return null;
  const others = [...new Set([...known].map((h) => h.trim().replace(/^@+/, "")))].filter((o) => o && o.toLowerCase() !== self);
  const squashed = squashHandle(self);
  return (
    others.find((o) => strictHandlePrefix(self, o)) ??
    others.find((o) => !!squashed && squashHandle(o) === squashed) ??
    others.find((o) => self.length >= TYPO_EDIT_MIN_LETTERS && o.length >= TYPO_EDIT_MIN_LETTERS && editDistance(self, o.toLowerCase()) === 1) ??
    null
  );
}

export interface DeskHandleData {
  /** Handle without the @ */
  handle: string;
  title: string;
  /** A desk row matched on a learned keyword that is not yet added on its own: offered, never put on the post */
  suggestOnly?: boolean;
  /** A Settings row (directoryHandleRules): its type, and whether it is still suggest-only. Absent: a desk-added row */
  settings?: { type: SettingsHandleType; suggestOnly: boolean };
}

export interface DeskHandleRules {
  gazetteer: Gazetteer<DeskHandleData>;
  count: number;
  /** The gazetteer's entries (directoryHandleRules builds on deskHandleRules' list) */
  entries?: readonly GazetteerEntry<DeskHandleData>[];
  /** Settings police, collector and admin rows by the district they are matched on (districtKey form) */
  byDistrict?: ReadonlyMap<string, readonly DeskHandleData[]>;
}

export const EMPTY_DESK_HANDLE_RULES: DeskHandleRules = { gazetteer: new Gazetteer<DeskHandleData>([]), count: 0 };

/**
 * Desk-added handles ready to match. Left out, so never suggested: a row with no keywords, and (should its
 * keywords have been set some other way) a party's or an official's handle. pickHandles() also skips the files'
 * handles and their lookalikes. A row's keywords that are added on their own (deskKeywordAuto) and the ones only
 * offered (deskKeywordOffered: learned, on DESK_LEARNED_POSTED_USES desk-typed stories, and not added) are two
 * entries; a learned keyword on fewer such stories is not used at all. Also left out: a row whose handle is a strict
 * prefix of another desk row's (a stub or typo of it), and the offered entry of a handle the desk keeps ignoring
 * (suggestionRetired).
 */
export function deskHandleRules(rows: readonly DeskHandleRow[]): DeskHandleRules {
  const entries = rows.flatMap((r, i): GazetteerEntry<DeskHandleData>[] => {
    const handle = r.handle.trim().replace(/^@+/, "");
    const keywords = r.aliases.map((a) => a.normalize("NFC").trim()).filter(Boolean);
    if (!handle || !keywords.length) return [];
    const markers = handleMarkers(handle, keywords.map(compactLatin));
    if (markers.party || markers.official) return [];
    // A typo or stub of another desk handle ("@forest" next to "@forestRajasthan") is never used: the full handle is
    if (rows.some((o) => o !== r && strictHandlePrefix(handle, o.handle))) return [];
    const retired = suggestionRetired(r.suggestStats);
    const title = r.entityName || handle;
    const out: GazetteerEntry<DeskHandleData>[] = [];
    for (const suggestOnly of [false, true]) {
      // Offered only: not added on its own, used at all (enough desk-typed stories), and the desk still takes the handle
      if (suggestOnly && retired) continue;
      const own = keywords.filter((k) => (suggestOnly ? !deskKeywordAuto(r, k) && deskKeywordOffered(r, k) : deskKeywordAuto(r, k)));
      if (!own.length) continue;
      const [name, ...aliases] = own;
      out.push({ id: `desk:${handle.toLowerCase()}#${i}${suggestOnly ? ":suggest" : ""}`, name: name!, aliases, priority: 0, data: { handle, title, ...(suggestOnly && { suggestOnly }) } });
    }
    return out;
  });
  return { gazetteer: new Gazetteer(entries), count: entries.length, entries };
}

// ─── Settings handles (handle fixes F1, 14 Nov 2026) ────────────────────────
//
// Handles added in Settings (handle_directory source "manual") or promoted from Wikidata staging ("wikidata:Q…").
// @JaipurMetro was tagged on 0 of the 738 posts that lead with #Jaipur, so a Settings handle is never matched on the
// names hidden inside its handle string, and never on a district unless it is the district's own office:
//   - every row has one of the owner's six types (handle-types.ts SETTINGS_HANDLE_TYPES; an untyped row reads as
//     "organisation", as migration 0029 sets the old ones);
//   - organisation, person and party rows match ONLY on their own names, whole words: entity_name, entity_name_hi
//     and the keywords the editor entered (aliases). "मेट्रो", "Metro", "जयपुर मेट्रो" for @JaipurMetro;
//   - police, collector and admin rows also match by district: the story's stated district is one the handle or one
//     of its names is (@JhalawarPolice, or a keyword "झालावाड़");
//   - a row is SUGGEST-ONLY until the desk has posted it on SETTINGS_POSTED_USES posts (the worker counts published
//     posts carrying the @handle); after that it follows the desk rows' rule (pickHandles);
//   - a handle of the data files or a lookalike of one is still never matched (the files decide those).

/** A verified Settings row, as the worker reads it */
export interface DirectoryHandleRow extends DeskHandleRow {
  entityNameHi: string | null;
  /** handle_directory.entity_type; null (a row from before 0029) reads as "organisation" */
  type?: SettingsHandleType | null;
  /** Published posts of the org that carry this @handle; absent: 0 */
  postedUses?: number;
}

/** A name shorter than this many letters is never matched as a handle's own name ("CM", "SP") */
export const MIN_DIRECTORY_NAME_LETTERS = 3;
/** A Settings handle is suggested only, never put on the post, until the desk has posted it this many times */
export const SETTINGS_POSTED_USES = 2;
/** Letters with their vowel signs ("बूंदी" is 5, "CM" 2) */
const letters = (s: string) => (s.match(/[\p{L}\p{M}\p{N}]/gu) ?? []).length;

/** Whether a keyword or name is long enough to be matched (the API refuses a row with none for the keyword types) */
export const usableHandleName = (s: string): boolean => letters(s.normalize("NFC").trim()) >= MIN_DIRECTORY_NAME_LETTERS;

/** The row's type; an untyped row is an organisation */
export const directoryRowType = (row: Pick<DirectoryHandleRow, "type">): SettingsHandleType => (isSettingsHandleType(row.type) ? row.type : "organisation");

/**
 * The names a Settings handle is matched on: its own names only (entity_name, entity_name_hi, the keywords), each
 * once, at most MAX_HANDLE_KEYWORDS; [] (never matched) for a data-file handle or a lookalike of one. Nothing is
 * taken from inside the handle string.
 */
export function directoryHandleNames(row: DirectoryHandleRow, ctx: Pick<DeskKeywordContext, "fileHandles">): string[] {
  if (fileLookalike(row.handle, ctx.fileHandles) !== null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [row.entityName, row.entityNameHi ?? "", ...row.aliases]) {
    const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (!usableHandleName(name) || seen.has(key) || out.length >= MAX_HANDLE_KEYWORDS) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * The districts (districtKey form: "sawaimadhopur") a police, collector or admin Settings row is matched by: a
 * district found in the handle ("@JhalawarPolice") or one of its names that is a district's name ("झालावाड़").
 * Every other type: none. A data-file handle or a lookalike: none.
 */
export function directoryHandleDistricts(row: DirectoryHandleRow, ctx: Pick<DeskKeywordContext, "fileHandles">): string[] {
  if (!DISTRICT_MATCHED_TYPES.has(directoryRowType(row)) || fileLookalike(row.handle, ctx.fileHandles) !== null) return [];
  const keys = new Set<string>();
  const key = (s: string) => compactLatin(s);
  for (const m of matchHandleKeywords(row.handle, DISTRICT_CANDIDATES_GET())) keys.add(key(m.keywords[0]!));
  const names = new Set([row.entityName, row.entityNameHi ?? "", ...row.aliases].map((n) => n.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean));
  for (const c of DISTRICT_CANDIDATES_GET()) {
    if (c.keywords.some((k) => names.has(k.normalize("NFC").toLowerCase()))) keys.add(key(c.keywords[0]!));
  }
  return [...keys];
}

let districtCandidatesCache: KeywordCandidate[] | null = null;
/** districtKeywordCandidates(), built once */
const DISTRICT_CANDIDATES_GET = () => (districtCandidatesCache ??= districtKeywordCandidates());

/**
 * The desk-added rows (their stored keywords, under deskHandleRules' safety rules, unchanged) and the Settings rows
 * (their own names; police, collector and admin also by district) as one rule set for pickHandles. A handle in both
 * has an entry for each; pickHandles keeps one pick per handle, the desk row's rule first.
 */
export function directoryHandleRules(deskRows: readonly DeskHandleRow[], settingsRows: readonly DirectoryHandleRow[], ctx: Pick<DeskKeywordContext, "fileHandles">): DeskHandleRules {
  const desk = deskHandleRules(deskRows);
  const entries = [...(desk.entries ?? [])];
  const byDistrict = new Map<string, DeskHandleData[]>();
  settingsRows.forEach((r, i) => {
    const handle = r.handle.trim().replace(/^@+/, "");
    if (!handle) return;
    const type = directoryRowType(r);
    const data: DeskHandleData = { handle, title: r.entityName || handle, settings: { type, suggestOnly: (r.postedUses ?? 0) < SETTINGS_POSTED_USES } };
    const names = directoryHandleNames(r, ctx);
    if (names.length) {
      const [name, ...aliases] = names;
      entries.push({ id: `settings:${handle.toLowerCase()}#${i}`, name: name!, aliases, priority: 0, data });
    }
    for (const d of directoryHandleDistricts(r, ctx)) byDistrict.set(d, [...(byDistrict.get(d) ?? []), data]);
  });
  const count = entries.length + [...byDistrict.values()].reduce((n, l) => n + l.length, 0);
  return { gazetteer: new Gazetteer(entries), entries, byDistrict, count };
}
