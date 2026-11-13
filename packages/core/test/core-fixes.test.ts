// The core fix batch of 13 Nov 2026 (R2–R4, S1–S4, O1–O3): one describe per fix, each pinned with the copy that
// showed it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_RAJASTHAN, PlaceBook, composeBreaking, isHeadlineLabel, parseBeatHandles, parseBreaking, parseHashtagNormalise, slotFromTags, type BreakingDraft, parseDistricts, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, reporterPrior } from "../src";
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
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));
void places;

/** A breaking file as the desk saves it: the name on line 1, then the headline and the points */
const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;
function draft(name: string, lines: string[], opts: { headlineLabels?: readonly string[] } = {}): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, normaliser, beats, ...opts },
  );
}
const RITURAJ = fileFor("RITURAJ");
const NARESH = fileFor("NARESH");
const policyFired = (d: BreakingDraft) => d.bodyText.startsWith("#Jaipur") || d.districtSource === "reporter_policy" || d.proposals.some((p) => p.source === "reporter_policy");

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

// ─── R2: "#<Place>News" blocks rituraj's #Jaipur ─────────────────────────────

describe("R2: a desk-written #<Place>News tag blocks the #Jaipur desk rule, like #<Place>", () => {
  it("#JodhpurNews in a point: no #Jaipur", () => {
    const d = draft(RITURAJ, ["ग्राम पंचायत में पुनर्मतदान", "मतपत्र चोरी और कानून-व्यवस्था बिगड़ने के चलते फैसला #JodhpurNews"]);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(policyFired(d)).toBe(false);
  });
  it("#DelhiNews, #BhopalNews (outside Rajasthan): no #Jaipur, and the footer is what it is without the rule", () => {
    for (const lines of [["केजरीवाल ने की प्रेस कॉन्फ्रेंस #DelhiNews", "भाजपा पर साधा निशाना"], ["मुख्यमंत्रियों की बैठक", "राज्यों के मंत्री शामिल हुए #BhopalNews"]]) {
      const d = draft(RITURAJ, lines);
      expect(d.bodyText, lines[0]).not.toContain("#Jaipur");
      expect(policyFired(d), lines[0]).toBe(false);
      expect(d.hashtags, lines[0]).toEqual(draft(NARESH, lines).hashtags);
    }
  });
  it("the Hindi form (#जोधपुरन्यूज़) and #Jodhpur_News block it too; a non-place #...News does not", () => {
    for (const tag of ["#जोधपुरन्यूज़", "#जोधपुरन्यूज", "#Jodhpur_News"]) {
      expect(policyFired(draft(RITURAJ, ["ग्राम पंचायत में पुनर्मतदान", `मतपत्र चोरी के चलते फैसला ${tag}`])), tag).toBe(false);
    }
    expect(draft(RITURAJ, ["ग्राम पंचायत में पुनर्मतदान", "मतपत्र चोरी के चलते फैसला #BreakingNews"]).bodyText.startsWith("#Jaipur: ")).toBe(true);
  });
});

// ─── R3 / O1: a place before the colon blocks it; a label does not ───────────

describe("R3: a place the desk wrote before the colon blocks the #Jaipur desk rule", () => {
  it("'रामपुरा खुर्द: ग्रामीणों का प्रदर्शन' (two words the places file does not know): no #Jaipur", () => {
    const d = draft(RITURAJ, ["रामपुरा खुर्द: ग्रामीणों का प्रदर्शन", "पानी की समस्या को लेकर जताया विरोध"]);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(policyFired(d)).toBe(false);
  });
  it("the parser still drops the unknown two-word prefix from the headline, for every reporter (unchanged, fixed later)", () => {
    for (const name of [RITURAJ, NARESH]) {
      const p = parseBreaking(fileText(name, ["रामपुरा खुर्द: ग्रामीणों का प्रदर्शन", "पानी की समस्या"]), name, book);
      expect([p.headline, p.town, p.district]).toEqual(["ग्रामीणों का प्रदर्शन", null, null]);
    }
    expect(draft(NARESH, ["रामपुरा खुर्द: ग्रामीणों का प्रदर्शन", "पानी की समस्या"]).bodyText.startsWith("ग्रामीणों का प्रदर्शन")).toBe(true);
  });
  it("composeBreaking without the parser (no rawHeadline) reads the headline's own prefix", () => {
    const d = composeBreaking({ headline: "रामपुरा खुर्द: ग्रामीणों का प्रदर्शन", points: ["पानी की समस्या"], district: null, town: null, rajasthan: true, leaderPost: false, reporterToken: "RITURAJ" }, rules, book, { subjects, reporters, parties });
    expect(policyFired(d)).toBe(false);
  });
});

describe("O1: a label before the colon is not a place: the desk rule still puts #Jaipur before it", () => {
  it("'बड़ी खबर:', 'पंचायत चुनाव:', 'ब्रेकिंग:', 'पंचायतीराज चुनाव 2026:' → '#Jaipur: <label>: ...'", () => {
    for (const h of ["बड़ी खबर: सरकार ने जारी किए नए आदेश", "पंचायत चुनाव: सुबह 10 बजे तक 20 प्रतिशत मतदान", "ब्रेकिंग: सरकार ने जारी किए नए आदेश", "पंचायतीराज चुनाव 2026: मतदान जारी"]) {
      const d = draft(RITURAJ, [h, "सभी विभागों को भेजे गए आदेश"]);
      expect(d.bodyText.startsWith(`#Jaipur: ${h}`), h).toBe(true);
      expect(d.districtSource, h).toBe("reporter_policy");
    }
  });
  it("the label list is configurable: a section label the parser reads as a place ('शिक्षा जगत:') blocks by default, not once it is listed", () => {
    const lines = ["शिक्षा जगत: नई शिक्षा नीति पर कार्यशाला", "शिक्षकों ने दिए सुझाव"];
    expect(policyFired(draft(RITURAJ, lines))).toBe(false);
    expect(policyFired(draft(RITURAJ, lines, { headlineLabels: ["जगत"] }))).toBe(true);
    expect(isHeadlineLabel("बड़ी खबर")).toBe(true);
    expect(isHeadlineLabel("BREAKING news")).toBe(true);
    expect(isHeadlineLabel("रामपुरा खुर्द")).toBe(false);
  });
  it("the footer never moves with the rule", () => {
    const lines = ["पंचायत चुनाव: सुबह 10 बजे तक 20 प्रतिशत मतदान", "मतदान केंद्रों पर लंबी कतारें"];
    expect(draft(RITURAJ, lines).hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(draft(RITURAJ, lines).hashtags).toEqual(draft(NARESH, lines).hashtags);
  });
});
