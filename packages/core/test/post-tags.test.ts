// HASHTAG_HANDLE_CHANGES_v3: the fixtures the spec pins (§6), each a real case a naive implementation gets
// wrong, plus the two real breaking files of 12 Nov 2026 that exposed the draft-side gaps (ACB, NSUI).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_NATIONAL, BRAND_RAJASTHAN, PlaceBook, composeBreaking, composePostTags, hashtagsIn, isVideoHeadline, normaliseTag, parseBreaking,
  parseDistricts, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles,
  parseSuggestRules, pickHandlesExplained, postFormat, resolveBrand, segmentPost, slotFromTags, suggestTags,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const places = parseDistricts(cfg("districts.json"));
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const ctx = { places, normaliser };

describe("URLs (§2.1)", () => {
  it("a trailing t.co link no longer turns the trailing run into inline tags", () => {
    const s = segmentPost("सड़क हादसे में दो की मौत\n\n#Dungarpur #RajasthanWithFirstIndia https://t.co/AbC123xyz");
    expect(s.trail).toEqual(["Dungarpur", "RajasthanWithFirstIndia"]);
    expect(s.inline).toEqual([]);
    expect(postFormat("सड़क हादसे में दो की मौत\n\n#Dungarpur #RajasthanWithFirstIndia https://t.co/AbC123xyz")).toBe("C");
  });
});

describe("video headline (§2.2)", () => {
  it("takes the danda attached to the word before it", () => {
    expect(isVideoHeadline("उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News")).toBe(true);
    expect(isVideoHeadline("Govardhan Puja 2026 | Rajasthan News")).toBe(true);
  });
  it("is not fooled by a Breaking News colon", () => {
    expect(isVideoHeadline("Breaking News: चमोली में भूस्खलन")).toBe(false);
    expect(postFormat("Breaking News: चमोली में भूस्खलन\n\n#FirstIndiaNews")).toBe("C");
  });
  it("emits #FINVideo first, then the brand; the district News tag and #RajasthanNews are only offered", () => {
    const t = composePostTags("जयपुर में दीपोत्सव | Rajasthan News\n\n#FINVideo #RajasthanWithFirstIndia #JaipurNews", ctx);
    expect(t.format).toBe("B");
    expect(t.trail).toEqual(["FINVideo", BRAND_RAJASTHAN]);
    expect(t.suggest).toEqual(expect.arrayContaining(["JaipurNews", "RajasthanNews"]));
  });
});

describe("normalisation (§2.7)", () => {
  it("corrects a known typo and flags it", () => {
    expect(normaliseTag("FINVido", normaliser)).toEqual({ tag: "FINVideo", flag: "#FINVido → #FINVideo" });
    expect(normaliseTag("RajasthanWithFirstInda", normaliser).tag).toBe(BRAND_RAJASTHAN);
  });
  it("flags, and does not correct, an unknown near-miss of a brand tag", () => {
    const n = normaliseTag("RajastanWithFirstIndia", normaliser);
    expect(n.tag).toBe("RajastanWithFirstIndia");
    expect(n.flag).toMatch(/looks like #RajasthanWithFirstIndia/);
  });
  it("runs before the video rule is scored", () => {
    const t = composePostTags("Diwali Mela 2026: रोशनी से जगमगाया शहर\n\n#FINVido #RajasthanWithFirstIndia", ctx);
    expect(t.trail[0]).toBe("FINVideo");
    expect(t.flags).toContain("#FINVido → #FINVideo");
  });
});

describe("hashtag characters (§2.6)", () => {
  it("reads accented Latin, and stops a Devanagari tag at the danda", () => {
    expect(hashtagsIn("बाढ़ से तबाही #Nariño #Colombia")).toEqual(["Nariño", "Colombia"]);
    expect(hashtagsIn("#जयपुर। आगे")).toEqual(["जयपुर"]);
    expect(segmentPost("बाढ़ से तबाही\n\n#Nariño #FirstIndiaNews").trail).toEqual(["Nariño", "FirstIndiaNews"]);
  });
});

describe("brand (§2.3)", () => {
  it("follows the leading slot, then any trailing slot, then Rajasthan-wide signals", () => {
    expect(resolveBrand({ lead: "Kota", video: false }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 1 });
    expect(resolveBrand({ lead: "Bihar", video: false }, places)).toMatchObject({ brand: BRAND_NATIONAL, step: 2 });
    expect(resolveBrand({ trail: ["BarmerNews"], video: true }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 3 });
    expect(resolveBrand({ trail: ["RajasthanHighCourt"], video: false }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 4 });
    expect(resolveBrand({ trail: ["Kolkata"], video: false }, places)).toMatchObject({ brand: BRAND_NATIONAL, step: 5 });
  });
  it("step 6: nothing resolved is Rajasthan on a video post and national otherwise (#आकोला is not a Latin slot)", () => {
    expect(resolveBrand({ lead: "आकोला", video: false }, places)).toMatchObject({ brand: BRAND_NATIONAL, step: 6 });
    expect(resolveBrand({ video: true }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 6 });
  });
  it("an unknown Latin leading tag is raised and NOT taken as outside Rajasthan", () => {
    const r = resolveBrand({ lead: "Jaipurr", trail: ["Jaipur"], video: false }, places);
    expect(r).toMatchObject({ brand: BRAND_RAJASTHAN, unknownDistrict: "Jaipurr" });
  });
});

describe("format C (§2.4, §2.5)", () => {
  it("emits an out-of-Rajasthan place too, district before brand", () => {
    const t = composePostTags("बिहार में चुनावी सभा\n\nनेताओं ने किया संबोधन\n\n#Bihar #FirstIndiaNews", ctx);
    expect(t.trail).toEqual(["Bihar", BRAND_NATIONAL]);
    const k = composePostTags("कोलकाता में आग\n\n#Kolkata #FirstIndiaNews", ctx);
    expect(k.trail).toEqual(["Kolkata", BRAND_NATIONAL]);
  });
  it("today's ACB post: #Dungarpur before the brand, and no #ACB invented", () => {
    const t = composePostTags("डूंगरपुर में ACB कार्रवाई\n\nACB ने झोतरी CHC के प्रभारी को किया ट्रैप\n\n#Dungarpur #RajasthanWithFirstIndia", {
      ...ctx, suggestRules, at: new Date("2026-11-12T08:00:00Z"),
    });
    expect(t.trail).toEqual(["Dungarpur", BRAND_RAJASTHAN]);
    expect(t.trail).not.toContain("ACB");
    expect(t.suggest).toContain("ACB");
  });
});

describe("district inference (§2.8)", () => {
  it("is only ever a suggestion", () => {
    const t = composePostTags("9 माह से कांग्रेस के छात्र संगठन NSUI का नहीं कोई धणी धोरी\n\n#RajasthanWithFirstIndia", { ...ctx, inferDistrict: () => "Jaipur" });
    expect(t.lead).toEqual([]);
    expect(t.trail).not.toContain("Jaipur");
    expect(t.suggest).toContain("Jaipur");
  });
});

describe("campaign windows (§5.4)", () => {
  it("are explicit dates, and outside them nothing is offered", () => {
    expect(suggestTags("पंचायत चुनाव में मतदान", suggestRules, new Date("2026-11-12T06:00:00Z"))).toContain("RajasthanPanchayatElection2026");
    expect(suggestTags("पंचायत चुनाव में मतदान", suggestRules, new Date("2027-02-01T06:00:00Z"))).not.toContain("RajasthanPanchayatElection2026");
  });
  it("refuse a campaign without dates", () => {
    const problems: string[] = [];
    parseSuggestRules({ entries: [{ tag: "X", pattern: "x", kind: "campaign" }] }, (m) => problems.push(m));
    expect(problems[0]).toMatch(/start.*end/);
  });
});

// ─── the draft side: the real breaking files of 12 Nov 2026 ───────────────────

const ACB_FILE = "BTN_RJ_BREAKING_6043_12NOV_US_NAVIN_JPR_BIG_FULL.txt";
const ACB_TEXT = "BTN_RJ_BREAKING_6043_12NOV_US_NAVIN_JPR_BIG_FULL\r\n\r\nडूंगरपुर में ACB  कार्रवाई\r\nACB ने झोतरी CHC के प्रभारी को किया ट्रैप \r\nप्रभारी डॉ.अमित को एक हजार रुपए की रिश्वत लेते दबोचा \r\nASP राजेन्द्र जैन ने दिया कार्रवाई को अंजाम \r\n";
const NSUI_FILE = "BTN_RJ_BREAKING_2113_12NOV_mh_CONTROL_Dinesh_Dangi_karari_big.txt";
const NSUI_TEXT = "BTN_RJ_BREAKING_2113_12NOV_mh_CONTROL_Dinesh_Dangi_karari_big\r\n\r\n9 माह से कांग्रेस के छात्र संगठन NSUI का नहीं कोई धणी धोरी\r\nविनोद जाखड़ के राष्ट्रीय अध्यक्ष बनने के बाद संगठन चल रहा है बिना कप्तान के\r\nऐसे में अब कार्यकारी प्रदेश अध्यक्ष बनाने का हो सकता फैसला\r\nशेखावाटी के तीन छात्र नेता कर रहे कार्यकारी अध्यक्ष के लिए Lobbying\r\nझुंझुनूं जिले के 2 युवा नेता लगा रहे है इसके लिए जोर\r\nदोनों नेता राजस्थान यूनिवर्सिटी छात्रसंघ अध्यक्ष का हार चुके चुनाव\r\n";

const draft = (text: string, file: string) => {
  const p = parseBreaking(text, file, book);
  const slot = slotFromTags(p.tags);
  return {
    p,
    d: composeBreaking(
      { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
      rules, book, { subjects, reporters, parties, normaliser, suggestRules, at: new Date("2026-11-12T08:00:00Z") },
    ),
  };
};

describe("12 Nov ACB file: the headline's district beats the filing desk's code", () => {
  it("is #Dungarpur, not #Jaipur, and offers #ACB without applying it", () => {
    const { p, d } = draft(ACB_TEXT, ACB_FILE);
    expect(p.district).toBe("Dungarpur");
    expect(d.bodyText.startsWith("#Dungarpur: ")).toBe(true);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(d.hashtagSuggestions).toContain("#ACB");
    expect(d.mentions).not.toContain("@jaipur_police");
  });
});

describe("12 Nov NSUI file: the organisation named outranks the one adjacent to it (§3.3)", () => {
  it("tags @NSUIRajasthan and the party, and only offers @UniRajOfficial", () => {
    const { d } = draft(NSUI_TEXT, NSUI_FILE);
    expect(d.mentions).toContain("@NSUIRajasthan");
    expect(d.mentions).toContain("@INCRajasthan");
    expect(d.mentions).not.toContain("@UniRajOfficial");
    expect(d.handleSuggestions.map((h) => h.handle)).toContain("UniRajOfficial");
  });
  it("without a district anywhere, the reporter's single district is offered, never put in line 1 (§2.8)", () => {
    const { d } = draft(NSUI_TEXT, NSUI_FILE);
    expect(d.bodyText.startsWith("#")).toBe(false);
    // Dinesh Dangi files for Jaipur and Delhi: two districts infer nothing
    expect(d.hashtagSuggestions.some((t) => t === "#Jaipur")).toBe(false);
  });
});

describe("handles", () => {
  const pick = (headline: string, points: string[], district: string | null = "Jaipur") =>
    pickHandlesExplained({ headline, points, district, rajasthan: true, leaderPost: false }, rules, { subjects, reporters, parties });

  it("§3.2: party copy at a police venue keeps the party and OFFERS the district police", () => {
    const r = pick("कांग्रेस कार्यकर्ताओं ने पुलिस कमिश्नरेट पर किया प्रदर्शन", ["पीसीसी चीफ गोविंद सिंह डोटासरा रहे मौजूद"]);
    expect(r.cls).toBe("political");
    expect(r.handles.map((h) => h.handle)).toContain("INCRajasthan");
    expect(r.handles.some((h) => h.reason === "police")).toBe(false);
    expect(r.suggestions.some((h) => h.reason === "police")).toBe(true);
  });
  it("§3.1: a district's electoral-roll story tags the CEO beside the collector", () => {
    const r = pick("जिले में प्रारूप मतदाता सूचियों का प्रकाशन", [], "Deeg");
    expect(r.handles.map((h) => h.handle)).toEqual(expect.arrayContaining(["DeegDm24013", "CeoRajasthan"]));
  });
  it("§3.1: a panchayat roll stays with the State Election Commission's routing, no CEO", () => {
    const r = pick("पंचायत चुनाव में मतदाता सूची से नाम हटाने का मामला", []);
    expect(r.handles.map((h) => h.handle)).not.toContain("CeoRajasthan");
  });
  it("§3.1: a leader attacking the roll revision is still political copy", () => {
    const r = pick("अशोक गहलोत ने मतदाता सूची पुनरीक्षण पर साधा निशाना", []);
    expect(r.cls).toBe("political");
  });
  it("§3.3: never returns a handle that is not in a data file", () => {
    const all = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
    for (const [h, p] of [
      ["9 माह से कांग्रेस के छात्र संगठन NSUI का नहीं कोई धणी धोरी", ["दोनों नेता राजस्थान यूनिवर्सिटी छात्रसंघ अध्यक्ष का हार चुके चुनाव"]],
      ["प्रारूप मतदाता सूची का प्रकाशन आज", []],
    ] as [string, string[]][]) {
      const r = pick(h, p);
      for (const x of [...r.handles, ...r.suggestions]) expect(all.has(x.handle.toLowerCase())).toBe(true);
    }
  });
});
