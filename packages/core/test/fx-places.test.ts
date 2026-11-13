// C-b and C-c of the 13 Nov fix prompt: a label is matched as a whole word, never part of a place's name; a Hindi
// "#<स्थान>न्यूज़" tag is a district tag, read the same on the live path and in the replay reference.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, composePostTags, deskPlacePrefix, headlineDistrictTags, hindiPlaceTag, inferHeadlineDistrict, isHeadlineLabel,
  notAPlace, parseBreaking, parseDistricts, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData, parseReporterHandles,
  parseSubjectHandles, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const places = parseDistricts(cfg("districts.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));

const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const fileFor = (token: string) => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${token}_BIG.txt`;
function draft(name: string, lines: string[]): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, normaliser },
  );
}
const RITURAJ = fileFor("RITURAJ");
const policyFired = (d: BreakingDraft) => d.bodyText.startsWith("#Jaipur") || d.districtSource === "reporter_policy" || d.proposals.some((p) => p.source === "reporter_policy");

/** The replay reference with rituraj's desk rule, as day-replay.ts and the O3 tests build it */
const ctx = {
  places, normaliser, reporterPolicy: "Jaipur",
  inferDistrict: (h: string) => inferHeadlineDistrict(book, h)?.tag ?? null,
  deskPlacePrefix: (h: string) => { const p = deskPlacePrefix(book, h); return !!p && !isHeadlineLabel(p); },
  hindiPlace: hindiPlaceTag(book),
};
const refFires = (lines: string[], c: typeof ctx | Omit<typeof ctx, "hindiPlace"> = ctx) => composePostTags(`${lines.join("\n\n")}\n\n#RajasthanWithFirstIndia`, c).policy === "emit";

// ─── C-b: whole words / whole labels ─────────────────────────────────────────

describe("C-b: a label word never matches inside a place's name", () => {
  it("notAPlace: 'बड़ागांव' and 'आगोलाई' are not the words 'बड़ा' / 'आग'; whole labels and joined label runs still are", () => {
    for (const w of ["बड़ागांव", "आगोलाई", "बड़ाखेड़ा", "रामपुरा खुर्द"]) expect(notAPlace(w), w).toBe(false);
    for (const w of ["बड़ी खबर", "बड़ा", "पंचायत चुनाव", "आग", "ब्रेकिंग", "बड़ीखबर", "ब्रेकिंगन्यूज़", "हत्याकांड", "चुनावी"]) expect(notAPlace(w), w).toBe(true);
  });

  it("isHeadlineLabel (decision O1) is per whole word", () => {
    for (const w of ["बड़ागांव", "आगोलाई", "बड़ाखेड़ा", "Newsroom", "Updates2"]) expect(isHeadlineLabel(w), w).toBe(false);
    for (const w of ["बड़ी खबर", "पंचायत चुनाव", "Breaking News", "ताजा अपडेट"]) expect(isHeadlineLabel(w), w).toBe(true);
  });

  it("'बड़ागांव: ग्रामीणों का प्रदर्शन' and 'आगोलाई: ...' are places: no #Jaipur, the desk's place kept as written", () => {
    for (const [place, rest] of [["बड़ागांव", "ग्रामीणों का प्रदर्शन"], ["आगोलाई", "पेयजल संकट पर ग्रामीणों का धरना"]] as const) {
      const d = draft(RITURAJ, [`${place}: ${rest}`, "पानी की समस्या को लेकर जताया विरोध"]);
      expect(policyFired(d), place).toBe(false);
      expect(d.bodyText, place).not.toContain("#Jaipur");
      expect(d.bodyText.startsWith(`#${place}: ${rest}`), d.bodyText).toBe(true);
      // The place is the desk's word, not a guess: it brings no district, no district handle, and the footer is unchanged
      expect(d.mentions.some((m) => /police|collector|dm_|sp_/i.test(m)), place).toBe(false);
      expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    }
  });

  it("'बड़ी खबर: ...' and 'पंचायत चुनाव: ...' are still labels: '#Jaipur: <label>: ...'", () => {
    for (const h of ["बड़ी खबर: सरकार ने जारी किए नए आदेश", "पंचायत चुनाव: सुबह 10 बजे तक 20 प्रतिशत मतदान"]) {
      const d = draft(RITURAJ, [h, "सभी विभागों को भेजे गए आदेश"]);
      expect(d.bodyText.startsWith(`#Jaipur: ${h}`), d.bodyText).toBe(true);
      expect(d.districtSource, h).toBe("reporter_policy");
    }
  });

  it("a hashtag town after its district: '#Jhalawar #बड़ागांव:' is a town; '#Jhalawar #बड़ीखबर:' is not a prefix", () => {
    const town = parseBreaking(fileText(RITURAJ, ["#Jhalawar #बड़ागांव: ग्रामीणों का प्रदर्शन", "पानी की समस्या"]), RITURAJ, book);
    expect([town.district, town.town, town.headline]).toEqual(["Jhalawar", "बड़ागांव", "ग्रामीणों का प्रदर्शन"]);
    const label = parseBreaking(fileText(RITURAJ, ["#Jhalawar #बड़ीखबर: ग्रामीणों का प्रदर्शन", "पानी की समस्या"]), RITURAJ, book);
    expect(label.town).toBeNull();
    expect(label.headline).toBe("#Jhalawar #बड़ीखबर: ग्रामीणों का प्रदर्शन");
  });

  it("a one-word place line 'बड़ागांव' is the town; 'बड़ी खबर' is not a place line", () => {
    expect(parseBreaking(fileText(RITURAJ, ["बड़ागांव", "ग्रामीणों का प्रदर्शन", "पानी की समस्या"]), RITURAJ, book).headline).toBe("ग्रामीणों का प्रदर्शन");
    expect(parseBreaking(fileText(RITURAJ, ["बड़ी खबर", "ग्रामीणों का प्रदर्शन", "पानी की समस्या"]), RITURAJ, book).headline).toBe("बड़ी खबर");
  });

  it("parity: the replay reference fires (or not) with composeBreaking on these prefixes", () => {
    for (const lines of [
      ["बड़ागांव: ग्रामीणों का प्रदर्शन", "पानी की समस्या"],
      ["आगोलाई: पेयजल संकट पर धरना", "पानी की समस्या"],
      ["बड़ी खबर: सरकार ने जारी किए नए आदेश", "सभी विभागों को भेजे गए आदेश"],
      ["पंचायत चुनाव: सुबह 10 बजे तक 20 प्रतिशत मतदान", "लंबी कतारें"],
    ]) {
      expect(refFires(lines), lines[0]).toBe(draft(RITURAJ, lines).districtSource === "reporter_policy");
    }
  });
});

// ─── C-c: "#जोधपुरन्यूज़" is a district tag ───────────────────────────────────

describe("C-c: a Hindi '#<स्थान>न्यूज़' tag is a district tag, like '#<Place>News'", () => {
  it("the headline's district tags read '#जोधपुरन्यूज़' and '#जोधपुरन्यूज' as Jodhpur, as '#JodhpurNews'", () => {
    for (const tag of ["#जोधपुरन्यूज़", "#जोधपुरन्यूज", "#JodhpurNews"]) {
      expect(headlineDistrictTags(book, `ग्राम पंचायत में पुनर्मतदान ${tag}`).map((d) => d.name), tag).toEqual(["Jodhpur"]);
    }
    // A Hindi news tag of a word that is no place, and a national place, are no Rajasthan district tag
    expect(headlineDistrictTags(book, "मौसम का हाल #ताजान्यूज़")).toEqual([]);
    expect(headlineDistrictTags(book, "प्रदूषण बढ़ा #दिल्लीन्यूज़")).toEqual([]);
  });

  it("parseBreaking: '#जोधपुरन्यूज़' in the headline states the district, the same as '#JodhpurNews'", () => {
    for (const tag of ["#जोधपुरन्यूज़", "#JodhpurNews"]) {
      const p = parseBreaking(fileText(RITURAJ, [`ग्राम पंचायत में पुनर्मतदान ${tag}`, "मतपत्र चोरी के चलते फैसला"]), RITURAJ, book);
      expect([p.district, p.districtFrom], tag).toEqual(["Jodhpur", "tag"]);
    }
  });

  it("composeBreaking: it blocks rituraj's #Jaipur and drafts exactly what '#JodhpurNews' drafts (line 1, handles, footer)", () => {
    const latin = draft(RITURAJ, ["ग्राम पंचायत में पुनर्मतदान #JodhpurNews", "मतपत्र चोरी के चलते फैसला"]);
    for (const tag of ["#जोधपुरन्यूज़", "#जोधपुरन्यूज"]) {
      const d = draft(RITURAJ, [`ग्राम पंचायत में पुनर्मतदान ${tag}`, "मतपत्र चोरी के चलते फैसला"]);
      expect(policyFired(d), tag).toBe(false);
      expect(d.bodyText.startsWith("#Jodhpur: "), d.bodyText).toBe(true);
      expect([d.districtSource, d.mentions, d.hashtags, d.hashtagSuggestions], tag).toEqual([latin.districtSource, latin.mentions, latin.hashtags, latin.hashtagSuggestions]);
    }
  });

  it("composeBreaking without the parser (the headline only): it still blocks the desk rule", () => {
    const d = composeBreaking({ headline: "ग्राम पंचायत में पुनर्मतदान #जोधपुरन्यूज़", points: ["मतपत्र चोरी के चलते फैसला"], district: null, town: null, rajasthan: true, leaderPost: false, reporterToken: "RITURAJ" }, rules, book, { subjects, reporters, parties });
    expect(policyFired(d)).toBe(false);
  });

  it("a tag is not a guess, but the text still is: 'जोधपुर में पुनर्मतदान' with no tag states no district", () => {
    const d = draft(RITURAJ, ["जोधपुर में पुनर्मतदान", "मतपत्र चोरी के चलते फैसला"]);
    expect(d.bodyText.startsWith("#Jodhpur")).toBe(false);
    expect(d.districtSource).not.toMatch(/^district\./);
  });

  it("the replay reference reads it identically: the desk rule is blocked in the headline and in a point", () => {
    const { hindiPlace: _drop, ...without } = ctx;
    for (const lines of [["ग्राम पंचायत में पुनर्मतदान #जोधपुरन्यूज़", "मतपत्र चोरी के चलते फैसला"], ["ग्राम पंचायत में पुनर्मतदान", "मतपत्र चोरी के चलते फैसला #जोधपुरन्यूज"]]) {
      expect(refFires(lines), lines.join(" | ")).toBe(false);
      expect(refFires(lines), lines.join(" | ")).toBe(draft(RITURAJ, lines).districtSource === "reporter_policy");
      // Without the places file the reference cannot read it (the gap this closes)
      expect(refFires(lines, without), lines.join(" | ")).toBe(true);
    }
  });

  it("the replay reference: a trailing '#जोधपुरन्यूज़' counts as '#JodhpurNews' (district slot and brand)", () => {
    const hi = composePostTags("ग्राम पंचायत में पुनर्मतदान\n\nमतपत्र चोरी के चलते फैसला\n\n#जोधपुरन्यूज़", ctx);
    const en = composePostTags("ग्राम पंचायत में पुनर्मतदान\n\nमतपत्र चोरी के चलते फैसला\n\n#JodhpurNews", ctx);
    expect([hi.district, hi.trail, hi.policy]).toEqual([en.district, en.trail, en.policy]);
    expect(hi.district).toBe("Jodhpur");
  });
});
