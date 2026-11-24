// The tag replay's scoring and gate helpers (packages/db/scripts/tag-replay.ts). Pure: no database, no data files.

import { describe, expect, it } from "vitest";
import {
  cardLeadsJaipur, compareToBaseline, headingKey, matchX, openingIsNotThePlace, outsidePlaces, tallyBySource, untagged, weightedLength, type Tally,
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

describe("card heading vs line 1 (G4)", () => {
  it("drops the tags' # and compares without spaces", () => {
    expect(untagged("#Jaipur #बस्सी: पंचायती राज चुनाव")).toBe("Jaipur बस्सी: पंचायती राज चुनाव");
    expect(headingKey("Jaipur: बड़ी खबर")).toBe(headingKey(untagged("#Jaipur: बड़ी खबर")));
    expect(headingKey("Sawai Madhopur: x")).toBe(headingKey(untagged("#SawaiMadhopur: x")));
  });
  it("tells a card that shows only the town from a two-tag line 1", () => {
    expect(headingKey("बस्सी: पंचायती राज चुनाव")).not.toBe(headingKey(untagged("#Jaipur #बस्सी: पंचायती राज चुनाव")));
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
