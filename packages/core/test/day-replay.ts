// Per-day replay gate (HASHTAG_HANDLE_CHANGES_v3 §6, b6 fix brief "Definition of done" 3).
//
// Scores the tags composePostTags() EMITS in the trailing run against the structural tags the desk really
// wrote, one capture day at a time, and fails when ANY day is below its own floor. The days are never pooled:
// a pooled average is what hid the last regression (one day's loss drowned in five days' gain).
//
// Scoring, as the change spec's reference composer (compose2.py) does it:
//   ours   = the emitted trailing run (lead is copied from the post, so scoring it would be circular)
//   theirs = the desk's trailing + inline tags, normalised, kept when STRUCTURAL: a place on districts.json
//            (either list), a brand, #FINVideo, any "#<Word>News", #RajasthanNews, #BreakingNews
//   exact  = ours and theirs are the same set; precision = |ours ∩ theirs| / |ours|
//
// Only `trail` is scored. `suggest` (inferred districts, campaign and keyword tags) is never on the post, so
// it can neither help nor hurt these numbers — which is exactly the property the gate protects.
//
// INPUT: one X export per day, `{ "tweets": [ { "text": ... }, ... ] }`, untrusted data, read only.
// Where they are: REPLAY_EXPORTS_DIR (default: the user's Downloads folder) holding
// 1stIndiaNews_tweets_<YYYY-MM-DD>.json, or REPLAY_DAYS="oct30=C:\path\a.json,nov10=C:\path\b.json".
// A day whose export is missing is SKIPPED AND SAID SO; REPLAY_STRICT=1 turns a missing day into a failure.
// Exact-set floors always fail; a precision floor only warns until all six exports are present (or REPLAY_STRICT=1).
//
// CLI: npx tsx test/day-replay.ts            (prints the table; exit 1 when a present day is below its floor)

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PlaceBook, parsePlacesData } from "../src/breaking/places";
import {
  composePostTags, normaliseTag, parseDistricts, parseHashtagNormalise, segmentPost, tagPlace,
  type PostTagContext, type TagPlaces,
} from "../src/breaking/post-tags";
import { inferHeadlineDistrict } from "../src/breaking/parse";

/** The change spec's per-day exact-set floors (§6). Raise one when a change genuinely improves it; never lower one quietly. */
export const DAY_FLOORS = {
  nov10: { date: "2026-11-10", exact: 0.855 },
  oct30: { date: "2026-10-30", exact: 0.818 },
  oct21: { date: "2026-10-21", exact: 0.787 },
  oct20: { date: "2026-10-20", exact: 0.742 },
  nov11: { date: "2026-11-11", exact: 0.674 },
  sep09: { date: "2026-09-09", exact: 0.649 },
} as const;
/** Every day, not pooled */
export const PRECISION_FLOOR = 0.94;
export type Day = keyof typeof DAY_FLOORS;

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));

export interface DayScore {
  day: Day;
  posts: number;
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
  return { places, normaliser, inferDistrict: (headline) => inferHeadlineDistrict(book, headline)?.tag ?? null };
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
    day, posts: texts.length, precision: got ? tp / got : 0, recall: want ? tp / want : 0, exact: texts.length ? exact / texts.length : 0,
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

/** The post texts of one export. Untrusted: only `text` strings are read. */
export function readExport(path: string): string[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as { tweets?: unknown; posts?: unknown } | unknown[];
  const list = (Array.isArray(j) ? j : ((j as { tweets?: unknown }).tweets ?? (j as { posts?: unknown }).posts)) as unknown;
  if (!Array.isArray(list)) throw new Error(`${path}: expected { "tweets": [...] }`);
  return list.map((t) => (t as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === "string");
}

export const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
/**
 * The floors a day misses, split by how they count. Exact-set is always a failure. Precision is a WARNING until
 * all six exports are here (user decision, 12 Nov: oct30 sits at 93.96% on main and after b7, one tag under the
 * floor, and the floor was set on the pooled six days); REPLAY_STRICT=1, or all six present, makes it a failure.
 */
export function floorCheck(s: DayScore, strictPrecision: boolean): { failures: string[]; warnings: string[] } {
  const exact = s.exact < DAY_FLOORS[s.day].exact ? [`exact-set ${pct(s.exact)} < floor ${pct(DAY_FLOORS[s.day].exact)}`] : [];
  const precision = s.precision < PRECISION_FLOOR ? [`precision ${pct(s.precision)} < floor ${pct(PRECISION_FLOOR)}`] : [];
  return strictPrecision ? { failures: [...exact, ...precision], warnings: [] } : { failures: exact, warnings: precision };
}

/** Precision is a hard floor with REPLAY_STRICT=1, or once every day's export is present */
export const precisionIsStrict = (env = process.env): boolean => env.REPLAY_STRICT === "1" || dayExports(env).every((d) => d.present);

if (process.argv[1]?.endsWith("day-replay.ts")) {
  const ctx = replayContext();
  const strict = precisionIsStrict();
  let failed = false;
  for (const { day, path, present } of dayExports()) {
    if (!present) {
      console.log(`${day}  SKIPPED: no export at ${path}`);
      if (process.env.REPLAY_STRICT === "1") failed = true;
      continue;
    }
    const s = scoreDay(day, readExport(path), ctx);
    const { failures, warnings } = floorCheck(s, strict);
    if (failures.length) failed = true;
    console.log(
      `${day}  ${String(s.posts).padStart(4)} posts  exact ${pct(s.exact)} (floor ${pct(DAY_FLOORS[day].exact)})  precision ${pct(s.precision)}  recall ${pct(s.recall)}  ` +
      (failures.length ? `FAIL: ${failures.join("; ")}` : "ok") + (warnings.length ? `  WARNING (not failing until all six days are here): ${warnings.join("; ")}` : ""),
    );
    if (s.wrong.length) console.log(`       emitted, not the desk's: ${s.wrong.slice(0, 6).map(([t, c]) => `#${t}×${c}`).join(" ")}`);
  }
  process.exit(failed ? 1 : 0);
}
