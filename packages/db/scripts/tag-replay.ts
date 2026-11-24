// Tag replay: a read-only back-test of the breaking composer, run before a rule change goes live.
//
// Every posted breaking story in a JSON export is parsed, classified and composed again with the code and data files
// of the worktree this script runs from, fed the org's learning snapshots (topic hashtag rules, handle directory) the
// way apps/worker/src/stages/compose.ts loads them. Each draft is scored against what really went out: the X post
// where one matches (x-audit's body-aware matcher), else the text the desk posted. No database is opened: every
// input is a file, and the only files written are the ones named by --out, --csv and --report.
//
//   node --import tsx packages/db/scripts/tag-replay.ts --data <export dir> --x <x export.json> \
//     [--frontend <frontend root or cardWords.ts>] [--out run.json] [--baseline base.json --csv changes.csv] [--report run.txt]
//
// Inputs (snake_case rows, as the read-only exports write them):
//   --golden     posted stories: file_name, source_text, created_at, posted, published_at (also district, town...)
//   --decisions  post_decisions rows: file_name, decision, decided_at, final_text, item_outcomes (live outcomes, shown
//                beside the replay; the posted text falls back to final_text)
//   --rules      hashtag_rules rows (the worker keeps the active "entity" rules as the topic gazetteer)
//   --handles    handle_directory rows (verified X rows: desk, Settings, learned reporter tokens)
//   --cases      hand-picked stories (same shape as --golden) listed one by one in the report
//   --data <dir> takes golden*.json, decisions*.json, hashtag_rules.json, handle_directory.json and
//                screenshot-cases.json from one folder when the flags are not given
//   --truth posted  score against the posted text only (no X), like the "live" column; default x
//   The staging tables (hashtag_staging, handle_directory_staging) are not read: the worker's compose never reads them.
//   The learning snapshot is applied to every story (taken at export time, not as it stood when each story came in),
//   and a desk handle's learned-keyword counts come from the posts in --golden: compare runs on the same inputs.
//
// Gates (exit code 1 when one fails; G7 is reported only):
//   G0  every story re-composes (a compose error is a regression, never a skip)
//   G1  (with --baseline) no source's removed count rises, and no item the desk kept is lost
//   G2  no #Jaipur / "Jaipur:" (line 1, tags or card) on a story whose text names Delhi, another state or a foreign
//       country and no Jaipur place; no district.city.fallback; every emitted #Jaipur has a non-fallback source
//   G3  no story where the reporter's file-code district beats a different Rajasthan district opening line 1
//   G4  the card heading equals caption line 1 with the tags' "#" removed, on every story
//   G5  no draft over 280 weighted characters (twitter-text: Devanagari 1, other scripts 2, URLs 23)
//   G7  line-1 place = truth, city tags = truth, exact match to X / to the posted text
//
// The card heading: the backend's own field when the draft has one (headingPlace.cardHeadline or cardHeadline), else
// the frontend's draftCardHeadline (frontend/src/components/Newsroom/BreakingDesk/cardWords.ts) imported from
// --frontend, by default the frontend checkout beside this repository.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LEADER_POST, PlaceBook, assemblePostText, composeBreaking, directoryHandleRules, districtKeywordCandidates, hashtagGazetteer, isSettingsHandleType,
  mergeReporterTokens, nationalWithoutPlace, openingPlaceLength, parseBreaking, parseDistricts, pickReporter, placeOfTag, slotFromTags, tagPlace,
  withKeywordUses,
  type BeatRules, type BreakingComposeOptions, type BreakingDraft, type DeskHandleRow, type DirectoryHandleRow, type HandleRules, type HashtagRule,
  type LearnStory, type LearnedReporterToken, type MatchType, type PartyRules, type ReporterRules, type SubjectRules, type SuggestRules, type TagNormaliser,
} from "@socia/core";
import { itemKey, itemOutcomes, postItems } from "../src/decisions";
import type { LoggedItemOutcome, LoggedProposal } from "../src/schema";

// ─── Text helpers (pure) ────────────────────────────────────────────────────

export const nfc = (s: string | null | undefined) => (s ?? "").normalize("NFC").replace(/\r/g, "");
/** Spaces collapsed, blank-line runs cut to one: two texts equal under this are the same post */
export const ws = (s: string | null | undefined) =>
  nfc(s).replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const HASHTAG = /#[\p{L}\p{M}\p{N}_]+/gu;
const HANDLE = /@[A-Za-z0-9_]+/g;
const WORD = "[\\p{L}\\p{M}\\p{N}]";

/** twitter-text v3: these code point ranges weigh 1, everything else 2 (Devanagari U+0900–097F weighs 1) */
const LIGHT: readonly [number, number][] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
const URL_IN_TEXT = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|org|net|co|io|gov|news|info|me|ly|tv|live|app|xyz)\b(?:\/\S*)?/giu;
const graphemes = new Intl.Segmenter("hi", { granularity: "grapheme" });
const EMOJI = /\p{Extended_Pictographic}/u;

/** X's weighted length (twitter-text v3 config), kept here so a branch cannot loosen G5 by changing core's count */
export function weightedLength(text: string): number {
  let total = 0;
  const rest = nfc(text).replace(URL_IN_TEXT, () => {
    total += 23;
    return "";
  });
  for (const { segment } of graphemes.segment(rest)) {
    if (EMOJI.test(segment)) {
      total += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      total += LIGHT.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
    }
  }
  return total;
}

/** Line 1 with every tag's "#" (and its underscores) taken out: what the card heading should read */
export function untagged(line: string): string {
  return nfc(line).replace(HASHTAG, (t) => t.slice(1).replace(/_/g, " "));
}

/** A heading's comparison key: no "#", no spaces, joiners or underscores, one colon form, lower case */
export function headingKey(text: string): string {
  return nfc(text).replace(/[\u200c\u200d]/g, "").replace(/[#_\s]+/gu, "").replace(/：/g, ":").toLowerCase();
}

// ─── Places outside Rajasthan (G2) ──────────────────────────────────────────
// A FIXED list, so every branch is gated by the same words (core's national list may grow in a branch).

const OUTSIDE_HI = [
  "दिल्ली", "नई दिल्ली", "दिल्ली-NCR", "दिल्ली-एनसीआर", "एनसीआर", "उत्तर प्रदेश", "उत्तरप्रदेश", "यूपी", "मध्य प्रदेश", "मध्यप्रदेश", "बिहार", "पंजाब", "हरियाणा", "गुजरात",
  "महाराष्ट्र", "पश्चिम बंगाल", "बंगाल", "कर्नाटक", "केरल", "तमिलनाडु", "आंध्र प्रदेश", "तेलंगाना", "ओडिशा", "उड़ीसा", "झारखंड", "छत्तीसगढ़",
  "उत्तराखंड", "हिमाचल", "हिमाचल प्रदेश", "असम", "गोवा", "जम्मू", "कश्मीर", "जम्मू-कश्मीर", "लद्दाख", "मणिपुर", "मिजोरम", "नागालैंड", "मेघालय",
  "त्रिपुरा", "सिक्किम", "अरुणाचल", "पुडुचेरी", "चंडीगढ़", "मुंबई", "कोलकाता", "चेन्नई", "बेंगलुरु", "बेंगलुरू", "हैदराबाद", "लखनऊ", "वाराणसी",
  "पटना", "भोपाल", "इंदौर", "ग्वालियर", "अहमदाबाद", "गांधीनगर", "जामनगर", "नोएडा", "गुरुग्राम", "गुड़गांव", "आगरा", "मथुरा", "प्रयागराज", "अयोध्या",
  "कानपुर", "श्रीनगर", "देहरादून", "शिमला", "रांची", "पुणे", "अमृतसर", "लुधियाना", "पाकिस्तान", "पाकिस्तानी", "चीन", "नेपाल", "बांग्लादेश", "अमेरिका",
  "अमेरिकी", "रूस", "यूक्रेन", "इजराइल", "इजरायल", "ईरान", "अफगानिस्तान", "दुबई", "सऊदी", "लंदन", "ब्रिटेन", "कनाडा", "जापान", "ऑस्ट्रेलिया", "फ्रांस",
  "जर्मनी", "श्रीलंका", "म्यांमार", "भूटान", "कतर", "काठमांडू", "जनकपुर", "सिंगापुर",
];
const OUTSIDE_EN = [
  "Delhi", "New Delhi", "Delhi-NCR", "Mumbai", "Kolkata", "Chennai", "Bengaluru", "Bangalore", "Hyderabad", "Lucknow", "Patna", "Bhopal", "Indore", "Ahmedabad", "Noida",
  "Gurugram", "Gurgaon", "Punjab", "Haryana", "Gujarat", "Bihar", "Maharashtra", "Karnataka", "Kerala", "Uttar Pradesh", "Madhya Pradesh", "West Bengal",
  "Odisha", "Assam", "Goa", "Jammu", "Kashmir", "Ladakh", "Pakistan", "China", "Nepal", "Bangladesh", "USA", "America", "Russia", "Ukraine", "Israel", "Iran",
  "Afghanistan", "Dubai", "London", "Canada", "Japan",
];
/** After the place word these make it a route or a street of a Rajasthan city ("दिल्ली रोड", "दिल्ली-मुंबई एक्सप्रेसवे") */
const ROUTE_AFTER = /^\s*(?:[-–—]|रोड|मार्ग|बाईपास|बायपास|हाईवे|हाइवे|एक्सप्रेसवे|एक्सप्रेस-वे|गेट|दरवाजा|दरवाज़ा|पब्लिक|road|highway|expressway|bypass|gate)/iu;
const ROUTE_BEFORE = /[-–—]\s*$/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OUTSIDE_RE = new RegExp(
  `(?<!${WORD})(${[...OUTSIDE_HI, ...OUTSIDE_EN].sort((a, b) => b.length - a.length).map((w) => escapeRe(w.normalize("NFC"))).join("|")})(?!${WORD})`,
  "giu",
);

/** The places outside Rajasthan the text names, routes and city streets ("दिल्ली रोड") left out */
export function outsidePlaces(text: string): string[] {
  // a visarga used as a colon ("गुजरातः जामनगर") would otherwise glue to the word
  const t = nfc(text).replace(/ः(?=\s|$)/gu, ":");
  const found = new Set<string>();
  for (const m of t.matchAll(OUTSIDE_RE)) {
    const at = m.index ?? 0;
    if (ROUTE_BEFORE.test(t.slice(Math.max(0, at - 3), at)) || ROUTE_AFTER.test(t.slice(at + m[0].length))) continue;
    found.add(m[0]);
  }
  return [...found];
}

const JAIPUR_TAG = new Set(["#jaipur", "#जयपुर"]);

/**
 * G3: after the opening district these make it something other than the story's place: a road or route ("जयपुर हाईवे",
 * "सीकर रोड", "जयपुर-दिल्ली"), a list of districts ("कोटा, बारां…"), or an office named after it ("श्रीगंगानगर सांसद",
 * "जयपुर रेंज IG")
 */
const NOT_THE_PLACE_AFTER = /^\s*(?:[-–—,]|और\s|व\s|एवं\s|रोड|मार्ग|बाईपास|बायपास|हाईवे|हाइवे|एक्सप्रेसवे|स्टेट हाईवे|सांसद|विधायक|रेंज|संभाग|road|highway)/iu;
/** Whether what follows a headline's opening place word keeps it from being the story's place (G3) */
export const openingIsNotThePlace = (rest: string) => NOT_THE_PLACE_AFTER.test(nfc(rest));
/** Whether a card heading leads with Jaipur ("Jaipur: …", "जयपुर: …") */
export const cardLeadsJaipur = (card: string) => /^\s*(?:jaipur|जयपुर)\s*[:：]/iu.test(nfc(card));

// ─── Outcome tallies (pure) ─────────────────────────────────────────────────

export interface Tally {
  kept: number;
  removed: number;
  accepted: number;
  ignored: number;
  /** desk_added: in the post, offered by no rule (source "desk") */
  added: number;
}
const emptyTally = (): Tally => ({ kept: 0, removed: 0, accepted: 0, ignored: 0, added: 0 });
const OUTCOME_FIELD: Record<string, keyof Tally> = { kept: "kept", removed: "removed", accepted: "accepted", ignored: "ignored", desk_added: "added" };

/** Per rule source, how its items fared (itemOutcomes semantics) */
export function tallyBySource(lists: Iterable<readonly LoggedItemOutcome[]>): Record<string, Tally> {
  const out: Record<string, Tally> = {};
  for (const list of lists) {
    for (const o of list) {
      const field = OUTCOME_FIELD[o.outcome];
      if (!field) continue;
      // desk_added carries source "desk", the same id as the desk-handles rule: kept apart, per kind
      const key = o.outcome === "desk_added" ? `(not offered) ${o.kind === "handle" ? "@" : "#"}` : o.source;
      (out[key] ??= emptyTally())[field] += 1;
    }
  }
  return out;
}

export interface KeptLost {
  id: string;
  file: string;
  item: string;
  source: string;
  /** What the item is now: accepted (only offered), desk_added (no longer offered), or removed */
  now: string;
}

/** G1: sources whose removed count rose, and every item the desk kept in the baseline that is no longer kept */
export function compareToBaseline(
  now: Record<string, Tally>,
  base: Record<string, Tally>,
  nowStories: ReadonlyMap<string, { file: string; outcomes: readonly LoggedItemOutcome[] }>,
  baseStories: ReadonlyMap<string, { file: string; outcomes: readonly LoggedItemOutcome[] }>,
): { rises: { source: string; base: number; now: number }[]; keptLost: KeptLost[] } {
  const rises = Object.keys(now)
    .filter((s) => now[s]!.removed > (base[s]?.removed ?? 0))
    .map((s) => ({ source: s, base: base[s]?.removed ?? 0, now: now[s]!.removed }))
    .sort((a, b) => b.now - b.base - (a.now - a.base));
  const keptLost: KeptLost[] = [];
  for (const [id, b] of baseStories) {
    const n = nowStories.get(id);
    if (!n) continue;
    const fate = new Map(n.outcomes.map((o) => [itemKey(o.item), o.outcome]));
    for (const o of b.outcomes) {
      if (o.outcome !== "kept") continue;
      const f = fate.get(itemKey(o.item));
      if (f !== "kept") keptLost.push({ id, file: b.file, item: o.item, source: o.source, now: f ?? "gone" });
    }
  }
  return { rises, keptLost };
}

// ─── Socia ↔ X matching (x-audit.cjs, ported as is) ─────────────────────────

function parts(text: string) {
  const lines = ws(text).split("\n").filter((l) => l.trim() !== "");
  const line1 = lines[0] ?? "";
  if (lines.length > 1 && /^([#@][^\s]+\s*)+$/u.test(lines[lines.length - 1]!)) lines.pop();
  return { line1, body: lines.slice(1).join("\n") };
}
const headCore = (l1: string) => nfc(l1).replace(/#[A-Za-z][A-Za-z0-9_]*/g, " ").replace(/#/g, "").replace(/[:：]/g, " ").replace(/\s+/g, " ").trim();
const bodyCore = (b: string) => nfc(b).replace(HASHTAG, " ").replace(HANDLE, " ").replace(/\s+/g, " ").trim();
const headingMatchKey = (s: string) => headCore(s).replace(/[^\p{L}\p{M}\p{N}]/gu, "").slice(0, 28);
const onlyLetters = (s: string) => nfc(s).replace(/#[A-Za-z][A-Za-z0-9_]*/g, "").replace(HANDLE, "").replace(/[^\p{L}\p{M}\p{N}]/gu, "");
const letters = (text: string) => {
  const p = parts(text);
  return onlyLetters(`${headCore(p.line1)} ${bodyCore(p.body)}`);
};
const grams = (s: string, n = 3) => {
  const g = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) g.add(s.slice(i, i + n));
  return g;
};
const inter = (a: Set<string>, b: Set<string>) => {
  let k = 0;
  for (const x of a) if (b.has(x)) k++;
  return k;
};
const contain = (a: Set<string>, b: Set<string>) => (!a.size || !b.size ? 0 : inter(a, b) / Math.min(a.size, b.size));
const dice = (a: Set<string>, b: Set<string>) => (!a.size || !b.size ? 0 : (2 * inter(a, b)) / (a.size + b.size));

export interface XPost {
  url: string;
  text: string;
  ts: number;
  video: boolean;
}

/**
 * Socia posts to X posts: every pair within -3 h..+10 h of the desk's Copy & Posted scored on letters-only trigram
 * containment and Dice, a bonus for the same heading key and a small time penalty; video posts left out; global
 * greedy by score (x-audit.cjs, 961 matches on 23–24 Nov with no false match found by hand).
 */
export function matchX(stories: readonly { ref: string; ts: number }[], posts: readonly XPost[]): Map<number, { j: number; c: number; d: number }> {
  const xs = posts.map((t) => ({ ...t, g: grams(letters(t.text)), key: headingMatchKey(parts(t.text).line1) }));
  const lo = Math.min(...posts.map((p) => p.ts)) - 600 * 60_000;
  const hi = Math.max(...posts.map((p) => p.ts)) + 180 * 60_000;
  const pairs: { i: number; j: number; c: number; d: number; k: boolean; score: number }[] = [];
  stories.forEach((r, i) => {
    if (!(r.ts >= lo && r.ts <= hi)) return;
    const g = grams(letters(r.ref));
    const k2 = headingMatchKey(parts(r.ref).line1);
    xs.forEach((t, j) => {
      if (t.video) return;
      const lag = (t.ts - r.ts) / 60_000;
      if (lag < -180 || lag > 600) return;
      const c = contain(g, t.g);
      const k = k2 === t.key;
      if (c < 0.5 && !k) return;
      const d = dice(g, t.g);
      pairs.push({ i, j, c, d, k, score: 0.5 * c + 0.5 * d + (k ? 0.15 : 0) - (Math.min(Math.abs(lag), 600) / 600) * 0.15 });
    });
  });
  pairs.sort((a, b) => b.score - a.score);
  const byStory = new Map<number, { j: number; c: number; d: number }>();
  const taken = new Set<number>();
  for (const p of pairs) {
    if (byStory.has(p.i) || taken.has(p.j)) continue;
    if (!((p.c >= 0.75 && p.d >= 0.5) || (p.k && p.c >= 0.6))) continue;
    byStory.set(p.i, { j: p.j, c: p.c, d: p.d });
    taken.add(p.j);
  }
  return byStory;
}

// ─── Per-story result ───────────────────────────────────────────────────────

export interface StoryResult {
  id: string;
  file: string;
  at: string;
  error?: string;
  rajasthan?: boolean;
  district?: string | null;
  districtFrom?: string | null;
  town?: string | null;
  fileDistrict?: string | null;
  headline?: string;
  draft?: string;
  line1?: string;
  card?: string;
  cardFrom?: "backend" | "frontend";
  headingPlace?: unknown;
  hashtags?: string[];
  mentions?: string[];
  proposals?: { item: string; kind: string; layer: string; source: string }[];
  truth?: { from: "x" | "posted" | "final"; text: string; url?: string };
  outcomes?: LoggedItemOutcome[];
  len?: number;
  flags?: { g2: string | null; g3: string | null; g4: boolean; g5: boolean };
  g7?: { leadEq: boolean; cityEq: boolean; exactX: boolean | null; exactPosted: boolean };
}

export interface GateResult {
  id: string;
  title: string;
  /** null: not run (G1 without a baseline) */
  pass: boolean | null;
  count: number;
  of: number;
  detail: string[];
  examples: string[];
}

// ─── CLI ────────────────────────────────────────────────────────────────────

interface GoldenRow {
  file_name: string;
  source_text: string;
  created_at: string;
  posted: string;
  published_at?: string | null;
  district?: string | null;
  town?: string | null;
}
interface DecisionRow {
  file_name: string;
  decision: string;
  decided_at: string | null;
  final_text: string | null;
  item_outcomes: LoggedItemOutcome[] | null;
}
interface RuleRow {
  id: string;
  match_type: string;
  name: string;
  aliases: string[] | null;
  hashtag_latin: string;
  hashtag_devanagari: string | null;
  priority: number;
  active: boolean;
  negative_phrases: string[] | null;
}
interface DirectoryRow {
  handle: string;
  entity_name: string;
  entity_name_hi: string | null;
  aliases: string[] | null;
  platform: string;
  source: string;
  verified_at: string | null;
  entity_type: string | null;
}
interface DataFile<T> {
  get(): Promise<{ value: T; version: string }>;
  ok(): boolean;
  readonly name: string;
}
interface PhaseOneLike {
  places: DataFile<PlaceBook>;
  handles: DataFile<HandleRules>;
  subjects: DataFile<SubjectRules>;
  reporters: DataFile<ReporterRules>;
  parties: DataFile<PartyRules>;
  normalise: DataFile<TagNormaliser>;
  campaigns: DataFile<SuggestRules>;
  beats: DataFile<BeatRules>;
}
type CardHeadline = (
  headline: string,
  d: { bodyText: string; story: { district?: string | null; town?: string | null; headline?: string | null }; handlePick?: { headingPlace?: unknown } | null },
) => string;

const fail = (msg: string): never => {
  console.error(`tag-replay: ${msg}`);
  process.exit(2);
};

function parseArgs(argv: string[]) {
  const one = new Map<string, string>();
  const many = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) fail(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
    i++;
    one.set(a.slice(2), v!);
    many.set(a.slice(2), [...(many.get(a.slice(2)) ?? []), v!]);
  }
  const known = ["golden", "decisions", "rules", "handles", "cases", "data", "x", "frontend", "out", "baseline", "csv", "report", "truth"];
  for (const k of one.keys()) if (!known.includes(k)) fail(`unknown flag --${k} (known: ${known.map((x) => `--${x}`).join(" ")})`);
  const data = one.get("data");
  const inData = (pick: RegExp) => {
    if (!data) return undefined;
    const hits = readdirSync(data).filter((f) => pick.test(f));
    if (hits.length > 1) fail(`--data ${data} holds ${hits.length} files matching ${pick} (${hits.join(", ")}): name one with its own flag`);
    return hits[0] ? join(data, hits[0]) : undefined;
  };
  const golden = one.get("golden") ?? inData(/^golden.*\.json$/i) ?? fail("--golden (or --data with one golden*.json) is required");
  return {
    golden,
    decisions: one.get("decisions") ?? inData(/^decisions.*\.json$/i),
    rules: one.get("rules") ?? inData(/^hashtag_rules\.json$/i),
    handles: one.get("handles") ?? inData(/^handle_directory\.json$/i),
    cases: one.get("cases") ?? inData(/^screenshot-cases\.json$/i),
    x: many.get("x") ?? [],
    frontend: one.get("frontend"),
    out: one.get("out"),
    baseline: one.get("baseline"),
    csv: one.get("csv"),
    report: one.get("report"),
    /** x: the matched X post, else the posted text (default); posted: the posted text only (compare with the live column) */
    truth: (one.get("truth") ?? "x") === "posted" ? ("posted" as const) : one.get("truth") === undefined || one.get("truth") === "x" ? ("x" as const) : fail("--truth is x or posted"),
  };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const sha1 = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 12);
function git(dir: string): string {
  try {
    const run = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = run("status", "--porcelain", "--untracked-files=no") ? "+dirty" : "";
    return `${run("rev-parse", "--abbrev-ref", "HEAD")}@${run("rev-parse", "--short", "HEAD")}${dirty}`;
  } catch {
    return "unknown";
  }
}
const csvCell = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(" ") : String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const pct = (k: number, of: number) => `${k}/${of} (${((100 * k) / Math.max(1, of)).toFixed(1)}%)`;
const one = (s: string | undefined, n = 90) => ws(s).replace(/\n+/g, " | ").slice(0, n);

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, "../../..");
  const lines: string[] = [];
  const say = (s = "") => {
    lines.push(s);
    console.log(s);
  };

  // ── Inputs ──
  const golden = readJson(args.golden) as GoldenRow[];
  if (!Array.isArray(golden) || !golden.length) fail(`${args.golden} holds no rows`);
  golden.forEach((r, i) => {
    for (const k of ["file_name", "source_text", "created_at", "posted"] as const) {
      if (typeof r[k] !== "string" || !r[k]) fail(`${args.golden} row ${i} has no ${k}`);
    }
  });
  const decisions = args.decisions ? (readJson(args.decisions) as DecisionRow[]) : [];
  const ruleRows = args.rules ? (readJson(args.rules) as RuleRow[]) : [];
  const dirRows = args.handles ? (readJson(args.handles) as DirectoryRow[]) : [];
  const caseRows = args.cases ? (readJson(args.cases) as GoldenRow[]) : [];
  const xPosts: XPost[] = args.x.flatMap((f) => {
    const j = readJson(f) as { tweets?: unknown[] } | unknown[];
    const list = (Array.isArray(j) ? j : j.tweets) as { url: string; text: string; timestamp_utc: string; hasVideo?: boolean }[] | undefined;
    if (!Array.isArray(list)) fail(`${f} has no tweets`);
    return list!.map((t) => ({ url: t.url, text: t.text, ts: Date.parse(t.timestamp_utc), video: !!t.hasVideo || /#FINVideo/i.test(t.text) }));
  });
  if (!args.rules) say("WARNING: no --rules: topic hashtag rules are off (the worker always has them)");
  if (!args.handles) say("WARNING: no --handles: desk handles and learned reporter tokens are off (the worker always has them)");

  // ── The worker's data files, through its own loader (apps/worker/src/data-files.ts phaseOneData) ──
  const dataFilesTs = join(repo, "apps/worker/src/data-files.ts");
  const dfMod = (await import(pathToFileURL(dataFilesTs).href)) as { phaseOneData?: (log: unknown, onStatus?: unknown, env?: Record<string, string | undefined>) => PhaseOneLike };
  if (typeof dfMod.phaseOneData !== "function") fail(`${dataFilesTs} has no phaseOneData: the replay cannot load the data files the way the worker does`);
  const dataProblems: string[] = [];
  const quiet = () => undefined;
  const logger = {
    info: quiet, debug: quiet, trace: quiet, fatal: quiet,
    warn: (o: { file?: string; problems?: string[] }, m: string) => dataProblems.push(`${o?.file ?? "?"}: ${m}${o?.problems ? `: ${o.problems.join("; ")}` : ""}`),
    error: (o: { file?: string }, m: string) => dataProblems.push(`${o?.file ?? "?"}: ${m}`),
    child() {
      return logger;
    },
  };
  // env {}: the files in apps/worker/config, never a path from the environment
  const data = dfMod.phaseOneData!(logger, undefined, {});
  const files = [data.places, data.handles, data.subjects, data.parties, data.reporters, data.beats, data.normalise, data.campaigns] as DataFile<unknown>[];
  for (const f of files) await f.get().catch((e: unknown) => dataProblems.push(`${f.name}: ${(e as Error).message}`));
  const broken = files.filter((f) => !f.ok());
  if (broken.length) fail(`data files did not load: ${broken.map((f) => f.name).join(", ")}\n${dataProblems.join("\n")}`);
  const book = (await data.places.get()).value;
  const rules = (await data.handles.get()).value;
  const subjects = (await data.subjects.get()).value;
  const roster = (await data.reporters.get()).value;
  const parties = (await data.parties.get()).value;
  const normaliser = (await data.normalise.get()).value;
  const suggestRules = (await data.campaigns.get()).value;
  const beats = (await data.beats.get()).value;
  const tagPlaces = parseDistricts(readJson(join(repo, "apps/worker/config/districts.json")), (m) => dataProblems.push(`districts: ${m}`));

  // ── The worker's learning inputs (compose.ts Dictionaries), from the snapshots ──
  const topicRules: HashtagRule[] = ruleRows
    .filter((r) => r.active && r.match_type === "entity")
    .map((r) => ({
      id: r.id, matchType: r.match_type as MatchType, name: r.name, aliases: r.aliases ?? [], hashtagLatin: r.hashtag_latin,
      hashtagDevanagari: r.hashtag_devanagari, priority: r.priority, negativePhrases: r.negative_phrases ?? [],
    }));
  const topics = hashtagGazetteer(topicRules);
  const verified = dirRows.filter((r) => r.platform === "x" && !!r.verified_at);
  const deskRows: DeskHandleRow[] = verified.filter((r) => r.source === "desk").map((r) => ({ handle: r.handle, entityName: r.entity_name, aliases: r.aliases ?? [] }));
  const learnedReporters: LearnedReporterToken[] = verified
    .filter((r) => r.source === "reporter")
    .flatMap((r) => (r.aliases ?? []).map((token) => ({ handle: r.handle, token, name: r.entity_name })));
  const settingsBase = verified.filter((r) => r.source !== "desk" && r.source !== "reporter");

  // Posted counts and posted stories per handle (db composer.ts handlePostedUses / handlePostedStories), from the
  // posted texts in the export: a whole "@handle", any case
  const parsedGolden = golden.map((r) => {
    const p = parseBreaking(r.source_text, r.file_name, book);
    return { p, story: { headline: p.headline, body: p.points.join("\n"), district: p.district, town: p.town } satisfies LearnStory };
  });
  const bare = (h: string) => h.trim().replace(/^@+/, "").toLowerCase();
  const postsWith = (handle: string) => {
    const re = new RegExp(`(^|[^A-Za-z0-9_])@${escapeRe(bare(handle))}([^A-Za-z0-9_]|$)`, "i");
    return golden.map((r, i) => (re.test(r.posted) ? i : -1)).filter((i) => i >= 0);
  };
  const candidates = [...districtKeywordCandidates(), ...(subjects.keywordCandidates ?? [])];
  const learnedDesk = deskRows.map((r) => (r.aliases.length ? withKeywordUses(r, postsWith(r.handle).map((i) => parsedGolden[i]!.story), candidates) : r));
  const settingsRows: DirectoryHandleRow[] = settingsBase.map((r) => ({
    handle: r.handle, entityName: r.entity_name, entityNameHi: r.entity_name_hi, aliases: r.aliases ?? [],
    type: isSettingsHandleType(r.entity_type) ? r.entity_type : null, postedUses: postsWith(r.handle).length,
  }));
  const desk = directoryHandleRules(learnedDesk, settingsRows, { fileHandles: [...(rules.all ?? []), ...(subjects.handles ?? [])] });
  const reporters = mergeReporterTokens(roster, learnedReporters, (m) => dataProblems.push(`learned reporter token: ${m}`));
  // P5: the prior and declared beats run only when all four directory files loaded (checked above: they did)
  const reporterPrior = [data.handles, data.subjects, data.parties, data.reporters].every((f) => f.ok());

  // ── The card heading the desk sees ──
  let frontendCard: CardHeadline | null = null;
  let frontendFile: string | null = null;
  {
    const given = args.frontend ?? join(repo, "../frontend");
    const file = /\.tsx?$/.test(given) ? given : join(given, "src/components/Newsroom/BreakingDesk/cardWords.ts");
    if (existsSync(file)) {
      const cw = (await import(pathToFileURL(resolve(file)).href)) as { draftCardHeadline?: CardHeadline };
      if (typeof cw.draftCardHeadline !== "function") fail(`${file} has no draftCardHeadline`);
      frontendCard = cw.draftCardHeadline!;
      frontendFile = resolve(file);
    } else if (args.frontend) fail(`--frontend: ${file} does not exist`);
  }

  // ── Ground truth: the X post where one matches, else the posted text ──
  const decByFile = new Map<string, DecisionRow[]>();
  for (const d of decisions) if (d.decision !== "rejected") (decByFile.get(d.file_name) ?? decByFile.set(d.file_name, []).get(d.file_name)!).push(d);
  const decisionOf = (r: GoldenRow): DecisionRow | null => {
    const list = decByFile.get(r.file_name) ?? [];
    const at = Date.parse(r.published_at ?? r.created_at);
    return list.slice().sort((a, b) => Math.abs(Date.parse(a.decided_at ?? "") - at) - Math.abs(Date.parse(b.decided_at ?? "") - at))[0] ?? null;
  };
  const joined = golden.map(decisionOf);
  const xMatch = xPosts.length && args.truth === "x" ? matchX(golden.map((r) => ({ ref: r.posted, ts: Date.parse(r.published_at ?? r.created_at) })), xPosts) : new Map();

  // ── Place keys for G7 (heading-replay.ts) ──
  const placeKey = (tag: string): string | null => {
    const p = placeOfTag(book, tag);
    if (p) return p.kind === "town" ? `town:${p.hi}` : `d:${p.districts[0]?.name ?? p.hi}`;
    const t = tagPlace(tag, tagPlaces);
    return t ? `x:${t.place.toLowerCase()}` : null;
  };
  const tagsOf = (s: string) => [...nfc(s).matchAll(HASHTAG)].map((m) => m[0].slice(1));
  const cityKeys = (text: string) => new Set(tagsOf(text).map(placeKey).filter((k): k is string => !!k));
  const leadKeys = (line1: string) => {
    const m = /^((?:#[\p{L}\p{M}\p{N}_]+\s*)+)/u.exec(nfc(line1).trim());
    return new Set((m ? tagsOf(m[1]!) : []).map(placeKey).filter((k): k is string => !!k));
  };
  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
  // G3: the Rajasthan districts (every spelling) a headline may open with
  const districtNames = book.districts.filter((d) => d.rajasthan).map((d) => ({ name: d.name, names: book.spellingsOf(d.name) }));
  const openingDistrict = (headline: string): string | null => {
    const text = nfc(headline).replace(/^[\s#]+/u, "");
    let best: { name: string; k: number } | null = null;
    for (const d of districtNames) {
      const k = openingPlaceLength(text, d.names);
      if (k > 0 && (!best || k > best.k)) best = { name: d.name, k };
    }
    return best && !openingIsNotThePlace(text.slice(best.k)) ? best.name : null;
  };
  const jaipurPlace = (text: string) => book.find(text).some((m) => m.entry.data.districts.some((d) => d.name === "Jaipur"));

  // ── Compose every story ──
  const results: StoryResult[] = golden.map((r, i) => {
    const id = `${r.file_name}|${r.created_at}`;
    const base: StoryResult = { id, file: r.file_name, at: r.created_at };
    try {
      const p = parsedGolden[i]!.p;
      const slot = slotFromTags(p.tags);
      // as compose.ts does: the stored story's fields (convert.ts: body = points joined by "\n")
      const headline = p.headline ?? "";
      const body = p.points.join("\n");
      const place = book.district(p.district);
      const rajasthan = place
        ? place.rajasthan
        : !nationalWithoutPlace(p.tags, [headline, body].join(" । "), book, pickReporter(slot.reporterToken, reporters).match?.districts);
      const opts: BreakingComposeOptions = {
        version: "replay", topics, subjects, desk, reporters, parties, normaliser, suggestRules, beats, at: new Date(r.created_at), reporterPrior,
      };
      const d: BreakingDraft = composeBreaking(
        {
          headline, points: body.split("\n").filter(Boolean), district: p.district, districtFrom: p.districtFrom, town: p.town, rajasthan,
          leaderPost: LEADER_POST.test(headline), rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district,
          unknownBureauCode: slot.unknownCode,
        },
        rules, book, opts,
      );
      // the decision log's proposals (compose.ts draftProposals): core's list, else built from the fields
      const proposals: LoggedProposal[] = Array.isArray(d.proposals)
        ? d.proposals.map((x) => ({ ...x }))
        : [
          ...d.hashtags.map((t): LoggedProposal => ({ item: t, kind: "hashtag", layer: "emit", source: "footer", reason: "footer" })),
          ...d.mentions.map((h): LoggedProposal => ({ item: h, kind: "handle", layer: "emit", source: "handle", reason: "handle" })),
          ...d.hashtagSuggestions.map((t): LoggedProposal => ({ item: t, kind: "hashtag", layer: "suggest", source: "suggestion", reason: "suggestion" })),
        ];
      const draft = assemblePostText(d.bodyText, d.hashtags, d.mentions);
      const line1 = d.bodyText.split("\n")[0] ?? "";
      const hp = d.headingPlace as unknown as Record<string, unknown> | undefined;
      const backendCard = typeof hp?.cardHeadline === "string" ? hp.cardHeadline : typeof (d as unknown as Record<string, unknown>).cardHeadline === "string" ? ((d as unknown as Record<string, unknown>).cardHeadline as string) : null;
      if (backendCard === null && !frontendCard) throw new Error("no card heading: the draft has no cardHeadline field and no frontend cardWords.ts was found (--frontend)");
      const card = backendCard ?? frontendCard!(headline, { bodyText: d.bodyText, story: { district: p.district, town: p.town, headline }, handlePick: { headingPlace: d.headingPlace } });

      // ground truth
      const m = xMatch.get(i);
      const dec = joined[i];
      const truth: StoryResult["truth"] = m
        ? { from: "x", text: xPosts[m.j]!.text, url: xPosts[m.j]!.url }
        : r.posted
          ? { from: "posted", text: r.posted }
          : { from: "final", text: dec?.final_text ?? "" };
      const outcomes = itemOutcomes(proposals, truth.text);

      // gates
      const storyText = nfc(r.source_text).split("\n").filter((l, k) => !(k === 0 && /_/.test(l) && !/[ऀ-ॿ]/u.test(l))).join("\n");
      const outside = outsidePlaces(storyText);
      const draftTags = postItems(draft).hashtags.map(itemKey);
      const jaipurOnPost = draftTags.some((t) => JAIPUR_TAG.has(t)) || cardLeadsJaipur(card);
      const emitJaipur = proposals.filter((x) => x.layer === "emit" && JAIPUR_TAG.has(itemKey(x.item)));
      const g2: string[] = [];
      const truthJaipur = postItems(truth.text).hashtags.some((t) => JAIPUR_TAG.has(itemKey(t)));
      if (jaipurOnPost && outside.length && !jaipurPlace(storyText)) g2.push(`national:${outside.slice(0, 3).join("/")}${truthJaipur ? " (truth also #Jaipur)" : ""}`);
      if (proposals.some((x) => x.source === "district.city.fallback")) g2.push("district.city.fallback");
      if (draftTags.some((t) => JAIPUR_TAG.has(t)) && !emitJaipur.some((x) => !/fallback/.test(x.source))) g2.push(`#Jaipur source: ${emitJaipur.map((x) => x.source).join("/") || "none"}`);
      const opening = openingDistrict(p.rawHeadline || headline);
      const composed = d.headingPlace?.district ?? null;
      const g3 = opening && composed && composed !== opening && slot.district === composed ? `opens with ${opening}, file code gave ${composed}` : null;
      const g4 = headingKey(card) !== headingKey(untagged(line1));
      const len = weightedLength(draft);

      return {
        ...base,
        rajasthan, district: p.district, districtFrom: p.districtFrom, town: p.town, fileDistrict: slot.district ?? null, headline, draft, line1, card,
        cardFrom: backendCard !== null ? "backend" : "frontend", headingPlace: d.headingPlace, hashtags: d.hashtags, mentions: d.mentions,
        proposals: proposals.map((x) => ({ item: x.item, kind: x.kind, layer: x.layer, source: x.source })), truth, outcomes, len,
        flags: { g2: g2.length ? g2.join("; ") : null, g3, g4, g5: len > 280 },
        g7: {
          leadEq: sameSet(leadKeys(line1), leadKeys(parts(truth.text).line1)),
          cityEq: sameSet(cityKeys(draft), cityKeys(truth.text)),
          exactX: m ? ws(draft) === ws(truth.text) : null,
          exactPosted: ws(draft) === ws(r.posted),
        },
      };
    } catch (err) {
      return { ...base, error: (err as Error)?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(err) };
    }
  });

  // ── Summary ──
  const ok = results.filter((x) => !x.error);
  const errors = results.filter((x) => x.error);
  const perSource = tallyBySource(ok.map((x) => x.outcomes ?? []));
  const live = tallyBySource(joined.map((d) => d?.item_outcomes ?? []));
  const ex = (xs: StoryResult[], why?: (x: StoryResult) => string) => xs.slice(0, 10).map((x) => (why ? `${x.file}  (${why(x)})` : x.file));
  const gates: GateResult[] = [];
  gates.push({ id: "G0", title: "every story re-composes", pass: errors.length === 0, count: errors.length, of: results.length, detail: [], examples: ex(errors, (x) => x.error!.slice(0, 160)) });

  // G1
  type RunFile = { summary?: { perSource?: Record<string, Tally> }; stories?: StoryResult[]; meta?: { inputs?: Record<string, string> } };
  let baseline: RunFile | null = null;
  let changed: { now: StoryResult; was: StoryResult | undefined }[] = [];
  if (args.baseline) {
    baseline = readJson(args.baseline) as RunFile;
    if (!baseline?.summary?.perSource || !Array.isArray(baseline.stories)) fail(`${args.baseline} is not a tag-replay --out file`);
    const baseStories = new Map(baseline!.stories!.filter((s) => !s.error).map((s) => [s.id, { file: s.file, outcomes: s.outcomes ?? [] }]));
    const nowStories = new Map(ok.map((s) => [s.id, { file: s.file, outcomes: s.outcomes ?? [] }]));
    const { rises, keptLost } = compareToBaseline(perSource, baseline!.summary!.perSource!, nowStories, baseStories);
    const detail = [
      ...rises.map((r) => `removed rose: ${r.source} ${r.base} -> ${r.now}`),
      ...keptLost.map((k) => `kept item lost: ${k.file}  ${k.item}  (was ${k.source}, now ${k.now})`),
    ];
    gates.push({
      id: "G1", title: "no source's removed count rises; no desk-kept item lost", pass: rises.length === 0 && keptLost.length === 0,
      count: rises.length + keptLost.length, of: Object.keys(perSource).length, detail, examples: [...new Set(keptLost.map((k) => k.file))].slice(0, 10),
    });
    const byId = new Map(baseline!.stories!.map((s) => [s.id, s]));
    const sig = (s: StoryResult | undefined) => JSON.stringify([s?.draft, s?.card, s?.error ?? null, (s?.outcomes ?? []).map((o) => `${o.item}:${o.outcome}:${o.source}`).sort()]);
    changed = results.map((now) => ({ now, was: byId.get(now.id) })).filter(({ now, was }) => sig(now) !== sig(was));
  } else {
    gates.push({ id: "G1", title: "no source's removed count rises (needs --baseline)", pass: null, count: 0, of: 0, detail: [], examples: [] });
  }

  const g2 = ok.filter((x) => x.flags!.g2);
  const g2sub = (re: RegExp) => g2.filter((x) => re.test(x.flags!.g2!)).length;
  gates.push({
    id: "G2", title: "no #Jaipur / Jaipur: on outside-place stories; no district.city.fallback; every emitted #Jaipur sourced", pass: g2.length === 0,
    count: g2.length, of: ok.length,
    detail: [
      `#Jaipur or Jaipur: on a story naming Delhi / another state / a foreign country: ${g2sub(/national:/)} (the truth also carries #Jaipur on ${g2sub(/truth also #Jaipur/)})`,
      `district.city.fallback proposed: ${g2sub(/district\.city\.fallback/)}`,
      `#Jaipur emitted without a non-fallback source: ${g2sub(/#Jaipur source/)}`,
    ],
    examples: ex(g2, (x) => x.flags!.g2!),
  });
  const g3 = ok.filter((x) => x.flags!.g3);
  gates.push({ id: "G3", title: "no file-code district beating a Rajasthan district that opens line 1", pass: g3.length === 0, count: g3.length, of: ok.length, detail: [], examples: ex(g3, (x) => x.flags!.g3!) });
  const g4 = ok.filter((x) => x.flags!.g4);
  gates.push({
    id: "G4", title: "card heading = caption line 1 without the tags' #", pass: g4.length === 0, count: g4.length, of: ok.length,
    detail: [
      `card from: backend ${ok.filter((x) => x.cardFrom === "backend").length}, frontend ${ok.filter((x) => x.cardFrom === "frontend").length}`,
      `mismatches by line-1 placement: ${Object.entries(g4.reduce<Record<string, number>>((a, x) => {
        const k = String((x.headingPlace as { placement?: string } | undefined)?.placement ?? "?");
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    ],
    examples: ex(g4, (x) => `line1 "${one(untagged(x.line1!), 60)}" / card "${one(x.card, 60)}"`),
  });
  const g5 = ok.filter((x) => x.flags!.g5);
  gates.push({ id: "G5", title: "no draft over 280 weighted characters", pass: g5.length === 0, count: g5.length, of: ok.length, detail: [`longest: ${Math.max(0, ...ok.map((x) => x.len!))}`], examples: ex(g5, (x) => String(x.len)) });

  const xm = ok.filter((x) => x.truth!.from === "x");
  const g7 = {
    leadEq: ok.filter((x) => x.g7!.leadEq).length,
    cityEq: ok.filter((x) => x.g7!.cityEq).length,
    exactX: xm.filter((x) => x.g7!.exactX).length,
    xMatched: xm.length,
    exactPosted: ok.filter((x) => x.g7!.exactPosted).length,
    n: ok.length,
  };

  // ── Report ──
  const inputs: Record<string, string> = { golden: sha1(args.golden), ...Object.fromEntries(args.x.map((f, k) => [`x${k}`, sha1(f)])) };
  if (args.rules) inputs.rules = sha1(args.rules);
  if (args.handles) inputs.handles = sha1(args.handles);
  const meta = {
    code: git(repo), frontend: frontendFile ? `${git(dirname(frontendFile))} ${frontendFile}` : null, ranAt: new Date().toISOString(), inputs,
    counts: { stories: golden.length, decisionsJoined: joined.filter(Boolean).length, xPosts: xPosts.length, xMatched: xMatch.size },
  };
  const day = (s: string) => s.slice(0, 10);
  say(`tag-replay  code ${meta.code}  card ${frontendFile ? `frontend ${meta.frontend}` : "backend field"}`);
  say(`stories ${golden.length} (${day(golden.reduce((a, r) => (r.created_at < a ? r.created_at : a), golden[0]!.created_at))} .. ${day(golden.reduce((a, r) => (r.created_at > a ? r.created_at : a), golden[0]!.created_at))}); decisions joined ${meta.counts.decisionsJoined}; X posts ${xPosts.length}, matched ${xMatch.size}`);
  say(`learning inputs: topic rules ${topicRules.length} active entity; desk handles ${deskRows.length} (${deskRows.filter((r) => r.aliases.length).length} with keywords); Settings handles ${settingsRows.length}; learned reporter tokens ${learnedReporters.length}; reporter prior ${reporterPrior ? "on" : "off"}`);
  if (dataProblems.length) say(`data file notes (${dataProblems.length}): ${dataProblems.slice(0, 5).join(" || ")}${dataProblems.length > 5 ? " || ..." : ""}`);
  say(`composed ${ok.length}, errors ${errors.length}; Rajasthan ${ok.filter((x) => x.rajasthan).length}, national ${ok.filter((x) => !x.rajasthan).length}; truth: X ${xm.length}, posted text ${ok.length - xm.length}`);
  say();
  say("Per source (replay vs truth; 'live' = the stored item_outcomes of the drafts the desk saw, vs its final text)");
  const head = (s: string) => s.padEnd(30);
  const cols = (t: Tally | undefined) => t ? [t.kept, t.removed, t.accepted, t.ignored, t.added].map((v) => String(v).padStart(9)).join("") : "        -        -        -        -        -";
  say(`${head("source")}${["kept", "removed", "accepted", "ignored", "added"].map((c) => c.padStart(9)).join("")}   | live ${["kept", "removed", "acc", "ign", "added"].map((c) => c.padStart(8)).join("")}${baseline ? "   | delta vs baseline (kept removed accepted ignored added)" : ""}`);
  const sources = [...new Set([...Object.keys(perSource), ...Object.keys(live), ...Object.keys(baseline?.summary?.perSource ?? {})])].sort((a, b) => {
    const tot = (t?: Tally) => (t ? t.kept + t.removed + t.accepted + t.ignored + t.added : 0);
    return tot(perSource[b]) + tot(live[b]) - (tot(perSource[a]) + tot(live[a]));
  });
  for (const s of sources) {
    const l = live[s];
    const liveCols = l ? [l.kept, l.removed, l.accepted, l.ignored, l.added].map((v) => String(v).padStart(8)).join("") : "       -       -       -       -       -";
    const b = baseline?.summary?.perSource?.[s];
    const n = perSource[s];
    const delta = baseline
      ? `   | ${(["kept", "removed", "accepted", "ignored", "added"] as const).map((k) => { const v = (n?.[k] ?? 0) - (b?.[k] ?? 0); return v ? (v > 0 ? `+${v}` : String(v)) : "0"; }).join(" ")}`
      : "";
    say(`${head(s)}${cols(n)}   | live ${liveCols}${delta}`);
  }
  say();
  say("Gates");
  for (const g of gates) {
    const status = g.pass === null ? "SKIP" : g.pass ? "PASS" : "FAIL";
    say(`${g.id} ${status}  ${g.title}: ${g.pass === null ? "-" : `${g.count}${g.of ? ` of ${g.of}` : ""}`}`);
    for (const d of g.detail) say(`     ${d}`);
    if (!g.pass && g.examples.length) say(`     e.g. ${g.examples.join("\n          ")}`);
  }
  say(`G7 REPORT  line-1 place = truth ${pct(g7.leadEq, g7.n)}; post city tags = truth ${pct(g7.cityEq, g7.n)}; exact = X ${pct(g7.exactX, g7.xMatched)}; exact = posted ${pct(g7.exactPosted, g7.n)}`);

  if (caseRows.length) {
    say();
    say(`Hand-picked cases (${caseRows.length})`);
    const byId = new Map(results.map((x) => [x.id, x]));
    for (const c of caseRows) {
      const x = byId.get(`${c.file_name}|${c.created_at}`);
      if (!x) {
        say(`  ${c.file_name}: not in --golden`);
        continue;
      }
      if (x.error) {
        say(`  ${c.file_name}: ERROR ${x.error.slice(0, 120)}`);
        continue;
      }
      const f = x.flags!;
      const bad = [f.g2 && `G2 ${f.g2}`, f.g3 && `G3 ${f.g3}`, f.g4 && "G4 card", f.g5 && `G5 ${x.len}`].filter(Boolean).join("; ") || "ok";
      say(`  ${c.file_name}  [${bad}]`);
      say(`      ours : ${one(x.line1, 100)}   tags ${[...(x.hashtags ?? []), ...(x.mentions ?? [])].join(" ")}`);
      say(`      card : ${one(x.card, 100)}`);
      say(`      truth: ${one(parts(x.truth!.text).line1, 100)}   (${x.truth!.from})`);
    }
  }

  if (baseline) {
    say();
    const inputsChanged = Object.entries(inputs).filter(([k, v]) => baseline!.meta?.inputs?.[k] !== undefined && baseline!.meta!.inputs![k] !== v).map(([k]) => k);
    if (inputsChanged.length) say(`WARNING: the baseline was run on different inputs (${inputsChanged.join(", ")}): the comparison is not like for like`);
    say(`Stories changed vs baseline: ${changed.length}`);
    for (const { now, was } of changed.slice(0, 10)) say(`  ${now.file}: ${one(was?.line1, 60)}  ->  ${one(now.line1, 60)}`);
    if (args.csv) {
      const rows = [
        ["id", "file", "at", "line1_was", "line1_now", "card_was", "card_now", "emit_was", "emit_now", "removed_was", "removed_now", "kept_lost", "gates_was", "gates_now", "truth"],
        ...changed.map(({ now, was }) => {
          const emit = (s?: StoryResult) => (s?.proposals ?? []).filter((p) => p.layer === "emit").map((p) => p.item);
          const removed = (s?: StoryResult) => (s?.outcomes ?? []).filter((o) => o.outcome === "removed").map((o) => o.item);
          const nowFate = new Map((now.outcomes ?? []).map((o) => [itemKey(o.item), o.outcome]));
          const lost = (was?.outcomes ?? []).filter((o) => o.outcome === "kept" && nowFate.get(itemKey(o.item)) !== "kept").map((o) => o.item);
          const gs = (s?: StoryResult) => (s?.error ? "error" : Object.entries(s?.flags ?? {}).filter(([, v]) => v).map(([k]) => k.toUpperCase()).join(" "));
          return [now.id, now.file, now.at, was?.line1, now.line1, was?.card, now.card, emit(was), emit(now), removed(was), removed(now), lost, gs(was), gs(now), now.truth?.from];
        }),
      ];
      writeFileSync(args.csv, `\ufeff${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`);
      say(`changed stories written to ${args.csv}`);
    }
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ meta, summary: { perSource, live, gates, g7 }, stories: results }, null, 1));
    say(`per-story results written to ${args.out} (${(statSync(args.out).size / 1e6).toFixed(1)} MB)`);
  }
  const failed = gates.filter((g) => g.pass === false);
  say(failed.length ? `RESULT: FAIL (${failed.map((g) => g.id).join(", ")})` : "RESULT: PASS");
  if (args.report) writeFileSync(args.report, `${lines.join("\n")}\n`);
  return failed.length ? 1 : 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invoked && invoked === fileURLToPath(import.meta.url).toLowerCase()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 2;
    },
  );
}
