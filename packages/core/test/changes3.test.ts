// Changes #3 (13 Nov) and its final answers (15 Nov): the hashtag and handle logic, and the Extracted sheet.
//   Step 1  config: Kamalkant and Kasana's districts, the Baran and Pratapgarh alternates, Kharra's seat, Shubham Jain
//   Step 2  §2.1 party_of_leader: a Congress leader on the draft offers @INCRajasthan (never tags it)
//   Step 3  §2.2 district_when_missing for Shivendra, Kamalkant, Yogesh (Jaipur) and Bhanwar (Kota): Part 3's examples
//   Step 4  the 13 sheet handles the desk used on 2+ posts; pending-handles.json, which nothing loads
// Step 5 (the hashtags) is in changes3-hashtags.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, districtKey, parseBeatHandles, parseBreaking, parseHandleRules, parseHashtagNormalise, parsePartyHandles,
  parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules, pickReporter, slotFromTags, type BreakingDraft,
} from "../src";

const cfgText = (f: string) => readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8");
const cfg = (f: string) => JSON.parse(cfgText(f));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
const AT = new Date("2026-11-13T08:00:00Z");

const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;

function draft(name: string, lines: string[], opts: { reporterPrior?: boolean } = {}): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, normaliser, suggestRules, beats, at: AT, ...opts },
  );
}

const lc = (h: string) => h.replace(/^@/, "").toLowerCase();
const emitted = (d: BreakingDraft) => d.handles.map((h) => lc(h.handle));
const offered = (d: BreakingDraft) => d.handleSuggestions.map((h) => lc(h.handle));
const everywhere = (d: BreakingDraft) => [...emitted(d), ...offered(d)];
const jaipur = rules.districts[districtKey("Jaipur")]!;

// ─── Step 1: config ──────────────────────────────────────────────────────────

describe("Changes #3 step 1: config", () => {
  const entry = (h: string) => (cfg("reporter-handles.json").entries as { handle: string }[]).find((e) => e.handle === h) as Record<string, unknown>;

  it("§1.3 Kamalkant's district is Jaipur only", () => {
    expect(entry("@vyaskamalkant").districts).toEqual(["Jaipur"]);
    expect(pickReporter("KAMALKANT", reporters).match?.districts).toEqual(["Jaipur"]);
  });

  it("Q2 Kasana: districts Jaipur, no policy, and a bureau reporter", () => {
    expect(entry("@DineshKasana15")).toMatchObject({ districts: ["Jaipur"], bureau: true });
    expect(entry("@DineshKasana15").policy).toBeUndefined();
    expect(String(entry("@DineshKasana15").note)).toMatch(/special correspondent/i);
    expect(pickReporter("DINESH_KASANA", reporters).match).toMatchObject({ handle: "DineshKasana15", districts: ["Jaipur"], bureau: true });
  });

  it("Q2 Kasana: no #Jaipur: is ever added, not even when his file carries the Jaipur code", () => {
    for (const code of ["", "JPR3"]) {
      const d = draft(fileFor("DINESH_KASANA", code), ["जेडीए ने जारी किए नए आदेश", "सभी जोन में लागू होंगे नियम"]);
      expect(d.bodyText.startsWith("#")).toBe(false);
      expect(d.districtSource).toBeNull();
      expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
      // Nor is Jaipur offered on his behalf: his file code and his district say where he sits, not where the story is
      expect(d.hashtagSuggestionItems.some((t) => t.source.startsWith("district.") && t.tag === "#Jaipur")).toBe(false);
    }
  });

  it("Q2 a bureau reporter: a district_when_missing policy beside it rejects the entry; a non-boolean bureau too", () => {
    const base = { handle: "@x_reporter", handle_type: "person", names_en: ["XREP"], districts: ["Jaipur"], verified: true };
    for (const bad of [{ ...base, bureau: true, policy: { district_when_missing: "Jaipur" } }, { ...base, bureau: "yes" }]) {
      const problems: string[] = [];
      const r = parseReporterHandles({ version: 1, entries: [bad] }, (m) => problems.push(m));
      expect(r.count).toBe(0);
      expect(problems.join(" ")).toMatch(/bureau/);
    }
  });

  it("Q1 Baran: @DcDmBaran is the only collector Socia picks; @DcDmBaran_ is a recognised alternate", () => {
    const baran = rules.districts[districtKey("Baran")]!;
    expect(baran.collector).toEqual(["DcDmBaran"]);
    expect(rules.all!.has("dcdmbaran_")).toBe(true);
    expect(rules.bound!.has("dcdmbaran_")).toBe(true);
    // Part 3: "Baran story → @DcDmBaran available under Baran"
    const d = draft(fileFor(null), ["#Baran: जिला कलेक्टर ने ली अधिकारियों की बैठक", "जिला प्रशासन ने दिए निर्देश, कलेक्टर ने किया निरीक्षण"]);
    expect(d.cls).toBe("administration");
    expect(emitted(d)).toEqual(["dcdmbaran"]);
    expect(everywhere(d)).not.toContain("dcdmbaran_");
  });

  it("Q4 Pratapgarh: @PratapgrhPolice stays the only force; @pratapgarhpol is recognised, never picked, and adds no 'two police handles' warning", () => {
    const p = rules.districts[districtKey("Pratapgarh")]!;
    expect(p.police).toEqual(["PratapgrhPolice"]);
    expect(rules.all!.has("pratapgarhpol")).toBe(true);
    expect(rules.bound!.has("pratapgarhpol")).toBe(true);
    const d = draft(fileFor(null), ["#Pratapgarh: दीपावली की रात फायरिंग कर जानलेवा हमला करने वाले 4 आरोपी गिरफ्तार", "नीमच नाके पर युवक पर की थी फायरिंग"]);
    expect(emitted(d)).toEqual(["pratapgrhpolice"]);
    expect(everywhere(d)).not.toContain("pratapgarhpol");
    expect(d.warnings.join(" ")).not.toMatch(/police handles/);
  });

  it("Q1/Q4 an alternate that is not true or false rejects the file (never a silent pick)", () => {
    const bad = { version: 2, state: [], districts: { Baran: [{ handle: "@DcDmBaran_", handle_type: "district", role: "collector", verified: true, alternate: "yes" }] } };
    expect(() => parseHandleRules(bad)).toThrow(/alternate/);
  });

  it("§1.5 Kharra's seat is Srimadhopur in Sikar district, and he stays suggest-only", () => {
    const k = (cfg("party-handles.json").entries as Record<string, unknown>[]).find((e) => e.handle === "@officialkharra")!;
    expect(String(k.note)).toMatch(/Srimadhopur, Sikar district/);
    expect(k.scope).toBe("mla");
    const d = draft(fileFor(null), ["#Jaipur: यूडीएच मंत्री झाबर सिंह खर्रा ने किया निरीक्षण", "अधिकारियों को दिए निर्देश"]);
    expect(emitted(d)).not.toContain("officialkharra");
  });

  it("Q8 Shubham Jain: in the file, unverified, Ajmer, no policy, never a bare SHUBHAM; not tagged until confirmed", () => {
    expect(entry("@shubhamjain8824")).toMatchObject({ verified: false, districts: ["Ajmer"], names_en: ["shubham_jain", "SHUBHAM_JAIN"] });
    expect(entry("@shubhamjain8824").policy).toBeUndefined();
    expect(reporters.handles!.has("shubhamjain8824")).toBe(true);
    expect(pickReporter("SHUBHAM_JAIN", reporters).match).toBeNull();
    expect(pickReporter("SHUBHAM", reporters).match).toBeNull();
  });

  it("Part 3: a file-name token 'dinesh' alone tags no reporter (contested)", () => {
    const r = pickReporter("DINESH", reporters);
    expect(r.match).toBeNull();
    expect(r.collision).toBe("DINESH");
  });
});
