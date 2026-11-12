// The per-day replay gate (b6 fix brief, Definition of done 3). One test per capture day, never pooled. A day
// whose export is not on this machine is SKIPPED with its path in the test name — it never passes silently —
// and REPLAY_STRICT=1 makes a missing day fail. A precision floor only warns until all six exports are present
// (or REPLAY_STRICT=1); exact-set floors always fail. Where the exports are: see day-replay.ts.

import { describe, expect, it } from "vitest";
import { DAY_FLOORS, PRECISION_FLOOR, dayExports, floorCheck, pct, precisionIsStrict, readExport, replayContext, scoreDay } from "./day-replay";

const strict = process.env.REPLAY_STRICT === "1";
const strictPrecision = precisionIsStrict();
const ctx = replayContext();

describe("replay gate: every capture day at or above its own floor", () => {
  for (const { day, path, present } of dayExports()) {
    const floor = `exact-set ≥ ${pct(DAY_FLOORS[day].exact)}, precision ≥ ${pct(PRECISION_FLOOR)}${strictPrecision ? "" : " (warning only)"}`;
    if (!present) {
      if (strict) it(`${day}: export MISSING at ${path} (REPLAY_STRICT=1)`, () => expect.fail(`no export for ${day} at ${path}`));
      else it.skip(`${day}: SKIPPED — no export at ${path} (${floor} not checked)`, () => undefined);
      continue;
    }
    // Scored while the tests are collected, so a precision WARNING is in the test's own name: vitest hides the
    // console output of a passing test
    const score = scoreDay(day, readExport(path), ctx);
    const { failures, warnings } = floorCheck(score, strictPrecision);
    const numbers = `${score.posts} posts, exact ${pct(score.exact)}, precision ${pct(score.precision)}, recall ${pct(score.recall)}`;
    const warned = warnings.length ? ` — WARNING: ${warnings.join("; ")} (not failing until all six exports are present; REPLAY_STRICT=1 makes it fail)` : "";
    it(`${day}: ${floor} — ${numbers}${warned}`, () => {
      for (const w of warnings) console.warn(`WARNING ${day}: ${w}`);
      expect(score.posts).toBeGreaterThan(0);
      expect(failures, `${day} below its floor`).toEqual([]);
    });
  }
});
