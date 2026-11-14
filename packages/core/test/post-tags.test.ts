// HASHTAG_HANDLE_CHANGES_v3: the fixtures the spec pins (§6), each a real case a naive implementation gets
// wrong, plus the two real breaking files of 12 Nov 2026 that exposed the draft-side gaps (ACB, NSUI).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_NATIONAL, BRAND_RAJASTHAN, DataFileRejected, PlaceBook, attackTargets, composeBreaking, composePostTags, emittable, hashtagsIn,
  inferHeadlineDistrict, isVideoHeadline, normaliseTag, parseBreaking, parseDistricts, parseHandleRules, parseHashtagNormalise,
  parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules, pickHandlesExplained, pickReporter,
  postFormat, recoverDistrictFrom, resolveBrand, segmentPost, slotFromTags, storyDistrict, suggestTags,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const places = parseDistricts(cfg("districts.json"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const placeTags = book.districts.map((d) => d.tag);
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, placeTags);
const suggestRules = parseSuggestRules(cfg("campaigns.json"));
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

  // FL1: the spellings the desk actually wrote in the replay exports (Sep–Nov 2026)
  const fixed = (typos: string[], to: string) => {
    for (const typo of typos) expect(normaliseTag(typo, normaliser), typo).toEqual({ tag: to, flag: `#${typo} → #${to}` });
  };
  it("FL1: the desk's Rajasthan-brand typos become #RajasthanWithFirstIndia", () => {
    fixed([
      "RajasthnaWithFirstIndia", "RajastahnWithFirstIndia", "RajasthanwithFirstIndia", "RajasthanWithFristIndia",
      "RajasthaWithFirstIndia", "RajashanWithFirstIndia", "RajsthanWithFirstIndia", "RajasthanWithFirstndia",
      "RajathanWithFirstIndia", "RajasthanWthFirstIndia", "RajasthanWithFIrstIndia", "RjasthanWithFirstIndia",
    ], BRAND_RAJASTHAN);
  });
  it("FL1: the desk's national-brand and video typos", () => {
    fixed(["FirstIndianews"], BRAND_NATIONAL);
    fixed(["FINVIdeo", "FINVieo", "FINViedo"], "FINVideo");
  });
  it("FL1: the desk's district and place typos", () => {
    fixed(["Dhiolpur"], "Dholpur");
    fixed(["Chittirgarh"], "Chittorgarh");
    fixed(["Jaislamer"], "Jaisalmer");
    fixed(["Rajsamnd"], "Rajsamand");
    fixed(["Dehi"], "Delhi");
    fixed(["SawaimadhopurNews"], "SawaiMadhopurNews");
  });
  it("FL1: a misspelt lead district and brand are corrected in the composed run", () => {
    const t = composePostTags("#Jaislamer: नगर निगम की बैठक में हंगामा\n\n#RajasthnaWithFirstIndia", ctx);
    expect([t.district, t.lead, t.trail]).toEqual(["Jaisalmer", ["Jaisalmer"], [BRAND_RAJASTHAN]]);
    expect(t.flags).toEqual(["#RajasthnaWithFirstIndia → #RajasthanWithFirstIndia", "#Jaislamer → #Jaisalmer"]);
  });
  it("FL1: a misspelt video tag on a video headline is corrected", () => {
    const t = composePostTags("नगर निगम की बैठक में हंगामा | Jaisalmer News\n\n#FINVieo #RajasthnaWithFirstIndia #Jaislamer", ctx);
    expect(t.trail).toEqual(["FINVideo", BRAND_RAJASTHAN]);
    expect(t.flags).toContain("#FINVieo → #FINVideo");
  });
  it("FL1: the shipped table loads whole, every target known-good", () => {
    expect(() => parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, placeTags)).not.toThrow();
    expect(normaliser.variants.size).toBeGreaterThanOrEqual(33);
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
  it("refuse a campaign without dates: the whole file is rejected", () => {
    const problems: string[] = [];
    expect(() => parseSuggestRules({ entries: [{ tag: "X", pattern: "x", kind: "campaign" }] }, (m) => problems.push(m))).toThrow(DataFileRejected);
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

describe("12 Nov ACB file: a bureau reporter's file code is not used, the headline's district is offered (b6 fix brief P0)", () => {
  it("offers #Dungarpur, never puts it in line 1, offers #ACB without applying it", () => {
    const { p, d } = draft(ACB_TEXT, ACB_FILE);
    // Parsed, the JPR code stands; the composer drops it because Navin files for no single district
    expect([p.district, p.districtFrom]).toEqual(["Jaipur", "file_code"]);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(d.hashtagSuggestions[0]).toBe("#Dungarpur");
    expect(d.hashtagSuggestions).toContain("#ACB");
    expect(d.mentions).not.toContain("@jaipur_police");
    expect(d.mentions).not.toContain("@DungarpurP");
  });
});

describe("12 Nov NSUI file: the organisation named outranks the one adjacent to it (§3.3)", () => {
  it("tags the party its headline names, and only offers the wing (P4: no NSUI rule) and @UniRajOfficial", () => {
    const { d } = draft(NSUI_TEXT, NSUI_FILE);
    expect(d.mentions).toContain("@INCRajasthan");
    expect(d.mentions).not.toContain("@NSUIRajasthan");
    expect(d.mentions).not.toContain("@UniRajOfficial");
    expect(d.handleSuggestions.map((h) => h.handle)).toEqual(expect.arrayContaining(["NSUIRajasthan", "UniRajOfficial"]));
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
  it("§3.1 / P2: a district's electoral-roll story tags the collector and OFFERS the CEO (seasonal, suggest_only)", () => {
    const r = pick("जिले में प्रारूप मतदाता सूचियों का प्रकाशन", [], "Deeg");
    expect(r.handles.map((h) => h.handle)).toContain("DeegDm24013");
    expect(r.handles.map((h) => h.handle)).not.toContain("CeoRajasthan");
    expect(r.suggestions.map((h) => h.handle)).toContain("CeoRajasthan");
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

describe("review fixes (12 Nov): the file code stands; the headline's district only when it reads as the story's place", () => {
  // A Jaipur-coded file: the code is the stated district whatever the headline says (user decision, 12 Nov)
  const at = (headline: string) => parseBreaking(`${ACB_FILE.replace(/\.txt$/, "")}\r\n\r\n${headline}\r\nपहला बिंदु\r\n`, ACB_FILE, book);
  it.each([
    ["ओबीसी कोटा बढ़ाने की मांग तेज"],
    ["स्कूलों में दूसरी पाली का समय बदला"],
    ["अजमेर-जयपुर हाईवे पर बड़ा हादसा"],
    ["उदयपुर से लौट रहे जयपुर के परिवार की कार पलटी"],
    ["दिल्ली के बीकानेर हाउस में बैठक"],
    ["मुख्यमंत्री भजनलाल शर्मा हुए खैरथल-तिजारा के लिए रवाना"],
  ])("keeps the file's district: %s", (headline) => {
    expect(at(headline)).toMatchObject({ district: "Jaipur", districtFrom: "file_code" });
  });
  it.each([
    ["डूंगरपुर में ACB कार्रवाई", "Dungarpur"],
    ["डीग-कुम्हेर विधायक डॉ. शैलेश सिंह आज पहुंचेंगे डीग", "Deeg"],
    ["सीकर जिले के खाटूश्यामजी में भीड़", "Sikar"],
  ])("keeps the file's district, and the headline's would be offered: %s", (headline, district) => {
    expect(at(headline)).toMatchObject({ district: "Jaipur", districtFrom: "file_code" });
    expect(inferHeadlineDistrict(book, headline)?.name).toBe(district);
  });
  it.each([
    ["ओबीसी कोटा बढ़ाने की मांग तेज"],
    ["स्कूलों में दूसरी पाली का समय बदला"],
    ["अजमेर-जयपुर हाईवे पर बड़ा हादसा"],
    ["दिल्ली के बीकानेर हाउस में बैठक"],
    ["मुख्यमंत्री भजनलाल शर्मा हुए खैरथल-तिजारा के लिए रवाना"],
  ])("infers no district from: %s", (headline) => {
    expect(inferHeadlineDistrict(book, headline)).toBeNull();
  });
});

describe("review fixes (12 Nov): party wings and exclusions", () => {
  const pick = (headline: string, points: string[], rajasthan = true) =>
    pickHandlesExplained({ headline, points, district: rajasthan ? "Jaipur" : null, rajasthan, leaderPost: false }, rules, { subjects, reporters, parties });
  const tagged = (r: ReturnType<typeof pick>) => r.handles.map((h) => h.handle);

  it("no wing on an attack story naming two parties", () => {
    const r = pick("भाजपा ने NSUI पर साधा निशाना, कहा छात्रों को भड़का रही कांग्रेस", []);
    expect(tagged(r)).not.toContain("NSUIRajasthan");
  });
  it("no wing outside Rajasthan", () => {
    expect(tagged(pick("NSUI ने दिल्ली में किया प्रदर्शन", [], false))).not.toContain("NSUIRajasthan");
  });
  it("no wing from a passing mention in the points", () => {
    const r = pick("युवा नेताओं का प्रदर्शन", ["NSUI कार्यकर्ताओं ने किया विरोध"]);
    expect(tagged(r)).not.toContain("NSUIRajasthan");
  });
  it("P4: a wing on its own story is offered, never tagged, when only a point names the other party", () => {
    const r = pick("NSUI ने फीस वृद्धि के खिलाफ किया प्रदर्शन", ["भाजपा सरकार पर लगाए आरोप"]);
    expect(tagged(r)).not.toContain("NSUIRajasthan");
    expect(r.suggestions.map((h) => h.handle)).toContain("NSUIRajasthan");
  });
  it("P4: a wing its own headline names is offered, never tagged", () => {
    const r = pick("9 माह से कांग्रेस के छात्र संगठन NSUI का नहीं कोई धणी धोरी", []);
    expect(tagged(r)).not.toContain("NSUIRajasthan");
    expect(r.suggestions.map((h) => h.handle)).toContain("NSUIRajasthan");
  });
  it("no police suggestion from a town or word that only contains a venue word", () => {
    const r = pick("कांग्रेस कार्यकर्ताओं ने थानागाजी में की सभा", ["थानेदार के तबादले की मांग"]);
    expect(r.suggestions.some((h) => h.reason === "police")).toBe(false);
  });
  it("an exclusion word in the points still drops the CEO named in the headline", () => {
    const r = pick("मतदाता सूची में गड़बड़ी के आरोप", ["ग्राम पंचायत चुनाव को लेकर राज्य निर्वाचन आयोग से शिकायत"]);
    expect(tagged(r)).not.toContain("CeoRajasthan");
  });
});

describe("review fixes (12 Nov) / P5: config checks fail loudly — the whole file is rejected, every problem named", () => {
  it("rejects a misspelt kind, a reversed window and a tag that is not a hashtag, never loading the rest", () => {
    const problems: string[] = [];
    const bad = { entries: [
      { tag: "A", kind: "campain", pattern: "x", start: "2026-01-01", end: "2026-01-31" },
      { tag: "B", kind: "campaign", pattern: "x", start: "2026-02-01", end: "2026-01-01" },
      { tag: "C D", kind: "keyword", pattern: "x" },
      { tag: "E", kind: "keyword", pattern: "x" },
    ] };
    let err: unknown;
    try {
      parseSuggestRules(bad, (m) => problems.push(m));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DataFileRejected);
    expect((err as DataFileRejected).problems).toHaveLength(3);
    expect((err as DataFileRejected).message).toMatch(/kind must be "campaign" or "keyword", not "campain"/);
    expect(problems).toHaveLength(3);
  });
  it("rejects a missing kind rather than defaulting it", () => {
    expect(() => parseSuggestRules({ entries: [{ tag: "A", pattern: "x", start: "2026-01-01", end: "2026-01-31" }] })).toThrow(/kind must be/);
  });
  it("never maps a typo to something that is not a hashtag, nor to an unconfirmed target", () => {
    expect(() => parseHashtagNormalise({ variants: { Foo: "Foo Bar" } })).toThrow(DataFileRejected);
    expect(() => parseHashtagNormalise({ variants: { Bar: "X:" } })).toThrow(DataFileRejected);
    // A well-formed target nobody confirmed: a typo in the TARGET would be written into the post
    expect(() => parseHashtagNormalise({ variants: { Baz: "BazQux" } })).toThrow(/#BazQux is not a known-good tag/);
    expect([...parseHashtagNormalise({ variants: { Baz: "BazQux" }, known: ["BazQux"] }).variants.keys()]).toEqual(["Baz"]);
    // Guarded tags and the caller's known tags (districts) count as known
    expect(parseHashtagNormalise({ variants: { FINVido: "FINVideo", jaipur: "Jaipur" } }, undefined, ["Jaipur"]).variants.size).toBe(2);
  });
  it("the shipped files pass, and every normalisation target is known-good", () => {
    expect(() => parseSuggestRules(cfg("campaigns.json"))).not.toThrow();
    expect(() => parseHashtagNormalise(cfg("hashtag-normalise.json"))).not.toThrow();
  });
});

// ─── b6 fix brief (12 Nov 2026): the eleven fixtures, provenance, and the published-post side ──────────────

/** A breaking file in the house shape; `code` is the file name's district code, `reporter` its token */
const file = (headline: string, points: string[] = ["पहला बिंदु"], { code = "JPR", reporter = "RITURAJ", place = "" } = {}) => {
  const name = `BTN_RJ_BREAKING_6100_12NOV_US_${reporter}_${code}_BIG_FULL`;
  const text = [name, "", ...(place ? [place] : []), headline, ...points].join("\r\n");
  return draft(text, `${name}.txt`);
};
const everyTag = (d: ReturnType<typeof composeBreaking>) => [d.bodyText, ...d.hashtags, ...d.hashtagSuggestions].join(" ");
const everyHandle = (d: ReturnType<typeof composeBreaking>) => [...d.handles, ...d.handleSuggestions].map((h) => h.handle.toLowerCase());
const policeOf = (district: string) => rules.districts[district.toLowerCase()]!.police.map((h) => h.toLowerCase());

describe("b6 fix brief fixtures", () => {
  it("1. 'ओबीसी कोटा बढ़ाने की मांग' filed from Jaipur: no #Kota, no @KotaPolice", () => {
    const { d } = file("ओबीसी कोटा बढ़ाने की मांग");
    expect(everyTag(d)).not.toMatch(/#Kota\b/);
    for (const h of policeOf("Kota")) expect(everyHandle(d)).not.toContain(h);
    // Filed from Jaipur by a Jaipur reporter: the file code is the stated district
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
  });

  it("2. 'स्कूलों में दूसरी पाली का समय बदला': no #Pali", () => {
    const { d } = file("स्कूलों में दूसरी पाली का समय बदला");
    expect(everyTag(d)).not.toMatch(/#Pali\b/);
    expect(inferHeadlineDistrict(book, "स्कूलों में दूसरी पाली का समय बदला")).toBeNull();
  });

  it("3. 'अजमेर-जयपुर हाईवे पर हादसा': the route guard fires, no #Ajmer from the headline", () => {
    expect(inferHeadlineDistrict(book, "अजमेर-जयपुर हाईवे पर हादसा")).toBeNull();
    // One district on a route to somewhere outside: without the guard this would infer Udaipur
    expect(inferHeadlineDistrict(book, "उदयपुर-अहमदाबाद हाईवे पर हादसा")).toBeNull();
    expect(inferHeadlineDistrict(book, "जोधपुर रोड पर जाम")).toBeNull();
    const { p, d } = file("अजमेर-जयपुर हाईवे पर हादसा", ["दो की मौत"], { code: "XX", reporter: "NOBODY" });
    expect(everyTag(d)).not.toMatch(/#Ajmer\b/);
    expect(p.district).not.toBe("Ajmer");
  });

  it("4. 'दिल्ली के बीकानेर हाउस में बैठक': no #Bikaner", () => {
    expect(inferHeadlineDistrict(book, "दिल्ली के बीकानेर हाउस में बैठक")).toBeNull();
    const { d } = file("दिल्ली के बीकानेर हाउस में बैठक", ["अधिकारी रहे मौजूद"], { code: "XX", reporter: "NOBODY" });
    expect(everyTag(d)).not.toMatch(/#Bikaner\b/);
    for (const h of policeOf("Bikaner")) expect(everyHandle(d)).not.toContain(h);
  });

  it("5. a post that already carries #Chittorgarh with 'चित्तौड़गढ़-उदयपुर हाईवे': the district stays Chittorgarh, no Udaipur", () => {
    const published = composePostTags("चित्तौड़गढ़-उदयपुर हाईवे पर हादसा\n\nदो वाहनों की भिड़ंत\n\n#Chittorgarh #RajasthanWithFirstIndia", {
      ...ctx, inferDistrict: (h) => inferHeadlineDistrict(book, h)?.tag ?? null,
    });
    expect(published.district).toBe("Chittorgarh");
    expect(published.trail).toEqual(["Chittorgarh", BRAND_RAJASTHAN]);
    expect([...published.trail, ...published.suggest]).not.toContain("Udaipur");
    // The draft side: the desk's own place line names Chittorgarh
    const { d } = file("चित्तौड़गढ़-उदयपुर हाईवे पर हादसा", ["दो वाहनों की भिड़ंत"], { place: "चित्तौड़गढ़" });
    expect(d.bodyText.startsWith("#Chittorgarh: ")).toBe(true);
    expect(everyTag(d)).not.toMatch(/#Udaipur\b/);
  });

  it("6. the 12 Nov Dungarpur ACB post without its #Dungarpur: #Jaipur not emitted, no @JaipurPolice, Navin infers nothing", () => {
    const { d } = draft(ACB_TEXT, ACB_FILE);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    // Navin is a state bureau (no district): neither his roster entry nor his JPR file code is offered
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
    for (const h of policeOf("Jaipur")) expect(everyHandle(d)).not.toContain(h);
    expect(pickReporter("NAVIN", reporters).match?.districts).toEqual([]);
    // The only district on the draft is the headline's, offered; nothing district-wise comes from Navin
    expect(d.hashtagSuggestions.filter((t) => book.hashtag(t.slice(1))?.kind === "district")).toEqual(["#Dungarpur"]);
    expect(d.handles.some((h) => h.reason === "police" || h.reason === "collector")).toBe(false);
    // With a headline that names no district, a Navin JPR file has no district at all: not stated, not offered
    const navin = file("ACB ने रिश्वत लेते अधिकारी को दबोचा", ["एक हजार रुपए की रिश्वत"], { reporter: "NAVIN" });
    expect(navin.p).toMatchObject({ district: "Jaipur", districtFrom: "file_code" });
    expect(navin.d.bodyText.startsWith("#")).toBe(false);
    expect(navin.d.hashtagSuggestions.filter((t) => book.hashtag(t.slice(1))?.kind === "district")).toEqual([]);
    expect(navin.d.handles.some((h) => h.reason === "police" || h.reason === "collector")).toBe(false);
    expect(storyDistrict({ ...navin.p, fileDistrict: "Jaipur" }, book, pickReporter("NAVIN", reporters).match)).toBeNull();
    // The published post with the tag taken off: whatever inference says goes to `suggest`, never the trail
    const stripped = composePostTags("डूंगरपुर में ACB कार्रवाई\n\nACB ने झोतरी CHC के प्रभारी को किया ट्रैप\n\n#RajasthanWithFirstIndia", {
      ...ctx, inferDistrict: () => "Jaipur",
    });
    expect(stripped.trail).not.toContain("Jaipur");
    expect(stripped.trail).toHaveLength(1);
    expect(stripped.suggest).toContain("Jaipur");
  });

  const pick = (headline: string, points: string[], district: string | null = "Jaipur") =>
    pickHandlesExplained({ headline, points, district, rajasthan: true, leaderPost: false }, rules, { subjects, reporters, parties });
  const offered = (r: ReturnType<typeof pick>) => r.suggestions.map((h) => h.handle);
  const tagged = (r: ReturnType<typeof pick>) => r.handles.map((h) => h.handle);

  it("7. a panchayat story with 'पंचायत' only in the points: no @CeoRajasthan", () => {
    const r = pick("मतदाता सूची में नाम जुड़वाने के लिए शिविर", ["ग्राम पंचायत मुख्यालय पर लगेगा शिविर"]);
    expect([...tagged(r), ...offered(r)]).not.toContain("CeoRajasthan");
  });

  it("8. a voter-list story with 'मतदाता सूची' in the points: @CeoRajasthan allowed (offered: seasonal)", () => {
    const head = "नए मतदाताओं के लिए विशेष अभियान";
    const points = ["मतदाता सूची में नाम जोड़ने के लिए भरे जाएंगे फॉर्म"];
    const r = pick(head, points);
    expect(offered(r)).toContain("CeoRajasthan");
    expect(tagged(r)).not.toContain("CeoRajasthan");
    // Inside an emit_window the same entry is tagged like any subject (here: the headline names the roll)
    const seasonal = parseSubjectHandles({
      entries: cfg("subject-handles.json").entries.map((e: { handle: string }) =>
        e.handle === "@CeoRajasthan" ? { ...e, emit_window: { start: "2026-11-01", end: "2026-11-30" } } : e),
    });
    const rollHead = "प्रारूप मतदाता सूची का प्रकाशन आज";
    expect(tagged(pick(rollHead, []))).not.toContain("CeoRajasthan");
    const inWindow = pickHandlesExplained({ headline: rollHead, points: [], district: "Jaipur", rajasthan: true, leaderPost: false },
      rules, { subjects: seasonal, reporters, parties, at: new Date("2026-11-12T08:00:00Z") });
    expect(inWindow.handles.map((h) => h.handle)).toContain("CeoRajasthan");
  });

  it("9. 'भाजपा ने NSUI पर साधा निशाना': no @NSUIRajasthan, tagged or offered", () => {
    const r = pick("भाजपा ने NSUI पर साधा निशाना", []);
    expect([...tagged(r), ...offered(r)]).not.toContain("NSUIRajasthan");
    expect(attackTargets("भाजपा ने NSUI पर साधा निशाना", parties)).toEqual(new Set(["congress"]));
  });

  it("10. a Congress story with 'कांग्रेस' only in the points: @INCRajasthan offered, not blocked and not emitted", () => {
    const r = pick("पूर्व मंत्री ने गांवों में किया जनसंपर्क", ["कांग्रेस कार्यकर्ताओं के साथ की बैठक"]);
    expect(r.cls).toBe("political");
    expect(tagged(r)).not.toContain("INCRajasthan");
    expect(offered(r)).toContain("INCRajasthan");
    // Headline presence raises it to the post
    expect(tagged(pick("कांग्रेस ने गांवों में किया जनसंपर्क", []))).toContain("INCRajasthan");
  });

  it("11. an invented handle: when the best topical match is in no directory, the picker returns nothing for it", () => {
    // @UniRajOfficial taken out of every file: the NSUI story's "राजस्थान यूनिवर्सिटी" must yield nothing
    const noUniRaj = parseSubjectHandles({ entries: cfg("subject-handles.json").entries.filter((e: { handle: string }) => e.handle !== "@UniRajOfficial") });
    const p = parseBreaking(NSUI_TEXT, NSUI_FILE, book);
    const slot = slotFromTags(p.tags);
    const d = composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district }, rules, book, { subjects: noUniRaj, reporters, parties });
    const out = [...d.handles, ...d.handleSuggestions].map((h) => h.handle.toLowerCase());
    expect(out).not.toContain("unirajofficial");
    const directories = new Set([...(rules.all ?? []), ...(noUniRaj.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
    for (const h of out) expect(directories.has(h)).toBe(true);
  });
});

describe("b6 fix brief: provenance — only what the desk wrote reaches the post", () => {
  it("a place line, a place prefix, a district tag in the copy and the file code are where the district came from", () => {
    expect(file("सड़क हादसे में दो की मौत", ["जांच जारी"], { place: "जोधपुर से खबर" }).p.districtFrom).toBe("place_line");
    expect(file("#Kota: सड़क हादसे में दो की मौत").p.districtFrom).toBe("headline_prefix");
    expect(file("#BJP #Kota: कोटा में सभा").p).toMatchObject({ district: "Kota", districtFrom: "tag" });
    expect(file("सड़क हादसे में दो की मौत").p).toMatchObject({ district: "Jaipur", districtFrom: "file_code" });
  });
  it("an explicit district (the copy, or a one-district reporter's file code) is line 1's tag and picks the police; an inferred one does neither", () => {
    const own = file("सड़क हादसे में दो की मौत", ["पुलिस ने शुरू की जांच"], { place: "जयपुर" }).d;
    expect(own.bodyText.startsWith("#Jaipur: ")).toBe(true);
    expect(own.mentions).toContain("@jaipur_police");
    const coded = file("सड़क हादसे में दो की मौत", ["पुलिस ने शुरू की जांच"]).d;
    expect(coded.bodyText.startsWith("#Jaipur: ")).toBe(true);
    expect(coded.mentions).toContain("@jaipur_police");
    // No code, no place line: the headline's district is only offered
    const text = file("झालावाड़ में सड़क हादसे में दो घायल", ["पुलिस ने शुरू की जांच"], { code: "XX", reporter: "NOBODY" });
    expect(text.p.districtFrom).toBe("text");
    expect(text.d.bodyText.startsWith("#")).toBe(false);
    expect(text.d.hashtagSuggestions[0]).toBe("#Jhalawar");
    expect(text.d.handles.some((h) => h.reason === "police")).toBe(false);
    // A row stored before the provenance column (null) is treated as inferred
    const legacy = composeBreaking({ headline: "सड़क हादसा", points: [], district: "Jaipur", districtFrom: null, town: null, rajasthan: true, leaderPost: false }, rules, book);
    expect(legacy.bodyText.startsWith("#")).toBe(false);
  });
  it("storyDistrict tells explicit from inferred, in §2.8's order", () => {
    const base = { headline: "सड़क हादसा", points: [], town: null, rajasthan: true, leaderPost: false };
    expect(storyDistrict({ ...base, district: "Kota", districtFrom: "place_line" }, book, null)).toMatchObject({ provenance: "explicit" });
    expect(storyDistrict({ ...base, district: "Kota" }, book, null)).toMatchObject({ provenance: "explicit", from: "caller" });
    expect(emittable(storyDistrict({ ...base, district: "Kota", districtFrom: "file_code" }, book, null))?.name).toBe("Kota");
    // The file code beats the headline for anyone but a bureau reporter
    expect(storyDistrict({ ...base, headline: "डूंगरपुर में ACB कार्रवाई", district: "Jaipur", districtFrom: "file_code" }, book, null))
      .toMatchObject({ provenance: "explicit", from: "file_code" });
    const navin = pickReporter("NAVIN", reporters).match;
    expect(storyDistrict({ ...base, headline: "डूंगरपुर में ACB कार्रवाई", district: "Jaipur", districtFrom: "file_code" }, book, navin))
      .toMatchObject({ provenance: "inferred", from: "headline" });
    expect(storyDistrict({ ...base, district: "Ajmer", districtFrom: "text" }, book, null)).toMatchObject({ provenance: "inferred", from: "text" });
    const rituraj = pickReporter("RITURAJ", reporters).match;
    expect(storyDistrict({ ...base, district: null, districtFrom: null }, book, rituraj)).toMatchObject({ provenance: "inferred", from: "reporter" });
  });
  it("P1 (published posts): no inference at all when any slot names a place, #<District>News included", () => {
    const infer = () => "Jaipur";
    expect(composePostTags("उदयपुर में हादसा\n\nदो घायल\n\n#UdaipurNews #RajasthanWithFirstIndia", { ...ctx, inferDistrict: infer }).suggest).not.toContain("Jaipur");
    expect(composePostTags("उदयपुर में हादसा #Udaipur\n\nदो घायल", { ...ctx, inferDistrict: infer }).suggest).not.toContain("Jaipur");
  });
  it("P1: an ambiguous district word needs a strong locative; an ordinary one may end the headline", () => {
    expect(inferHeadlineDistrict(book, "डूंगरपुर में ACB कार्रवाई")?.name).toBe("Dungarpur");
    expect(inferHeadlineDistrict(book, "अजमेर की दरगाह में उर्स")).toBeNull();
    expect(inferHeadlineDistrict(book, "सीकर जिले के खाटूश्यामजी में भीड़")?.name).toBe("Sikar");
    expect(inferHeadlineDistrict(book, "आज पहुंचेंगे कोटा")).toBeNull();
    expect(inferHeadlineDistrict(book, "डीग-कुम्हेर विधायक डॉ. शैलेश सिंह आज पहुंचेंगे डीग")?.name).toBe("Deeg");
  });
});

describe("b6 fix brief P3/P4: party handles", () => {
  const pick = (headline: string, points: string[] = []) =>
    pickHandlesExplained({ headline, points, district: "Jaipur", rajasthan: true, leaderPost: false }, rules, { subjects, reporters, parties });
  it("the party an attack targets is offered, never tagged (UNVALIDATED rule, 6 samples)", () => {
    const r = pick("अशोक गहलोत ने भाजपा पर साधा निशाना");
    expect(r.handles.map((h) => h.handle)).not.toContain("BJP4Rajasthan");
    expect(r.suggestions.map((h) => h.handle)).toContain("BJP4Rajasthan");
  });
  it("a clash story tags no party and offers both (the attacker first)", () => {
    const r = pick("कांग्रेस ने भाजपा पर साधा निशाना");
    expect(r.handles.some((h) => h.reason === "party")).toBe(false);
    expect(r.suggestions.map((h) => h.handle)).toEqual(expect.arrayContaining(["INCRajasthan", "BJP4Rajasthan"]));
    expect(r.suggestions.findIndex((h) => h.handle === "INCRajasthan")).toBeLessThan(r.suggestions.findIndex((h) => h.handle === "BJP4Rajasthan"));
  });
});

describe("file code and a reporter listed for several districts (user decision, 12 Nov)", () => {
  it("trusts @aishwaryam99's JPR code (she is listed for Jaipur and Delhi): #Jaipur in line 1", () => {
    const file = "BTN_RJ_BREAKING_09NOV_2750_AM_CONTROL_AISHWARYA_JPR_BIG_FULL_CM_.txt";
    const { d } = draft(`${file.replace(/\.txt$/, "")}\r\n\r\nमुख्यमंत्री भजनलाल शर्मा हुए खैरथल-तिजारा के लिए रवाना\r\nजयपुर एयरपोर्ट से हेलीकॉप्टर से रवाना होकर पहुंचेंगे सिलपटा हेलीपैड\r\n`, file);
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
  });
});

// ─── review round 3 (12 Nov) ──────────────────────────────────────────────────────────────────────────────

describe("review r3: rows stored before migration 0023 (district_from NULL)", () => {
  /** A stored row as the compose stage reads it: the parse's district, no provenance */
  const legacy = (text: string, fileName: string) => {
    const p = parseBreaking(text, fileName, book);
    const slot = slotFromTags(p.tags);
    const base = { ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode };
    const opts = { subjects, reporters, parties, normaliser };
    return {
      p,
      // The file could not be parsed again: storyDistrict's legacy rule
      blind: composeBreaking({ ...base, districtFrom: null }, rules, book, opts),
      // The worker's path: the stored file parsed again
      recovered: composeBreaking({ ...base, districtFrom: recoverDistrictFrom(text, fileName, p.district, book) }, rules, book, opts),
    };
  };
  const name = (reporter: string, code: string) => `BTN_RJ_BREAKING_6200_12NOV_US_${reporter}_${code}_BIG_FULL`;
  const text = (n: string, place: string) => [n, "", place, "सड़क हादसे में दो की मौत", "पुलिस ने शुरू की जांच"].join("\r\n");

  it("a Jaipur reporter's JPR file with the place line 'जोधपुर से खबर': never #Jaipur or @jaipur_police", () => {
    const n = name("RITURAJ", "JPR");
    const { p, blind, recovered } = legacy(text(n, "जोधपुर से खबर"), `${n}.txt`);
    expect(p.district).toBe("Jodhpur");
    expect(recovered.bodyText.startsWith("#Jodhpur: ")).toBe(true);
    for (const d of [blind, recovered]) {
      expect(d.bodyText.startsWith("#Jaipur")).toBe(false);
      for (const h of policeOf("Jaipur")) expect(everyHandle(d)).not.toContain(h);
    }
    // Without the file, Jodhpur is not the file code: offered, not stated
    expect(blind.bodyText.startsWith("#")).toBe(false);
    expect(blind.hashtagSuggestions[0]).toBe("#Jodhpur");
  });

  it("a file with no code and the place line Jodhpur keeps Jodhpur", () => {
    const n = name("NOBODY", "XX");
    const { recovered, blind } = legacy(text(n, "जोधपुर"), `${n}.txt`);
    expect(recovered.bodyText.startsWith("#Jodhpur: ")).toBe(true);
    expect(recovered.mentions.map((m) => m.toLowerCase())).toEqual(expect.arrayContaining(policeOf("Jodhpur").slice(0, 1).map((h) => `@${h}`)));
    expect(blind.hashtagSuggestions).toContain("#Jodhpur");
  });

  it("Navin's JPR file with the place line 'डूंगरपुर से खबर' keeps Dungarpur", () => {
    const n = name("NAVIN", "JPR");
    const { recovered, blind } = legacy(text(n, "डूंगरपुर से खबर"), `${n}.txt`);
    expect(recovered.bodyText.startsWith("#Dungarpur: ")).toBe(true);
    expect(blind.hashtagSuggestions).toContain("#Dungarpur");
    for (const d of [blind, recovered]) expect(everyTag(d)).not.toMatch(/#Jaipur\b/);
  });

  it("a legacy row whose district IS the trusted file code is stated, as before b6", () => {
    const n = name("RITURAJ", "JPR");
    const t = [n, "", "सड़क हादसे में दो की मौत", "पुलिस ने शुरू की जांच"].join("\r\n");
    expect(legacy(t, `${n}.txt`).blind.bodyText.startsWith("#Jaipur: ")).toBe(true);
  });
});

describe("review r3: district hashtags count only in the headline, and only Rajasthan ones", () => {
  it("#Pakistan or #Delhi in a point changes neither line 1 nor the footer", () => {
    for (const tag of ["#Pakistan", "#Delhi"]) {
      const { p, d } = file("सीमा पर घुसपैठ की कोशिश नाकाम", [`${tag} की ओर से हुई फायरिंग`]);
      expect(p).toMatchObject({ district: "Jaipur", districtFrom: "file_code", rajasthan: true });
      expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
      expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    }
  });
  it("#Pakistan in the headline is not a district either", () => {
    expect(file("#Pakistan की नापाक हरकत", ["सीमा पर फायरिंग"]).p.districtFrom).toBe("file_code");
  });
  it("two different district tags in the headline: neither is stated, and neither is offered again (already on line 1)", () => {
    const { p, d } = file("#BJP #Kota #Bundi: दोनों जिलों में सभा", ["कार्यकर्ता रहे मौजूद"], { code: "XX", reporter: "NOBODY" });
    expect(p.districtFrom).not.toBe("tag");
    expect(d.bodyText.startsWith("#BJP #Kota #Bundi: ")).toBe(true);
    // Desk fixes 14 Nov, point 6: a suggestion never repeats a tag already in the copy
    expect(d.hashtagSuggestions).not.toContain("#Kota");
    expect(d.hashtagSuggestions).not.toContain("#Bundi");
    for (const h of [...policeOf("Kota"), ...policeOf("Bundi")]) expect(everyHandle(d)).not.toContain(h);
  });
});

describe("review r3: the rest", () => {
  const pick = (headline: string, points: string[] = []) =>
    pickHandlesExplained({ headline, points, district: "Jaipur", rajasthan: true, leaderPost: false }, rules, { subjects, reporters, parties });

  it("a party physically attacked is offered, never tagged", () => {
    const r = pick("भाजपा प्रत्याशी पर हमला, कार्यकर्ताओं ने किया प्रदर्शन");
    expect(r.handles.map((h) => h.handle)).not.toContain("BJP4Rajasthan");
    expect(r.suggestions.map((h) => h.handle)).toContain("BJP4Rajasthan");
  });

  it("a route named by two space-separated places is guarded too", () => {
    expect(inferHeadlineDistrict(book, "अजमेर जयपुर रोड पर हादसा")).toBeNull();
    expect(inferHeadlineDistrict(book, "सीकर में जयपुर रोड पर जाम")).toBeNull();
    expect(inferHeadlineDistrict(book, "डूंगरपुर में ACB कार्रवाई")?.name).toBe("Dungarpur");
  });

  it("an unmatched reporter on a coded file: the file code is used, and the draft says so", () => {
    const { d } = file("सड़क हादसे में दो की मौत", ["पुलिस ने शुरू की जांच"], { reporter: "SOMEONENEW" });
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/SOMEONENEW, who is not in the reporter list; the file code's district \(Jaipur\) was used/);
  });

  it("campaigns.json: a pattern that is too long or too slow rejects the file", () => {
    expect(() => parseSuggestRules({ entries: [{ tag: "A", kind: "keyword", pattern: "x".repeat(301) }] })).toThrow(/more than 300/);
    expect(() => parseSuggestRules({ entries: [{ tag: "A", kind: "keyword", pattern: "^(a+)+$" }] })).toThrow(/too slow/);
    expect(() => parseSuggestRules(cfg("campaigns.json"))).not.toThrow();
  });

  it("subject-handles.json: a misspelt key, a non-boolean suggest_only or a bad emit_window rejects the whole file", () => {
    const entries = cfg("subject-handles.json").entries as Record<string, unknown>[];
    const withCeo = (patch: Record<string, unknown>) => ({ entries: entries.map((e) => (e.handle === "@CeoRajasthan" ? { ...e, ...patch } : e)) });
    expect(() => parseSubjectHandles(withCeo({ suggestonly: true }))).toThrow(/unknown key "suggestonly"/);
    expect(() => parseSubjectHandles(withCeo({ suggest_only: "yes" }))).toThrow(DataFileRejected);
    expect(() => parseSubjectHandles(withCeo({ emit_window: { start: "2026-13-45", end: "2026-12-01" } }))).toThrow(/real days/);
    expect(() => parseSubjectHandles(withCeo({ emit_window: { start: "2026-02-30", end: "2026-03-10" } }))).toThrow(/real days/);
    expect(() => parseSubjectHandles(withCeo({ emit_window: { start: "2026-12-01", end: "2026-11-01" } }))).toThrow(/start first/);
    expect(parseSubjectHandles(withCeo({ emit_window: { start: "2026-11-01", end: "2026-11-30" } })).count).toBeGreaterThan(0);
    expect(() => parseSubjectHandles(cfg("subject-handles.json"))).not.toThrow();
  });

  it("hashtag-normalise: a district tag of the places file is a known-good target", () => {
    expect(parseHashtagNormalise({ variants: { jodhpur: "Jodhpur" } }, undefined, placeTags).variants.get("jodhpur")).toBe("Jodhpur");
  });
});
