// The replay gate (fix prompt FL2–FL4). One test per capture day plus one pooled-precision test. A day whose
// export is not on this machine is SKIPPED with its path in the test name — it never passes silently — and
// REPLAY_STRICT=1 makes a missing FLOORED day fail. A day with no floor yet (none since nov13 got one on 14 Nov) is skipped with a "missing
// export" note. Exact-set floors are post counts with a tolerance and always fail; per-day precision only warns;
// pooled precision blocks. Floors and where the exports are: see day-replay.ts.

import { describe, expect, it } from "vitest";
import {
  DAY_FLOORS, DAY_PRECISION_WARN, POOLED_PRECISION_FLOOR, dayExports, floorCheck, floorText, isFloored, pct, poolPrecision,
  pooledCheck, readExport, readExportPosts, replayContext, scoreDay, type DayScore,
} from "./day-replay";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strict = process.env.REPLAY_STRICT === "1";
const ctx = replayContext();
const scores: DayScore[] = [];

describe("replay gate: every capture day at or above its own floor", () => {
  it("the replay set is 8 days", () => {
    expect(Object.keys(DAY_FLOORS)).toEqual(["sep09", "oct20", "oct21", "oct30", "nov10", "nov11", "nov12", "nov13"]);
  });

  for (const { day, path, present } of dayExports()) {
    const floor = `${floorText(day)}; precision warns < ${pct(DAY_PRECISION_WARN)}`;
    if (!present) {
      if (strict && isFloored(day)) it(`${day}: export MISSING at ${path} (REPLAY_STRICT=1)`, () => expect.fail(`no export for ${day} at ${path}`));
      else it.skip(`${day}: SKIPPED — missing export at ${path} (${floor})`, () => undefined);
      continue;
    }
    // Scored while the tests are collected, so a precision WARNING is in the test's own name: vitest hides the
    // console output of a passing test
    const score = scoreDay(day, readExport(path), ctx);
    scores.push(score);
    const { failures, warnings } = floorCheck(score);
    const numbers = `${score.posts} posts, exact ${score.exactPosts} (${pct(score.exact)}), precision ${pct(score.precision)}, recall ${pct(score.recall)}`;
    const warned = warnings.length ? ` — WARNING: ${warnings.join("; ")}` : "";
    it(`${day}: ${floor} — ${numbers}${warned}`, () => {
      for (const w of warnings) console.warn(`WARNING ${day}: ${w}`);
      expect(score.posts).toBeGreaterThan(0);
      expect(failures, `${day} below its floor`).toEqual([]);
    });
  }

  // Collected after the per-day scores above, so it pools exactly the days that were present
  const pooled = poolPrecision(scores);
  const pc = pooledCheck(pooled);
  if (pooled.got === 0) it.skip(`pooled precision: SKIPPED — no floored day's export present (floor ${pct(POOLED_PRECISION_FLOOR)})`, () => undefined);
  else {
    const warned = pc.warnings.length ? ` — WARNING: ${pc.warnings.join("; ")}` : "";
    it(`pooled precision ≥ ${pct(POOLED_PRECISION_FLOOR)} — ${pct(pooled.precision)} (${pooled.tp}/${pooled.got} tags, ${pooled.days.join(" ")})${warned}`, () => {
      expect(pc.failures).toEqual([]);
    });
  }
});

describe("replay harness mechanics", () => {
  const dir = mkdtempSync(join(tmpdir(), "day-replay-"));
  const write = (name: string, j: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(j)); return p; };

  it("reads schema v3 exports: text in `body`, handles in `handles_mentioned`", () => {
    const p = write("v3.json", { account: "x", tweets: [
      { id: "1", body: "खबर #Jaipur #RajasthanWithFirstIndia @a_b", hashtags: ["#Jaipur"], handles_mentioned: ["@a_b"] },
      { id: "2", body: 7 },
      null,
    ] });
    expect(readExportPosts(p)).toEqual([{ text: "खबर #Jaipur #RajasthanWithFirstIndia @a_b", handles: ["@a_b"] }]);
    expect(readExport(p)).toEqual(["खबर #Jaipur #RajasthanWithFirstIndia @a_b"]);
  });

  it("still reads v1/v2 exports (`text`, `mentions`) and bare arrays", () => {
    expect(readExportPosts(write("v2.json", { tweets: [{ text: "a #Kota", mentions: ["@k"] }] }))).toEqual([{ text: "a #Kota", handles: ["@k"] }]);
    expect(readExport(write("arr.json", [{ text: "b" }]))).toEqual(["b"]);
  });

  it("REPLAY_DAYS overrides one day; the rest come from REPLAY_EXPORTS_DIR", () => {
    const p = write("custom.json", { tweets: [] });
    const env = { REPLAY_DAYS: `nov12=${p}`, REPLAY_EXPORTS_DIR: dir };
    const byDay = new Map(dayExports(env).map((d) => [d.day, d]));
    expect(byDay.get("nov12")).toEqual({ day: "nov12", path: p, present: true });
    expect(byDay.get("nov13")).toEqual({ day: "nov13", path: join(dir, "1stIndiaNews_tweets_2026-11-13.json"), present: false });
  });

  const fake = (day: keyof typeof DAY_FLOORS, exactPosts: number, tp = 95, got = 100): DayScore =>
    ({ day, posts: DAY_FLOORS[day].posts ?? 10, exactPosts, tp, got, want: got, precision: tp / got, recall: 1, exact: 0, wrong: [] });

  it("exact-set floor is a post count with a tolerance of 2", () => {
    const e = DAY_FLOORS.oct30.exact!;
    expect(floorText("oct30")).toBe(`oct30: at least ${e} exact posts; failing below ${e - 2}`);
    expect(floorCheck(fake("oct30", e - 2)).failures).toEqual([]);
    expect(floorCheck(fake("oct30", e - 3)).failures).toHaveLength(1);
  });

  it("per-day precision below 94% only warns", () => {
    const r = floorCheck(fake("oct30", DAY_FLOORS.oct30.exact!, 90, 100));
    expect(r.failures).toEqual([]);
    expect(r.warnings.join()).toMatch(/precision 90\.00% < 94\.00%/);
  });

  it("nov13 is the eighth floored day: 35 posts, at least 32 exact, failing below 30", () => {
    expect(isFloored("nov13")).toBe(true);
    expect(DAY_FLOORS.nov13).toMatchObject({ posts: 35, exact: 32 });
    expect(floorCheck(fake("nov13", 30)).failures).toEqual([]);
    expect(floorCheck(fake("nov13", 29)).failures).toHaveLength(1);
  });

  it("pooled precision blocks on the full floored set, warns on a subset", () => {
    const all = (Object.keys(DAY_FLOORS) as (keyof typeof DAY_FLOORS)[]).filter(isFloored).map((d) => fake(d, 0, 90, 100));
    expect(pooledCheck(poolPrecision(all), {}).failures).toHaveLength(1);
    const sub = pooledCheck(poolPrecision(all.slice(0, 2)), {});
    expect(sub.failures).toEqual([]);
    expect(sub.warnings).toHaveLength(1);
    expect(pooledCheck(poolPrecision(all.slice(0, 2)), { REPLAY_STRICT: "1" }).failures).toHaveLength(1);
    // Every day is floored now, nov13 included, so every day enters the pool
    expect(poolPrecision([fake("nov13", 0, 0, 100)]).got).toBe(100);
  });
});
