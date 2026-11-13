// The core fix batch of 13 Nov 2026 (R2–R4, S1–S4, O1–O3): one describe per fix, each pinned with the copy that
// showed it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaceBook, parseBeatHandles, parseDistricts, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, reporterPrior } from "../src";
import { WORD_CHAR, wholeWord } from "../src/breaking/syntax";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const places = parseDistricts(cfg("districts.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])].map((h) => h.toLowerCase()));
const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
void book;
void places;

// ─── R4: whole words in the beat keywords ────────────────────────────────────

describe("R4: a beat keyword matches whole words only", () => {
  const education = beats.beats.get("education")!.pattern;
  const tourism = beats.beats.get("tourism")!.pattern;

  it("the word-character class is a real Unicode class, not the letters p L M N", () => {
    expect(WORD_CHAR).toContain("\\p{L}");
    const w = new RegExp(WORD_CHAR, "u");
    for (const c of ["a", "Z", "क", "ि", "5", "‍"]) expect(w.test(c), c).toBe(true);
    for (const c of [" ", "{", "}", "-", ",", "।"]) expect(w.test(c), c).toBe(false);
  });

  it("बोर्ड never inside बोर्डिंग, छात्र never inside छात्रावास, Tourism never inside Tourismo", () => {
    expect(education.test("बोर्डिंग हाउस में आग")).toBe(false);
    expect(education.test("छात्रावास में खाना खराब")).toBe(false);
    expect(tourism.test("Tourismo festival in Italy")).toBe(false);
    // The whole words still match
    expect(education.test("बोर्ड परीक्षा का टाइम टेबल जारी")).toBe(true);
    expect(education.test("छात्र संघ चुनाव")).toBe(true);
    expect(tourism.test("Tourism Day पर कार्यक्रम")).toBe(true);
  });

  it("an English keyword next to p, l, m, n (or the braces the broken class held) still matches", () => {
    for (const t of ["Tourism policy जारी", "new Tourism plan", "{Tourism}", "lmn Tourism mnp"]) expect(tourism.test(t), t).toBe(true);
    expect(wholeWord("JDA", "iu").test("JDA meeting")).toBe(true);
    expect(wholeWord("JDA", "iu").test("pJDA")).toBe(false);
  });

  it("on the prior: a declared education beat is not offered for a boarding-house story", () => {
    const nirmalLike = { ...reporters.profiles!.get("rituraj9999")!, prior: null, beats: ["education"], beatsSource: "desk" as const };
    const districtBound = new Set<string>();
    const run = (text: string) => reporterPrior({ profile: nirmalLike, text, taken: new Set(), takenTags: new Set(), districtBound, directory }, reporters, beats).handles.filter((h) => h.reason === "beat").map((h) => h.handle);
    expect(run("बोर्डिंग हाउस में आग")).toEqual([]);
    expect(run("बोर्ड परीक्षा का परिणाम जारी").length).toBeGreaterThan(0);
  });
});
