// Live-vs-reference parity gate ("Done when" 3, see parity.ts). One test per replay day, never pooled.
//
// The day tests WARN by default (the numbers and the WARNING are in the test's name, since vitest hides a passing
// test's output) and FAIL with PARITY_STRICT=1. They warn by default because parity is not reached yet and the
// composers are still being changed; the integration step runs `PARITY_STRICT=1 npx vitest run test/parity.test.ts`.
// A day whose export is missing is SKIPPED with its path in the name. Exports: REPLAY_DAYS, as in parity.ts.
//
// The input reconstruction (postToTxt) is pinned by plain unit tests that always run.

import { describe, expect, it } from "vitest";
import { compareEmitted, liveEnv, parityDay, parityDays, postToTxt, readPosts, sameSet } from "./parity";
import { replayContext } from "./day-replay";

const strict = process.env.PARITY_STRICT === "1";

describe("postToTxt: a published post back to the desk's .txt", () => {
  it("drops the trailing tag-and-handle lines and keeps the leading run", () => {
    const post = "#Jodhpur #रावतभाटा: सड़क हादसे में दो घायल\n\nपहला बिंदु, दूसरा बिंदु...\n\n#RajasthanWithFirstIndia #RajasthanPolice @CP_Jodhpur https://t.co/x";
    expect(postToTxt(post)).toBe("#Jodhpur #रावतभाटा: सड़क हादसे में दो घायल\nपहला बिंदु, दूसरा बिंदु...");
  });
  it("drops a tag run typed at the end of the last body line, keeps tags inside the copy", () => {
    expect(postToTxt("जयपुर में #BJP की बैठक\nदूसरी पंक्ति #Jaipur #RajasthanWithFirstIndia")).toBe("जयपुर में #BJP की बैठक\nदूसरी पंक्ति");
  });
  it("keeps a one-line post's headline and drops its trailing run", () => {
    expect(postToTxt("उदयपुर पुलिस की बड़ी कार्रवाई #Udaipur #RajasthanWithFirstIndia")).toBe("उदयपुर पुलिस की बड़ी कार्रवाई");
  });
});

describe("compareEmitted", () => {
  const n = liveEnv().normaliser;
  it("is null for the same tags", () => {
    expect(compareEmitted({ lead: ["Jaipur"], trail: ["RajasthanWithFirstIndia"], handles: [] }, { lead: ["Jaipur"], trail: ["RajasthanWithFirstIndia"], handles: [] }, n)).toBeNull();
  });
  it("names a place that is in another slot, and the same set is still the same set", () => {
    const live = { lead: ["Jodhpur"], trail: ["RajasthanWithFirstIndia"], handles: [] };
    const ref = { lead: [], trail: ["Jodhpur", "RajasthanWithFirstIndia"], handles: [] };
    expect(compareEmitted(live, ref, n)?.causes).toEqual(["slot: live leads with the place, ref has it in the trailing run"]);
    expect(sameSet(live, ref, n)).toBe(true);
  });
  it("names a video post's missing #FINVideo and a brand difference", () => {
    const d = compareEmitted({ lead: [], trail: ["RajasthanWithFirstIndia"], handles: [] }, { lead: [], trail: ["FINVideo", "FirstIndiaNews"], handles: [] }, n);
    expect(d?.causes).toEqual(["brand: live RajasthanWithFirstIndia / ref FirstIndiaNews", "trail #FINVideo: ref only (video post)"]);
  });
});

describe("parity gate: the live path emits the reference's hashtags on every replay day", () => {
  const days = parityDays();
  const env = liveEnv();
  const ctx = replayContext();
  for (const { label, path, present } of days) {
    if (!present) {
      it.skip(`${label}: SKIPPED — no export at ${path}`, () => undefined);
      continue;
    }
    const r = parityDay(label, readPosts(path), env, ctx, 0);
    const handlesOk = r.handlesSame === r.handlesComparable;
    const ok = r.published.match === r.posts && handlesOk;
    const numbers = `${r.published.match}/${r.posts} identical vs ref(published), ${r.txt.match}/${r.posts} vs ref(txt); handles comparable on ${r.handlesComparable}, live emitted ${r.liveHandles} the reference has no answer for`;
    const warned = ok || strict ? "" : " — WARNING: not identical (PARITY_STRICT=1 makes it fail)";
    it(`${label}: ${numbers}${warned}`, () => {
      expect(r.posts).toBeGreaterThan(0);
      if (strict) {
        const top = [...r.published.causes].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, k]) => `${k}× ${c}`);
        expect(r.posts - r.published.match, `${label} differs on: ${top.join("; ")}`).toBe(0);
        expect(r.handlesSame).toBe(r.handlesComparable);
      }
    });
  }
});
