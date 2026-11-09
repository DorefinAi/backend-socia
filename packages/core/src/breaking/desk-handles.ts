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

import { Gazetteer } from "../gazetteer";
import { RAJASTHAN_DISTRICTS } from "../rajasthan";
import type { SubjectHandleEntry } from "./subjects";

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
}

export interface DeskHandleData {
  /** Handle without the @ */
  handle: string;
  title: string;
}

export interface DeskHandleRules {
  gazetteer: Gazetteer<DeskHandleData>;
  count: number;
}

export const EMPTY_DESK_HANDLE_RULES: DeskHandleRules = { gazetteer: new Gazetteer<DeskHandleData>([]), count: 0 };

/**
 * Desk-added handles ready to match. Left out, so never suggested: a row with no keywords, and (should its
 * keywords have been set some other way) a party's or an official's handle. pickHandles() also skips the files'
 * handles and their lookalikes.
 */
export function deskHandleRules(rows: readonly DeskHandleRow[]): DeskHandleRules {
  const entries = rows.flatMap((r, i) => {
    const handle = r.handle.trim().replace(/^@+/, "");
    const keywords = r.aliases.map((a) => a.normalize("NFC").trim()).filter(Boolean);
    if (!handle || !keywords.length) return [];
    const markers = handleMarkers(handle, keywords.map(compactLatin));
    if (markers.party || markers.official) return [];
    const [name, ...aliases] = keywords;
    return [{ id: `desk:${handle.toLowerCase()}#${i}`, name: name!, aliases, priority: 0, data: { handle, title: r.entityName || handle } }];
  });
  return { gazetteer: new Gazetteer(entries), count: entries.length };
}
