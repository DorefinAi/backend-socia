// The tag replay's scoring and gate helpers (packages/db/scripts/tag-replay.ts). Pure: no database, no data files.

import { describe, expect, it } from "vitest";
import {
  cardLeadsJaipur, cardMatchesLine1, cardPlaceName, compareToBaseline, expectedCards, headingKey, matchX, openingIsNotThePlace, outsidePlaces, tallyBySource, untagged, weightedLength, type Tally,
} from "../scripts/tag-replay";
import type { LoggedItemOutcome } from "../src/schema";

const O = (item: string, outcome: LoggedItemOutcome["outcome"], source: string, layer: LoggedItemOutcome["layer"] = "emit"): LoggedItemOutcome => ({
  item, kind: item.startsWith("@") ? "handle" : "hashtag", layer, source, outcome,
});

describe("weightedLength (G5, twitter-text v3)", () => {
  it("counts Devanagari and Latin as 1 per code point", () => {
    expect(weightedLength("दिल्ली")).toBe(6);
    expect(weightedLength("Jaipur: abc")).toBe(11);
  });
  it("counts other scripts and emoji as 2, a URL as 23", () => {
    expect(weightedLength("中文")).toBe(4);
    expect(weightedLength("🔥")).toBe(2);
    expect(weightedLength("see https://example.com/a/very/long/path/indeed")).toBe(4 + 23);
  });
  it("puts a 281-character post over the limit", () => {
    expect(weightedLength("क".repeat(280))).toBe(280);
    expect(weightedLength("क".repeat(281)) > 280).toBe(true);
  });
});

describe("card heading vs line 1 (G4: the desk's cards on X)", () => {
  const places = new Set(["#Kota", "#लाडपुरा", "#Jaipur", "#Khairthal", "#KhairthalTijara", "#UttarPradesh", "#Chittorgarh", "#भदेसर", "#KotputliBehror"]);
  const isPlace = (t: string) => places.has(t);
  const ok = (line1: string, card: string) => cardMatchesLine1(card, expectedCards(line1, isPlace));
  it("drops the tags' # and compares without spaces or hyphens", () => {
    expect(untagged("#Jaipur #बस्सी: पंचायती राज चुनाव")).toBe("Jaipur बस्सी: पंचायती राज चुनाव");
    expect(headingKey("Sawai Madhopur: x")).toBe(headingKey("SawaiMadhopur: x"));
    // a half nasal before a consonant is the anusvara (placeMatchKey): one place, two spellings
    expect(headingKey("निम्बाहेड़ा में शिविर")).toBe(headingKey("निंबाहेड़ा में शिविर"));
  });
  it("a lead run with a colon: the last place, then the rest", () => {
    expect(ok("#Kota #लाडपुरा: सड़क हादसा", "लाडपुरा: सड़क हादसा")).toBe(true);
    expect(ok("#Kota #लाडपुरा: सड़क हादसा", "Kota: सड़क हादसा")).toBe(false);
    expect(ok("#Jaipur: बड़ी खबर", "Jaipur: बड़ी खबर")).toBe(true);
    expect(ok("#Jaipur: #BJP की बैठक", "Jaipur: BJP की बैठक")).toBe(true);
  });
  it("writes Latin names as spoken and the desk's district names", () => {
    expect(expectedCards("#UttarPradesh: चुनाव", isPlace)).toEqual(["Uttar Pradesh: चुनाव"]);
    expect(expectedCards("#KhairthalTijara: बवाल", isPlace)).toEqual(["Khairthal: बवाल"]);
    expect(expectedCards("#KotputliBehror: x", isPlace)).toEqual(["Kotputli-Behror: x"]);
    expect(cardPlaceName("#Phalodi", { Phalodi: "Falodi" })).toBe("Falodi");
  });
  it("no lead place tag: line 1 itself, no prefix", () => {
    expect(ok("जोधपुर पुलिस कमिश्नरेट में साक्षात्कार", "जोधपुर पुलिस कमिश्नरेट में साक्षात्कार")).toBe(true);
    expect(ok("जोधपुर पुलिस कमिश्नरेट में साक्षात्कार", "Jodhpur: पुलिस कमिश्नरेट में साक्षात्कार")).toBe(false);
    expect(ok("#BJP: प्रदेश कार्यकारिणी", "BJP: प्रदेश कार्यकारिणी")).toBe(true);
  });
  it("a town tag standing for a word: the three forms the desk's cards show", () => {
    expect(ok("#Chittorgarh #भदेसर में गोशाला में आग", "भदेसर में गोशाला में आग")).toBe(true);
    expect(ok("#Chittorgarh #भदेसर में गोशाला में आग", "Chittorgarh: भदेसर में गोशाला में आग")).toBe(true);
    expect(ok("#Chittorgarh #भदेसर में गोशाला में आग", "Chittorgarh: गोशाला में आग")).toBe(false);
  });
  it("reads a Jaipur card lead in either script", () => {
    expect(cardLeadsJaipur("Jaipur: दिल्ली में जाम")).toBe(true);
    expect(cardLeadsJaipur("जयपुर : x")).toBe(true);
    expect(cardLeadsJaipur("Jaipur Metro: x")).toBe(false);
  });
});

describe("places outside Rajasthan (G2)", () => {
  it("finds states, cities and countries as whole words", () => {
    expect(outsidePlaces("आज दिल्ली में कई सड़कों पर रहेगा जाम")).toEqual(["दिल्ली"]);
    expect(outsidePlaces("नेपाल पीएम भारत दौरे पर")).toEqual(["नेपाल"]);
    expect(outsidePlaces("Rally in Punjab today")).toEqual(["Punjab"]);
  });
  it("reads a visarga used as a colon", () => {
    expect(outsidePlaces("गुजरातः जामनगर में पुलिस टीम पर हमला")).toEqual(["गुजरात", "जामनगर"]);
  });
  it("never matches inside a longer word", () => {
    expect(outsidePlaces("प्राचीन मंदिर में चोरी")).toEqual([]);
  });
  it("leaves out routes and city streets", () => {
    expect(outsidePlaces("दिल्ली-मुंबई एक्सप्रेसवे पर हादसा")).toEqual([]);
    expect(outsidePlaces("आगरा रोड पर जाम")).toEqual([]);
    expect(outsidePlaces("जयपुर-दिल्ली हाईवे")).toEqual([]);
  });
  it("keeps Delhi-NCR as a place", () => {
    expect(outsidePlaces("दिल्ली-NCR में हवा खराब")).toEqual(["दिल्ली-NCR"]);
  });
});

describe("the opening district (G3)", () => {
  it("is not the place when a road, a list or an office follows", () => {
    expect(openingIsNotThePlace(" हाईवे पर काल बनी नीलगाय")).toBe(true);
    expect(openingIsNotThePlace(" रोड पर हादसा")).toBe(true);
    expect(openingIsNotThePlace(", बारां और करौली में")).toBe(true);
    expect(openingIsNotThePlace(" सांसद का स्वागत")).toBe(true);
    expect(openingIsNotThePlace(" रेंज IG का दौरा")).toBe(true);
  });
  it("is the place otherwise", () => {
    expect(openingIsNotThePlace(" शहर के रामदेव टांका क्षेत्र में लगी आग")).toBe(false);
    expect(openingIsNotThePlace(" में 'ऑपरेशन प्रहार'")).toBe(false);
  });
});

describe("tallyBySource (itemOutcomes semantics)", () => {
  it("counts each outcome per source and keeps desk_added apart from the desk rule", () => {
    const t = tallyBySource([
      [O("#Jaipur", "kept", "district.file_code"), O("@jaipur_police", "removed", "district.police"), O("#ACB", "accepted", "campaign", "suggest")],
      [O("#Jaipur", "removed", "district.file_code"), O("@x", "kept", "desk"), O("@typed", "desk_added", "desk", null), O("#Typed", "desk_added", "desk", null)],
    ]);
    expect(t["district.file_code"]).toEqual({ kept: 1, removed: 1, accepted: 0, ignored: 0, added: 0 });
    expect(t["district.police"]!.removed).toBe(1);
    expect(t.campaign!.accepted).toBe(1);
    expect(t.desk).toEqual({ kept: 1, removed: 0, accepted: 0, ignored: 0, added: 0 });
    expect(t["(not offered) @"]!.added).toBe(1);
    expect(t["(not offered) #"]!.added).toBe(1);
  });
});

describe("compareToBaseline (G1)", () => {
  const T = (removed: number): Tally => ({ kept: 0, removed, accepted: 0, ignored: 0, added: 0 });
  it("flags a source whose removed count rose, not one that fell", () => {
    const { rises } = compareToBaseline({ campaign: T(5), party: T(1), "new.source": T(2) }, { campaign: T(4), party: T(3) }, new Map(), new Map());
    expect(rises.map((r) => r.source).sort()).toEqual(["campaign", "new.source"]);
  });
  it("lists every item the desk kept that is no longer kept, case-insensitively", () => {
    const base = new Map([["s1", { file: "a.txt", outcomes: [O("#Jaipur", "kept", "district.file_code"), O("@AlwarPolice", "kept", "district.police")] }]]);
    const now = new Map([["s1", { file: "a.txt", outcomes: [O("#jaipur", "kept", "district.file_code"), O("@AlwarPolice", "accepted", "district.police", "suggest")] }]]);
    const { keptLost } = compareToBaseline({}, {}, now, base);
    expect(keptLost).toEqual([{ id: "s1", file: "a.txt", item: "@AlwarPolice", source: "district.police", now: "accepted" }]);
  });
  it("fails a source only when its kept-lost count is over 0.5% of its baseline kept items", () => {
    const K = (kept: number): Tally => ({ kept, removed: 0, accepted: 0, ignored: 0, added: 0 });
    const story = (outcome: LoggedItemOutcome["outcome"]) => ({ file: "a.txt", outcomes: [O("@AlwarPolice", outcome, "district.police")] });
    const base = new Map([["s1", story("kept")]]);
    const now = new Map([["s1", story("removed")]]);
    // one lost of 400 kept (0.25%): a listed trade-off, not a failure
    expect(compareToBaseline({}, { "district.police": K(400) }, now, base).keptLostOver).toEqual([]);
    // one lost of 100 kept (1%): fails
    expect(compareToBaseline({}, { "district.police": K(100) }, now, base).keptLostOver).toEqual([{ source: "district.police", lost: 1, kept: 100 }]);
  });
});

describe("matchX (x-audit matcher)", () => {
  it("pairs each story with its own post and leaves an unrelated one alone", () => {
    const t0 = Date.parse("2026-11-23T10:00:00Z");
    const stories = [
      { ref: "#Jaipur: जयपुर में मेट्रो का नया रूट शुरू\n\nयात्रियों को मिली राहत, सुबह से चलेगी सेवा\n\n#RajasthanWithFirstIndia", ts: t0 },
      { ref: "#Kota: कोटा में कोचिंग छात्रों के लिए नई गाइडलाइन जारी\n\nप्रशासन ने दिए निर्देश\n\n#RajasthanWithFirstIndia", ts: t0 },
    ];
    const posts = [
      { url: "x/2", text: "कोटा में कोचिंग छात्रों के लिए नई गाइडलाइन जारी\n\nप्रशासन ने दिए निर्देश\n\n#RajasthanWithFirstIndia #Kota", ts: t0 + 5 * 60_000, video: false },
      { url: "x/1", text: "#Jaipur: जयपुर में मेट्रो का नया रूट शुरू\n\nयात्रियों को मिली राहत, सुबह से चलेगी सेवा\n\n#RajasthanWithFirstIndia", ts: t0 + 60_000, video: false },
      { url: "x/3", text: "बिल्कुल अलग खबर: मौसम विभाग का अलर्ट जारी", ts: t0, video: false },
    ];
    const m = matchX(stories, posts);
    expect(m.get(0)?.j).toBe(1);
    expect(m.get(1)?.j).toBe(0);
    expect(m.size).toBe(2);
  });
  it("never matches a video post or one outside the time window", () => {
    const t0 = Date.parse("2026-11-23T10:00:00Z");
    const ref = "#Jaipur: जयपुर में मेट्रो का नया रूट शुरू\n\nयात्रियों को मिली राहत";
    const m = matchX([{ ref, ts: t0 }], [
      { url: "v", text: ref, ts: t0, video: true },
      { url: "late", text: ref, ts: t0 + 11 * 3600_000, video: false },
    ]);
    expect(m.size).toBe(0);
  });
});
