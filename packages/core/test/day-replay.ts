// Per-day replay gate (HASHTAG_HANDLE_CHANGES_v3 §6; fix prompt FL2–FL4).
//
// ─── FLOOR TABLE: how to re-baseline ────────────────────────────────────────────────────────────────────────
// DAY_FLOORS (below) is the only place the floors live. To re-baseline after a composer change:
//   1. Point the harness at the exports (REPLAY_DAYS or REPLAY_EXPORTS_DIR, see INPUT) and run
//        npx tsx test/day-replay.ts
//   2. Copy each day's measured "exact N/posts" count into its `exact` below, and set POOLED_PRECISION_FLOOR to
//      the printed pooled precision minus PRECISION_MARGIN (rounded down to 4 decimals).
//   3. Raise a floor when a change genuinely improves the day; never lower one quietly — say why in the commit.
// A day FAILS only below (exact − EXACT_TOLERANCE) posts: "oct30: at least N exact posts; failing below N−2".
// A day with `exact: null` has no floor yet (its export is not available): it is scored when present, never gated.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Scores the tags composePostTags() EMITS in the trailing run against the structural tags the desk really
// wrote, one capture day at a time.
//
// Scoring, as the change spec's reference composer (compose2.py) does it:
//   ours   = the emitted trailing run (lead is copied from the post, so scoring it would be circular)
//   theirs = the desk's trailing + inline tags, normalised, kept when STRUCTURAL: a place on districts.json
//            (either list), a brand, #FINVideo, any "#<Word>News", #RajasthanNews, #BreakingNews
//   exact  = posts where ours and theirs are the same set; precision = |ours ∩ theirs| / |ours|
//
// Gates (FL2, FL3):
//   - exact-set: a POST COUNT per day, tolerance EXACT_TOLERANCE posts. Always a failure.
//   - precision, pooled: tags of ALL floored days combined against POOLED_PRECISION_FLOOR. A failure — once every
//     floored day's export is present (the floor was measured on that set; on a subset it only warns), or always
//     with REPLAY_STRICT=1.
//   - precision, per day: printed; below DAY_PRECISION_WARN it only WARNS, never fails.
//
// Only `trail` is scored. `suggest` (inferred districts, campaign and keyword tags) is never on the post, so
// it can neither help nor hurt these numbers — which is exactly the property the gate protects.
//
// INPUT: one X export per day, untrusted data, read only. Accepted shapes: `{ "tweets": [...] }`, `{ "posts":
// [...] }` or a bare array, each item with the post in `text` (schemas v1/v2) or `body` (schema v3, whose handles
// are in `handles_mentioned`). Where they are: REPLAY_EXPORTS_DIR (default: the user's Downloads folder) holding
// 1stIndiaNews_tweets_<YYYY-MM-DD>.json, or REPLAY_DAYS="oct30=C:\path\a.json,nov10=C:\path\b.json".
// A day whose export is missing is SKIPPED AND SAID SO; REPLAY_STRICT=1 turns a missing FLOORED day into a failure.
//
// CLI: npx tsx test/day-replay.ts            (prints the table; exit 1 when a gate fails)

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PlaceBook, parsePlacesData } from "../src/breaking/places";
import {
  composePostTags, normaliseTag, parseDistricts, parseHashtagNormalise, segmentPost, tagPlace,
  type PostTagContext, type TagPlaces,
} from "../src/breaking/post-tags";
import { hindiPlaceTag, inferHeadlineDistrict } from "../src/breaking/parse";
import { bookLeadTagDistrict } from "../src/breaking/compose";

/**
 * The floor table. `exact` = exact-set posts measured on reporter-prior-all after the FL/V/N/M/D/C fixes (13 Nov 2026), `posts` = the
 * export's post count at that time (a changed export shows up as a count mismatch). Re-baseline: see the top.
 */
export const DAY_FLOORS = {
  sep09: { date: "2026-09-09", posts: 461, exact: 296 as number | null },
  oct20: { date: "2026-10-20", posts: 326, exact: 248 as number | null },
  oct21: { date: "2026-10-21", posts: 380, exact: 301 as number | null },
  oct30: { date: "2026-10-30", posts: 400, exact: 329 as number | null },
  nov10: { date: "2026-11-10", posts: 602, exact: 514 as number | null },
  nov11: { date: "2026-11-11", posts: 307, exact: 208 as number | null },
  nov12: { date: "2026-11-12", posts: 193, exact: 161 as number | null },
  // TODO(FL4): the 13 Nov export is not available yet. When it arrives, add it to REPLAY_DAYS (or the exports
  // dir), run the CLI, and set `posts` and `exact` from the measured numbers.
  nov13: { date: "2026-11-13", posts: null as number | null, exact: null as number | null },
} as const;
/** A day fails only below (exact − EXACT_TOLERANCE) exact-set posts */
export const EXACT_TOLERANCE = 2;
/** Pooled precision measured on the seven floored days after the fixes: 95.88% (3164/3300 tags), minus PRECISION_MARGIN (0.5 pp ≈ 16 tags). Blocks. */
export const POOLED_PRECISION_FLOOR = 0.9538;
export const PRECISION_MARGIN = 0.005;
/** Per-day precision below this only warns */
export const DAY_PRECISION_WARN = 0.94;
export type Day = keyof typeof DAY_FLOORS;

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));

export interface DayScore {
  day: Day;
  posts: number;
  /** Posts whose emitted set equals the desk's structural set */
  exactPosts: number;
  /** Emitted tags the desk also wrote / all emitted tags / all desk structural tags */
  tp: number;
  got: number;
  want: number;
  precision: number;
  recall: number;
  exact: number;
  /** Emitted tags the desk had not written, most frequent first */
  wrong: [string, number][];
}

const STRUCTURAL_EXTRA = new Set(["RajasthanWithFirstIndia", "FirstIndiaNews", "FINVideo", "RajasthanNews", "BreakingNews"]);
const isStructural = (tag: string, places: TagPlaces) => STRUCTURAL_EXTRA.has(tag) || tagPlace(tag, places) !== null || /^[A-Z][A-Za-z]+News$/.test(tag);

export function replayContext(): PostTagContext {
  const places = parseDistricts(cfg("districts.json"));
  const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
  // The places file's district tags are known-good normalisation targets, as in the worker
  const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));
  // The draft-side inference runs too, so a leak from it into the emitted run would show up as a score drop
  // "#जोधपुरन्यूज़" reads as "#JodhpurNews", as composeBreaking reads it (C-c)
  return { places, normaliser, inferDistrict: (headline) => inferHeadlineDistrict(book, headline)?.tag ?? null, leadTagDistrict: bookLeadTagDistrict(book), hindiPlace: hindiPlaceTag(book) };
}

export function scoreDay(day: Day, texts: readonly string[], ctx: PostTagContext = replayContext()): DayScore {
  let tp = 0, got = 0, want = 0, exact = 0;
  const wrong = new Map<string, number>();
  for (const text of texts) {
    const ours = new Set(composePostTags(text, ctx).trail);
    const s = segmentPost(text);
    const theirs = new Set([...s.trail, ...s.inline].map((t) => normaliseTag(t, ctx.normaliser).tag).filter((t) => isStructural(t, ctx.places)));
    for (const t of ours) {
      if (theirs.has(t)) tp++;
      else wrong.set(t, (wrong.get(t) ?? 0) + 1);
    }
    got += ours.size;
    want += theirs.size;
    if (ours.size === theirs.size && [...ours].every((t) => theirs.has(t))) exact++;
  }
  return {
    day, posts: texts.length, exactPosts: exact, tp, got, want,
    precision: got ? tp / got : 0, recall: want ? tp / want : 0, exact: texts.length ? exact / texts.length : 0,
    wrong: [...wrong].sort((a, b) => b[1] - a[1]),
  };
}

/** Where each day's export is, and whether it is there */
export function dayExports(env = process.env): { day: Day; path: string; present: boolean }[] {
  const explicit = new Map(
    (env.REPLAY_DAYS ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as [string, string];
    }),
  );
  const dir = env.REPLAY_EXPORTS_DIR ?? join(homedir(), "Downloads");
  return (Object.keys(DAY_FLOORS) as Day[]).map((day) => {
    const path = explicit.get(day) ?? join(dir, `1stIndiaNews_tweets_${DAY_FLOORS[day].date}.json`);
    return { day, path, present: existsSync(path) };
  });
}

/** A day that has a floor (its export was available when the table was measured) */
export const isFloored = (day: Day): boolean => DAY_FLOORS[day].exact !== null;

export interface ExportPost {
  text: string;
  /** Handles the export lists separately (v3 `handles_mentioned`, older `mentions`); empty when it lists none */
  handles: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The posts of one export. Untrusted: only the post text (`text`, or v3 `body`) and handle lists are read. */
export function readExportPosts(path: string): ExportPost[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as { tweets?: unknown; posts?: unknown } | unknown[];
  const list = (Array.isArray(j) ? j : ((j as { tweets?: unknown }).tweets ?? (j as { posts?: unknown }).posts)) as unknown;
  if (!Array.isArray(list)) throw new Error(`${path}: expected { "tweets": [...] }`);
  const out: ExportPost[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const t = item as { text?: unknown; body?: unknown; handles_mentioned?: unknown; mentions?: unknown };
    const text = typeof t.text === "string" ? t.text : typeof t.body === "string" ? t.body : null;
    if (text === null) continue;
    out.push({ text, handles: strings(t.handles_mentioned ?? t.mentions) });
  }
  return out;
}

/** The post texts of one export (schemas v1–v3) */
export const readExport = (path: string): string[] => readExportPosts(path).map((p) => p.text);

export const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** The lowest exact-set count a day may score without failing, or null when the day has no floor */
export const exactMinimum = (day: Day): number | null => {
  const e = DAY_FLOORS[day].exact;
  return e === null ? null : e - EXACT_TOLERANCE;
};

/** "oct30: at least 327 exact posts; failing below 325", or the no-floor note */
export function floorText(day: Day): string {
  const e = DAY_FLOORS[day].exact;
  return e === null ? `${day}: no floor yet (missing export)` : `${day}: at least ${e} exact posts; failing below ${e - EXACT_TOLERANCE}`;
}

/** One day's gate: exact-set below its count floor fails; precision below DAY_PRECISION_WARN only warns */
export function floorCheck(s: DayScore): { failures: string[]; warnings: string[] } {
  const min = exactMinimum(s.day);
  const failures = min !== null && s.exactPosts < min
    ? [`exact-set ${s.exactPosts}/${s.posts} posts < ${min} (floor ${DAY_FLOORS[s.day].exact} − ${EXACT_TOLERANCE})`]
    : [];
  const warnings = s.precision < DAY_PRECISION_WARN ? [`precision ${pct(s.precision)} < ${pct(DAY_PRECISION_WARN)}`] : [];
  const expected = DAY_FLOORS[s.day].posts;
  if (expected !== null && expected !== s.posts) warnings.push(`export has ${s.posts} posts, the floor was measured on ${expected}`);
  return { failures, warnings };
}

export interface PooledScore { days: Day[]; tp: number; got: number; precision: number }

/** Precision over the tags of all the given days combined (only floored days count toward the gate) */
export function poolPrecision(scores: readonly DayScore[]): PooledScore {
  const floored = scores.filter((s) => isFloored(s.day));
  const tp = floored.reduce((a, s) => a + s.tp, 0);
  const got = floored.reduce((a, s) => a + s.got, 0);
  return { days: floored.map((s) => s.day), tp, got, precision: got ? tp / got : 0 };
}

/**
 * The pooled precision gate. Blocks when every floored day is present (the set the floor was measured on), or
 * always with REPLAY_STRICT=1; on a subset of days it only warns, since a subset is not the measured population.
 */
export function pooledCheck(p: PooledScore, env = process.env): { failures: string[]; warnings: string[] } {
  if (p.precision >= POOLED_PRECISION_FLOOR) return { failures: [], warnings: [] };
  const msg = `pooled precision ${pct(p.precision)} (${p.tp}/${p.got} tags, ${p.days.length} days) < floor ${pct(POOLED_PRECISION_FLOOR)}`;
  const allFloored = (Object.keys(DAY_FLOORS) as Day[]).filter(isFloored).every((d) => p.days.includes(d));
  return allFloored || env.REPLAY_STRICT === "1" ? { failures: [msg], warnings: [] } : { failures: [], warnings: [`${msg} (subset of days: warning only)`] };
}

if (process.argv[1]?.endsWith("day-replay.ts")) {
  const ctx = replayContext();
  const strict = process.env.REPLAY_STRICT === "1";
  let failed = false;
  const scores: DayScore[] = [];
  for (const { day, path, present } of dayExports()) {
    if (!present) {
      const missingFails = strict && isFloored(day);
      console.log(`${day}  SKIPPED: missing export at ${path}${isFloored(day) ? "" : " (no floor yet; TODO add when the export arrives)"}${missingFails ? "  FAIL (REPLAY_STRICT=1)" : ""}`);
      if (missingFails) failed = true;
      continue;
    }
    const s = scoreDay(day, readExport(path), ctx);
    scores.push(s);
    const { failures, warnings } = floorCheck(s);
    if (failures.length) failed = true;
    const min = exactMinimum(day);
    console.log(
      `${day}  ${String(s.posts).padStart(4)} posts  exact ${String(s.exactPosts).padStart(4)} (${pct(s.exact)}; ` +
      (min === null ? "no floor" : `floor ${DAY_FLOORS[day].exact}, fail < ${min}`) +
      `)  precision ${pct(s.precision)} (${s.tp}/${s.got})  recall ${pct(s.recall)}  ` +
      (failures.length ? `FAIL: ${failures.join("; ")}` : "ok") + (warnings.length ? `  WARNING: ${warnings.join("; ")}` : ""),
    );
    if (s.wrong.length) console.log(`       emitted, not the desk's: ${s.wrong.slice(0, 6).map(([t, c]) => `#${t}×${c}`).join(" ")}`);
  }
  const pooled = poolPrecision(scores);
  const pc = pooledCheck(pooled);
  if (pc.failures.length) failed = true;
  console.log(
    `POOLED  ${pooled.days.length} floored days  precision ${pct(pooled.precision)} (${pooled.tp}/${pooled.got}; floor ${pct(POOLED_PRECISION_FLOOR)})  ` +
    (pc.failures.length ? `FAIL: ${pc.failures.join("; ")}` : "ok") + (pc.warnings.length ? `  WARNING: ${pc.warnings.join("; ")}` : ""),
  );
  process.exit(failed ? 1 : 0);
}
