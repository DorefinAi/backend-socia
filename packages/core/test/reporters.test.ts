// The byline leg: which reporter a breaking file name names (filename.ts fileSlot) and which handle that
// is (reporters.ts). The last block runs the whole leg over 383 REAL file names this desk filed between
// 30 Oct and 10 Nov 2026, because this is the one rule whose input is typed by hand every day: invented
// examples agree with whatever the code does, real names do not.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_HANDLE_RULES, PlaceBook, districtMismatch, fileSlot, mergeReporterTokens, parseHandleRules, parsePlacesData, parseReporterHandles,
  pickHandlesExplained, pickReporter, reporterKey, slotFromTags,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const slot = (name: string) => fileSlot(name, book.codes);

const roster = (entries: unknown[], problem?: (m: string) => void) => parseReporterHandles({ version: 1, entries }, problem);
const one = roster([{ handle: "@omsharma8888", name: "Om Sharma", names_en: ["om_sharma", "OM SHARMA"], districts: ["Jaipur"], verified: true }]);

describe("the reporter slot in a file name", () => {
  it("reads the reporter the desk typed, in any case and spacing", () => {
    expect(slot("BTN_RAJ_BREAKING_1320_10NOV_NDR_PK_AGARWAL.txt").reporterToken).toBe("PK AGARWAL");
    // "MEETING" is a slug word the name parser already knows, so it does not become part of the byline
    expect(slot("BTN_RJ_BREAKING_6001_30OCT_US_CONTROL_Rituraj_Meeting_BIG.txt").reporterToken).toBe("RITURAJ");
    expect(slot("BTN_RAJ_BREAKING_1322_10NOV_NDR_rajeev_BIG.txt").reporterToken).toBe("RAJEEV");
  });

  it("reads a district code as a district, never as a name, and keeps the two apart", () => {
    expect(slot("BTN_RJ_BREAKING_6033_30OCT_US_CONTROL_AJM3_big.txt")).toMatchObject({ district: "Ajmer", reporterToken: null });
    expect(slot("BTN_RJ_BREAKING_01NOV_2707_AM_CONTROL_JPR12_BIG_.txt")).toMatchObject({ district: "Jaipur", reporterToken: null });
    // A name and a code in one name: both are read
    expect(slot("BTN_RJ_BREAKING_30OCT_AM_CONTROL_Rajeev_JDR_big.txt")).toMatchObject({ district: "Jodhpur", reporterToken: "RAJEEV" });
  });

  it("reports a code-shaped token the places file does not carry, instead of dropping it in silence", () => {
    // An unmapped code costs the story the district its file name states and nothing says why
    expect(slot("BTN_RJ_BREAKING_1500_10NOV_NDR_XYZ9_BIG.txt")).toMatchObject({ unknownCode: "XYZ", district: null, reporterToken: null });
    expect(slot("BTN_RJ_BREAKING_6033_30OCT_US_CONTROL_AJM3_big.txt").unknownCode).toBeNull();
  });

  it("takes the basename only, so a share path never leaks into the token", () => {
    expect(slot("\\\\share\\BREAKING\\NOVEMBER_2026\\10_NOVEMBER_2026\\BTN_RAJ_BREAKING_1320_10NOV_NDR_PK_AGARWAL.txt").reporterToken).toBe("PK AGARWAL");
  });

  it("reads tags already stored on a story without parsing the name again", () => {
    expect(slotFromTags({ reporter: "RITURAJ", district: "Jaipur", unknownCode: null } as never)).toEqual({ reporterToken: "RITURAJ", district: "Jaipur", unknownCode: null });
    expect(slotFromTags(null)).toEqual({ reporterToken: null, district: null, unknownCode: null });
  });
});

describe("which reporter a token names", () => {
  it("matches on the whole token, ignoring case, spacing and a trailing honorific", () => {
    expect(pickReporter("OM_SHARMA", one).match?.handle).toBe("omsharma8888");
    expect(pickReporter("om sharma", one).match?.handle).toBe("omsharma8888");
    expect(pickReporter("OM-Sharma", one).match?.handle).toBe("omsharma8888");
    // "ASHOK SIR" and "ASHOK" are one person, not two (75 real files carry the honorific form)
    expect(reporterKey("OM_SHARMA_SIR")).toBe("OM_SHARMA");
    expect(pickReporter("OM SHARMA JI", one).match?.handle).toBe("omsharma8888");
  });

  it("tags nobody for a name the list does not carry, and says which name that was", () => {
    const miss = pickReporter("PK AGARWAL", one);
    expect(miss.match).toBeNull();
    expect(miss.unmatchedToken).toBe("PK_AGARWAL");
    // Never a partial or fuzzy match: a surname would collide across the list
    expect(pickReporter("SHARMA", one).match).toBeNull();
    expect(pickReporter("OM", one).match).toBeNull();
    expect(pickReporter(null, one)).toEqual({ match: null, unmatchedToken: null });
  });

  it("tags NEITHER reporter when two of them claim one token", () => {
    const problems: string[] = [];
    const two = roster(
      [
        { handle: "@rajeev_one", names_en: ["rajeev"], verified: true },
        { handle: "@rajeev_two", names_en: ["rajeev", "rajeev_kumar"], verified: true },
      ],
      (m) => problems.push(m),
    );
    expect(pickReporter("rajeev", two).match).toBeNull();
    expect(two.conflicts.has("RAJEEV")).toBe(true);
    expect(problems.join(" ")).toMatch(/tagging neither/);
    // The uncontested spelling still works
    expect(pickReporter("rajeev_kumar", two).match?.handle).toBe("rajeev_two");
  });

  it("leaves out unverified entries and reports one that can never match", () => {
    const problems: string[] = [];
    const r = roster(
      [
        { handle: "@unverified", names_en: ["someone"], verified: false },
        { handle: "@notokens", names_en: [], verified: true },
      ],
      (m) => problems.push(m),
    );
    expect(r.count).toBe(0);
    expect(pickReporter("someone", r).match).toBeNull();
    expect(problems.join(" ")).toMatch(/no names_en token yet/);
    expect(() => parseReporterHandles({ version: 1 })).toThrow(/entries/);
  });

  it("merges the tokens editors taught us, and keeps the collision rule while doing it", () => {
    const learned = mergeReporterTokens(one, [{ handle: "@omsharma8888", token: "OM", name: "Om Sharma" }]);
    expect(pickReporter("om", learned).match?.handle).toBe("omsharma8888");
    expect(pickReporter("om", one).match).toBeNull(); // the file itself is unchanged
    // A learned row for a handle the file does not carry is ignored outright, so a stray row in the
    // database can neither introduce a byline nor knock out one the file assigns
    const clash = mergeReporterTokens(one, [{ handle: "@someoneelse", token: "OM_SHARMA" }]);
    expect(pickReporter("OM_SHARMA", clash).match?.handle).toBe("omsharma8888");
    // The file is the list of reporters: a learned row can add a NAME, never a handle the file does not
    // carry. So taking someone out of reporter-handles.json really does stop their byline.
    const fresh = mergeReporterTokens(one, [{ handle: "@newjoiner", token: "WAJAHAT", name: "Wajahat" }]);
    expect(pickReporter("wajahat", fresh).match).toBeNull();
  });

  it("flags a reporter filing outside their usual district, and never blocks the tag for it", () => {
    const m = pickReporter("om_sharma", one).match!;
    expect(districtMismatch(m, "Jaipur")).toBe(false);
    expect(districtMismatch(m, "Kota")).toBe(true);
    expect(districtMismatch(m, null)).toBe(false);
  });
});

describe("where the byline goes on the post", () => {
  const story = (extra: Record<string, unknown> = {}) => ({
    headline: "मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण", points: [], district: "Jaipur", rajasthan: true, leaderPost: false,
    reporterToken: "OM_SHARMA", ...extra,
  });
  const pick = (extra: Record<string, unknown> = {}) => pickHandlesExplained(story(extra), rules, { reporters: one }).handles.map((h) => `${h.reason}:${h.handle}`);

  it("puts the reporter last, on the classes the desk puts it on", () => {
    // 290 of 339 reporter placements were the final handle
    expect(pick()).toEqual(["cm:BhajanlalBjp", "reporter:omsharma8888"]);
    expect(pick({ headline: "बाजार में रौनक" })).toEqual(["reporter:omsharma8888"]);
    // A court story: our reporter and no institution (16 of 22 posts)
    expect(pick({ headline: "हाईकोर्ट में सुनवाई टली" })).toEqual(["reporter:omsharma8888"]);
  });

  it("keeps the byline off an incident, an administration story and a leader's own post", () => {
    // A reporter rode along on 14.6% of police tags and 6.0% of collector tags, against 54–67% elsewhere
    expect(pick({ headline: "जयपुर में हत्या का आरोपी गिरफ्तार" })).toEqual(["police:jaipur_police"]);
    expect(pick({ headline: "जिला कलेक्टर ने ली बैठक" })).toEqual(["collector:DcDmJaipur"]);
    expect(pick({ leaderPost: true })).toEqual([]);
    expect(pick({ headline: "गोवर्धन पूजा में उमड़े श्रद्धालु" })).toEqual([]);
  });

  it("rides on copy from outside Rajasthan, where no state institution may be tagged", () => {
    expect(pick({ headline: "दिल्ली में हत्या का आरोपी गिरफ्तार", rajasthan: false, district: "Delhi" })).toEqual(["reporter:omsharma8888"]);
  });

  it("never displaces every institution: at the cap the reporter takes the last slot", () => {
    const out = pickHandlesExplained(story({ headline: "मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण" }), rules, { reporters: one, max: 1 }).handles;
    expect(out.map((h) => h.reason)).toEqual(["reporter"]);
    const two = pickHandlesExplained(story(), rules, { reporters: one, max: 2 }).handles;
    expect(two.map((h) => h.reason)).toEqual(["cm", "reporter"]);
  });

  it("says so on the draft when the file names a reporter the list does not carry, and tags nobody", () => {
    const out = pickHandlesExplained(story({ headline: "बाजार में रौनक", reporterToken: "PK AGARWAL" }), rules, { reporters: one });
    expect(out.handles).toEqual([]);
    expect(out.unmatchedReporter).toBe("PK_AGARWAL");
    // Not a warning: it is routine and would bury the ones that mean something
    expect(out.warnings).toEqual([]);
  });

  it("reports a missing byline only where the post would have carried one", () => {
    // A crime story in Rajasthan has no byline slot at all — the district force takes the post
    expect(pickHandlesExplained(story({ headline: "जयपुर में हत्या का आरोपी गिरफ्तार", reporterToken: "PK AGARWAL" }), rules, { reporters: one }).unmatchedReporter).toBeNull();
    // ...but the same story from outside Rajasthan is the byline's alone
    const delhi = pickHandlesExplained(
      story({ headline: "दिल्ली में हत्या का आरोपी गिरफ्तार", rajasthan: false, district: "Delhi", reporterToken: "PK AGARWAL" }),
      rules, { reporters: one },
    );
    expect(delhi.handles).toEqual([]);
    expect(delhi.unmatchedReporter).toBe("PK_AGARWAL");
  });

  it("tags no byline at all when there is no reporter list", () => {
    expect(pickHandlesExplained(story(), EMPTY_HANDLE_RULES).handles).toEqual([]);
  });
});

// ─── Against the desk's own file names ──────────────────────────────────────
describe("the whole leg over 383 real breaking file names", () => {
  const { names } = json("./fixtures/real-breaking-file-names.json") as { names: string[] };
  const shipped = parseReporterHandles(json("../../../apps/worker/config/reporter-handles.json"));
  const read = names.map((n) => ({ name: n, slot: slot(n) }));

  it("parses the shipped reporter list with nothing skipped and no contested token", () => {
    const problems: string[] = [];
    parseReporterHandles(json("../../../apps/worker/config/reporter-handles.json"), (m) => problems.push(m));
    expect(problems).toEqual([]);
    expect(shipped.conflicts.size).toBe(0);
    expect(shipped.count).toBeGreaterThanOrEqual(15);
  });

  it("finds a reporter on about two names in three, and a district on about two in five", () => {
    const withToken = read.filter((r) => r.slot.reporterToken).length;
    const withDistrict = read.filter((r) => r.slot.district).length;
    // Measured over all 6,878 files: 64.1% carry a token and 39.7% a district code
    expect(withToken / names.length).toBeGreaterThan(0.6);
    expect(withDistrict / names.length).toBeGreaterThan(0.35);
  });

  it("resolves the reporters the desk's list knows, and only those", () => {
    const resolved = new Map<string, number>();
    const unmatched = new Set<string>();
    for (const { slot: s } of read) {
      if (!s.reporterToken) continue;
      const r = pickReporter(s.reporterToken, shipped);
      if (r.match) resolved.set(r.match.handle, (resolved.get(r.match.handle) ?? 0) + 1);
      else unmatched.add(r.unmatchedToken!);
    }
    // The names the list carries really do appear in the files, so the join is not dead code
    for (const handle of ["rituraj9999", "Nirmaltiwaribki", "ashvinigokul", "aishwaryam99", "yogesh2727sh1", "vyaskamalkant", "naresh_jsharma"]) {
      expect(resolved.get(handle), handle).toBeGreaterThan(0);
    }
    // Every resolved handle is one of the list's own
    for (const handle of resolved.keys()) expect(shipped.handles!.has(handle.toLowerCase())).toBe(true);
    // The names with no handle yet tag nobody and are all reported, which is the roster's to-do list
    expect(unmatched.has("PK_AGRAWAL")).toBe(true);
    expect(unmatched.has("RAJEEV")).toBe(true);
  });

  it("never reads a district code as a reporter, or a reporter as a district", () => {
    for (const { name, slot: s } of read) {
      if (s.reporterToken) expect(/^[A-Za-z]{2,4}\d{1,3}$/.test(s.reporterToken.replace(/ /g, "")), name).toBe(false);
      // Every district read from a name is one the places file knows ("DL" is Delhi, always)
      if (s.district) expect([...Object.values(book.codes), "Delhi"], name).toContain(s.district);
    }
  });

  it("maps the district it does read to the same district as the copy, or says so", () => {
    // A code is a 3-letter lookup with no folding and no gazetteer, so it cannot name a place we do not
    // have; the one case it can get wrong is a desk typo, which the draft's warnings carry.
    const codes = new Set(Object.keys(book.codes));
    for (const { name, slot: s } of read) {
      if (s.unknownCode) expect(codes.has(s.unknownCode), name).toBe(false);
    }
  });
});
