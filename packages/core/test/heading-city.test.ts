// b9: the city on every breaking post, and never twice (SOCIA_HEADING_GAPS_AND_PLAN, 23 Nov 2026). Cases from the posts
// the desk published 15–22 Nov and its own Sep–Nov X history.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_NATIONAL, BRAND_RAJASTHAN, CITY_FROM_COPY_TEXT, PlaceBook, composeBreaking, deskPlaceTag, parseBreaking, parseHandleRules, parseHashtagNormalise,
  parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const opts = {
  subjects: parseSubjectHandles(cfg("subject-handles.json")), reporters, parties: parsePartyHandles(cfg("party-handles.json")),
  normaliser: parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag)),
};
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_23NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;
function draft(name: string, lines: string[]): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, opts);
}
const line1 = (d: BreakingDraft) => d.bodyText.split("\n")[0]!;
const police = (d: BreakingDraft) => d.handles.filter((h) => h.reason === "police" || h.reason === "collector");
/** Every hashtag of the post, line 1 and the tag line */
const allTags = (d: BreakingDraft) => [...`${d.bodyText} ${d.hashtags.join(" ")}`.matchAll(/#([\p{L}\p{M}\p{N}_]+)/gu)].map((m) => m[1]!);
const hasCity = (d: BreakingDraft) => allTags(d).some((t) => book.hashtag(t) !== null || /^Didwana$/i.test(t));
const POINTS = ["पुलिस मौके पर पहुंची", "मामले की जांच शुरू"];

describe("rule 3: line 1 never names its city twice", () => {
  it("a headline opening with line 1's town takes the town tag in place of the word, no colon (desk: 62 to 6)", () => {
    const d = draft(fileFor(null, "BUN"), ["नैनवां", "नैनवां में मां कंकाली की निकाली भव्य नेजा सवारी", ...POINTS]);
    expect(line1(d)).toBe("#Bundi #नैनवां में मां कंकाली की निकाली भव्य नेजा सवारी");
    // D1: the card leads with the town ("नैनवां: मां कंकाली…", the word dropped by the card itself)
    expect(d.headingPlace).toMatchObject({ placement: "inline", source: "desk", district: "Bundi", card: "नैनवां", tags: ["#Bundi", "#नैनवां"] });
    // Every word of the headline is still there, the town now as its tag
    expect(line1(d).replace(/#/g, "")).toContain("नैनवां में मां कंकाली की निकाली भव्य नेजा सवारी");
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
  });

  it("a headline opening with line 1's district moves the district tag to the tag line (desk: 221 to 3)", () => {
    const d = draft(fileFor(null, "TNK"), ["टोंक", "टोंक में अवैध खनन पर बड़ी कार्रवाई", ...POINTS]);
    expect(line1(d)).toBe("टोंक में अवैध खनन पर बड़ी कार्रवाई");
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`, "#Tonk"]);
    expect(d.headingPlace).toMatchObject({ placement: "trailing", source: "desk", district: "Tonk", card: null });
    // Still the stated district: its police are picked as before
    expect(police(d).length).toBeGreaterThan(0);
  });

  it("the desk's own '#Tonk: टोंक में …' is not written twice either", () => {
    const d = draft(fileFor(null), ["#Tonk: टोंक में चोरी की वारदात का खुलासा", ...POINTS]);
    expect(line1(d).startsWith("टोंक में चोरी")).toBe(true);
    expect(d.hashtags).toContain("#Tonk");
  });

  it("a headline that does not open with its place keeps '#District #Town: <headline>', and the card leads with the town", () => {
    const d = draft(fileFor(null), ["बूंदी के नैनवां से खबर", "मां कंकाली की निकाली भव्य नेजा सवारी", ...POINTS]);
    expect(line1(d)).toBe("#Bundi #नैनवां: मां कंकाली की निकाली भव्य नेजा सवारी");
    expect(d.headingPlace).toMatchObject({ placement: "lead", card: "नैनवां", town: "नैनवां" });
    const k = draft(fileFor(null), ["कोटा", "नए कोर्ट भवन का शिलान्यास", ...POINTS]);
    expect(line1(k)).toBe("#Kota: नए कोर्ट भवन का शिलान्यास");
    expect(k.headingPlace).toMatchObject({ placement: "lead", card: "Kota", source: "desk" });
  });

  it("a headline opening with ANOTHER place keeps the lead (only the same place moves)", () => {
    const d = draft(fileFor(null), ["कोटा", "बूंदी रोड पर हादसा", ...POINTS]);
    expect(line1(d)).toBe("#Kota: बूंदी रोड पर हादसा");
  });

  it("a desk tag run with a place is left exactly as written", () => {
    const d = draft(fileFor(null), ["#BJP #Kota: कोटा में सभा", ...POINTS]);
    expect(line1(d)).toBe("#BJP #Kota: कोटा में सभा");
  });
});

describe("rule 1: every post carries a city hashtag", () => {
  it("no place, no reporter rule, no file code: NO city tag (owner, 24 Nov 2026: no #Jaipur fallback); flagged, #Jaipur only offered", () => {
    const d = draft(fileFor("VIKAS"), ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"]);
    expect(line1(d).startsWith("#")).toBe(false);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(d.noCity).toBe(true);
    expect(d.headingPlace).toMatchObject({ source: "none", placement: "none", card: null, tags: [] });
    expect(police(d)).toEqual([]);
    // Offered first, one click, never on the post: the reporter's district, then the head office
    expect(d.hashtagSuggestionItems[0]).toMatchObject({ tag: "#Jaipur", source: "district.city.candidate" });
    expect(d.proposals.some((p) => p.item === "#Jaipur" && p.layer === "emit")).toBe(false);
  });

  it("the owner's case of 24 Nov: a Delhi story from the Rajasthan desk gets no #Jaipur, on the post or the card", () => {
    const d = draft(fileFor("VIKAS"), ["दिल्लीः केंद्रीय कैबिनेट की कल बैठक होगी", "कल सुबह 11 बजे कैबिनेट की बैठक"]);
    expect(allTags(d)).not.toContain("Jaipur");
    expect(d.bodyText).not.toMatch(/^#Jaipur/);
    expect(d.headingPlace.card).not.toBe("Jaipur");
  });

  it("the district the copy names comes before the head office, in the tag line, and picks no police", () => {
    expect(CITY_FROM_COPY_TEXT).toBe(true);
    const d = draft(fileFor("VIKAS"), ["कोटा के बोरखेड़ा क्षेत्र में बेकाबू कार ने मारी टक्कर", ...POINTS]);
    expect(line1(d).startsWith("कोटा के बोरखेड़ा")).toBe(true);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`, "#Kota"]);
    expect(d.headingPlace).toMatchObject({ source: "inferred", placement: "trailing" });
    expect(police(d)).toEqual([]);
  });

  it("a place hashtag the desk wrote anywhere is the city: nothing is added", () => {
    const d = draft(fileFor("VIKAS"), ["सरकार ने जारी किए नए दिशा-निर्देश", "जयपुर में होगी बैठक #Jaipur"]);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(d.headingPlace).toMatchObject({ source: "copy", placement: "copy" });
  });

  it("#Didwana (the desk's spelling of Didwana-Kuchaman) counts as a city; the typo #Didiwana is corrected to it", () => {
    for (const tag of ["#Didwana", "#Didiwana"]) {
      const d = draft(fileFor("VIKAS"), [`${tag}: रहमान गेट क्षेत्र में चोरी`, ...POINTS]);
      expect(line1(d).startsWith("#Didwana: ")).toBe(true);
      expect(allTags(d)).not.toContain("Jaipur");
    }
  });

  it("a video post: a reporter rule's city goes in the tag line, never line 1; with none, no city and the flag", () => {
    const d = draft(fileFor("BHANWAR"), ["कोचिंग छात्रों के लिए नई गाइडलाइन जारी | Rajasthan News", ...POINTS]);
    expect(line1(d).startsWith("#")).toBe(false);
    expect(d.headingPlace.placement).toBe("trailing");
    expect(hasCity(d)).toBe(true);
    const none = draft(fileFor("VIKAS"), ["कोचिंग छात्रों के लिए नई गाइडलाइन जारी | Rajasthan News", ...POINTS]);
    expect(none.noCity).toBe(true);
    expect(allTags(none)).not.toContain("Jaipur");
  });

  it("D4 + P3: a national story naming no place gets NO city: flagged national_story, no Rajasthan place offered", () => {
    const d = composeBreaking({ headline: "यमुना प्रदूषण पर सुप्रीम कोर्ट सख्त", points: ["सरकार से मांगा जवाब"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, opts);
    expect(d.hashtags).toEqual([`#${BRAND_NATIONAL}`]);
    expect(d.noCity).toBe(true);
    expect(d.cityFlag).toBe("national_story");
    expect(d.headingPlace).toMatchObject({ source: "none", placement: "none", card: null, tags: [] });
    expect(d.hashtagSuggestionItems.filter((t) => t.source === "district.city.candidate").map((t) => t.tag)).toEqual(["#Delhi"]);
    expect(d.warnings.join(" ")).toMatch(/national story/);
  });

  it("D4: a national story takes its city from any place its text names, an outside one included; never #Jaipur", () => {
    const delhi = composeBreaking({ headline: "दिल्ली के द्वारका में फर्जी कॉल सेंटर का भंडाफोड़", points: ["पुलिस ने 12 को पकड़ा"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, opts);
    expect(delhi.hashtags).toEqual([`#${BRAND_NATIONAL}`, "#Delhi"]);
    expect(delhi.noCity).toBe(false);
    const patna = composeBreaking({ headline: "बिहार चुनाव पर बड़ी बैठक", points: ["पटना में होगी बैठक"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, opts);
    // P3: the first CITY the text names is carried; the state (बिहार) is not
    expect(patna.hashtags).toEqual([`#${BRAND_NATIONAL}`, "#Patna"]);
  });

  it("every real breaking fixture file comes out with a city, or flagged no_city", () => {
    const dir = new URL("./fixtures/breaking/", import.meta.url);
    for (const name of ["BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt", "BTN_RJ_BREAKING_2198_28OCT_mh_CONTROL_AJM3_big.txt", "BTN_RJ_BREAKING_29OCT_2702_AM_CONTROL_REPORTER_KRO_BIG_KARARI_.txt", "BTN_RJ_BREAKING_5101_28OCT_KS_CONTROL_REPORTER_BIG_BREAK_FULL_SCREEN_CM.txt", "BTN_RJ_BREAKING_6072_29OCT_US_CONTROL_REPORTER_karari_big.txt", "btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt", "btn_rj_breaking_29Oct_vks_1611_control_MJSM.txt"]) {
      const text = readFileSync(new URL(name, dir), "utf8");
      const p = parseBreaking(text, name, book);
      const slot = slotFromTags(p.tags);
      const d = composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, opts);
      expect(hasCity(d) || d.noCity, name).toBe(true);
      expect(allTags(d).includes("Jaipur") && d.headingPlace.source === "none", name).toBe(false);
    }
  });
});

describe("step 4: reporter rules from the data (23 Nov 2026)", () => {
  it("ASHVINI (an outside rule), an outside story naming no place he tagged: '#Delhi:' in line 1", () => {
    const d = draft(fileFor("ASHVINI"), ["बेंगलुरु में S-VYASA के दीक्षांत समारोह का आयोजन", "देशभर से पहुंचे छात्र"]);
    expect(line1(d).startsWith("#Delhi: बेंगलुरु में")).toBe(true);
    expect(d.headingPlace).toMatchObject({ source: "reporter_rule", placement: "lead", card: "Delhi" });
    expect(police(d)).toEqual([]);
  });

  it.each(["NIRMAL", "NARESH", "DINESH_KASANA"])("P3: %s's Jaipur rule never goes on an outside story: #FirstIndiaNews #Bengaluru", (token) => {
    const d = draft(fileFor(token), ["बेंगलुरु में S-VYASA के दीक्षांत समारोह का आयोजन", "देशभर से पहुंचे छात्र"]);
    expect(allTags(d)).not.toContain("Jaipur");
    expect(d.hashtags).toEqual([`#${BRAND_NATIONAL}`, "#Bengaluru"]);
    expect(police(d)).toEqual([]);
  });

  it("a place the desk wrote still wins over the rule", () => {
    const d = draft(fileFor("ASHVINI"), ["#Punjab: चंडीगढ़ में किसानों का प्रदर्शन", ...POINTS]);
    expect(line1(d).startsWith("#Punjab")).toBe(true);
    expect(allTags(d)).not.toContain("Delhi");
  });
});

describe("headingPlace: one decision for line 1 and the card", () => {
  it("D1: the card place is always the post's city: the town when one is written, else the district's English name", () => {
    const cases: [string[], string | null][] = [
      [["चित्तौड़गढ़ के रावतभाटा से खबर", "रावतभाटा में हादसा", ...POINTS], "रावतभाटा"],
      [["जोधपुर", "रावतभाटा में हादसा", ...POINTS], "Jodhpur"],
      [["जोधपुर", "हाईवे पर हादसा", ...POINTS], "Jodhpur"],
      [["सवाई माधोपुर", "हाईवे पर हादसा", ...POINTS], "Sawai Madhopur"],
    ];
    for (const [lines, card] of cases) expect(draft(fileFor(null), lines).headingPlace.card, lines[0]).toBe(card);
  });

  it("the composer's city tags are listed, so learning and the review list can tell them from the desk's", () => {
    const d = draft(fileFor("RITURAJ"), ["सरकार ने जारी किए नए दिशा-निर्देश", ...POINTS]);
    expect(d.headingPlace.tags).toEqual(["#Jaipur"]);
    const l = draft(fileFor(null), ["बूंदी के नैनवां से खबर", "मां कंकाली की सवारी", ...POINTS]);
    expect(l.headingPlace.tags).toEqual(["#Bundi", "#नैनवां"]);
  });
});

describe("review fixes and owner decisions of 23 Nov 2026", () => {
  it("B1: the desk's own tag run with a stated district: no #Alwar on the post, none logged, none in headingPlace", () => {
    const d = draft(fileFor("VIKAS"), ["अलवर", "#आकोला: खेत में मिला शव", ...POINTS]);
    expect(line1(d)).toBe("#आकोला: खेत में मिला शव");
    expect(allTags(d)).not.toContain("Alwar");
    expect(d.proposals.some((p) => p.item === "#Alwar")).toBe(false);
    expect(d.headingPlace).toMatchObject({ placement: "copy", source: "copy", tags: [], card: "आकोला", cardHeadline: "आकोला: खेत में मिला शव" });
    // The same with the district from the file code
    const coded = draft(fileFor("VIKAS", "ALW"), ["#आकोला: खेत में मिला शव", ...POINTS]);
    expect(coded.proposals.some((p) => p.item === "#Alwar")).toBe(false);
  });

  it("B2 + Q2: a place the desk wrote is the city (a prefix, a known place tag, an unknown word leading line 1's run): no #Jaipur", () => {
    for (const lines of [["रामपुरा खुर्द: खेत में मिला शव", ...POINTS], ["खेत में मिला शव", "#नैनवा गांव की घटना"], ["#सियोल: मुख्य सचिव का दौरा", ...POINTS]]) {
      const d = draft(fileFor("VIKAS"), lines);
      expect(allTags(d), lines[0]).not.toContain("Jaipur");
      expect(d.headingPlace.placement, lines[0]).toBe("copy");
    }
    // The prefix the desk wrote stays in line 1
    expect(line1(draft(fileFor("VIKAS"), ["रामपुरा खुर्द: खेत में मिला शव", ...POINTS]))).toBe("रामपुरा खुर्द: खेत में मिला शव");
  });

  it("B3: the district said twice behind a town tag moves to the tag line, with the town (as D3)", () => {
    const d = draft(fileFor(null), ["उदयपुर के गोगुंदा से खबर", "उदयपुर SP डॉ.अमृता दुहन के निर्देशन में नशे के खिलाफ कार्रवाई", ...POINTS]);
    expect(line1(d).startsWith("उदयपुर SP")).toBe(true);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`, "#Udaipur", "#गोगुंदा"]);
    expect(d.headingPlace).toMatchObject({ placement: "trailing", card: null, town: "गोगुंदा" });
  });

  it("B4: spelling-tolerant town match: a nasal variant, and a town written as two words", () => {
    const nainwa = draft(fileFor(null), ["बूंदी के नैनवां से खबर", "नैनवा में मां कंकाली की सवारी", ...POINTS]);
    expect(line1(nainwa)).toBe("#Bundi #नैनवां में मां कंकाली की सवारी");
    const badi = draft(fileFor(null), ["चित्तौड़गढ़ के बड़ीसादड़ी से खबर", "बड़ी सादड़ी में सड़क हादसा", ...POINTS]);
    expect(badi.headingPlace.placement).toBe("inline");
    expect(line1(badi).replace(/^#\S+ /, "")).toBe(`${badi.headingPlace.tags.at(-1)} में सड़क हादसा`);
  });

  it("D3: the reporter rule and Ashvini's #Delhi go to the tag line when the headline opens with that city", () => {
    const nirmal = draft(fileFor("NIRMAL"), ["जयपुर में पर्यटन विभाग की बैठक", ...POINTS]);
    expect(line1(nirmal)).toBe("जयपुर में पर्यटन विभाग की बैठक");
    expect(nirmal.hashtags).toContain("#Jaipur");
    expect(nirmal.headingPlace).toMatchObject({ source: "reporter_rule", placement: "trailing", card: null });
    const ashvini = draft(fileFor("ASHVINI"), ["दिल्ली में संसद का शीतकालीन सत्र शुरू", ...POINTS]);
    expect(line1(ashvini)).toBe("दिल्ली में संसद का शीतकालीन सत्र शुरू");
    expect(ashvini.hashtags).toContain("#Delhi");
  });

  it("step 4 (owner, 23 Nov): Navin, JPR, \"डूंगरपुर में ACB कार्रवाई\" → #Dungarpur, not #Jaipur", () => {
    const d = draft("BTN_RJ_BREAKING_6043_12NOV_US_NAVIN_JPR_BIG_FULL.txt", ["डूंगरपुर में ACB कार्रवाई", "ACB ने झोतरी CHC के प्रभारी को किया ट्रैप"]);
    expect(allTags(d)).toContain("Dungarpur");
    expect(allTags(d)).not.toContain("Jaipur");
    expect(police(d)).toEqual([]);
  });

  it("step 4 (owner, 23 Nov): a file code that decides when the text names no district is unchanged (Navin's IAS stories of 18 Nov, '#Jaipur:' as the desk wrote them)", () => {
    for (const name of ["BTN_RJ_BREAKING_6102_18NOV_US_CONTROL_NAVIN_JPR_BIG.txt", "BTN_RJ_BREAKING_6165_18NOV_US_CONTROL_Navin_JPR_BIG.txt"]) {
      const d = draft(name, ["IAS शिखर अग्रवाल FIR प्रकरण !", "ACB ने दर्ज की FIR"]);
      expect(line1(d)).toBe("#Jaipur: IAS शिखर अग्रवाल FIR प्रकरण !");
      expect(d.headingPlace).toMatchObject({ source: "file_code", placement: "lead", card: "Jaipur" });
      expect(police(d)).toEqual([]);
    }
  });

  it("order: a file code leads before #Jaipur; the text's district before an untrusted code and #Jaipur (Rajasthan stories)", () => {
    const coded = draft(fileFor("NAVIN", "JPR"), ["ACB ने रिश्वत लेते अधिकारी को दबोचा", ...POINTS]);
    expect(line1(coded).startsWith("#Jaipur: ")).toBe(true);
    expect(coded.headingPlace.source).toBe("file_code");
    const text = draft(fileFor("VIKAS"), ["सीकर के खाटूश्यामजी मेले की तैयारी पूरी", ...POINTS]);
    expect(text.headingPlace).toMatchObject({ source: "inferred", placement: "trailing" });
    expect(allTags(text)).not.toContain("Jaipur");
  });

  it("noCity is false whenever a city was found; true on a Rajasthan story naming no place (24 Nov 2026)", () => {
    expect(draft(fileFor("VIKAS"), ["टोंक", "टोंक में हादसा", ...POINTS]).noCity).toBe(false);
    expect(draft(fileFor("RITURAJ"), ["सरकार ने जारी किए नए दिशा-निर्देश", ...POINTS]).noCity).toBe(false);
    expect(draft(fileFor("VIKAS"), ["सरकार ने जारी किए नए दिशा-निर्देश", ...POINTS]).noCity).toBe(true);
  });
});

describe("round 3 (owner, 23 Nov 2026 evening): R1–R8, Q1, Q2", () => {
  it("R1: a bureau reporter's file code gives way to a district in the first two points; a district reporter's code still wins", () => {
    const navin = draft("BTN_RJ_BREAKING_6200_23NOV_US_CONTROL_NAVIN_JPR_BIG.txt", ["ACB ने रिश्वत लेते अधिकारी को दबोचा", "उदयपुर में ACB की टीम ने की कार्रवाई", "आरोपी से पूछताछ जारी"]);
    expect(allTags(navin)).toContain("Udaipur");
    expect(allTags(navin)).not.toContain("Jaipur");
    expect(navin.headingPlace).toMatchObject({ source: "inferred", placement: "trailing" });
    // A district beyond the first two points is outside the window: the code stands
    const far = draft("BTN_RJ_BREAKING_6201_23NOV_US_CONTROL_NAVIN_JPR_BIG.txt", ["ACB ने रिश्वत लेते अधिकारी को दबोचा", "आरोपी से पूछताछ जारी", "विभाग में हड़कंप", "उदयपुर में भी जांच"]);
    expect(line1(far).startsWith("#Jaipur: ")).toBe(true);
    // A district reporter (two districts, not a bureau, no desk rule) filing under a code that is not one of them: the code
    // is not trusted as the story's district, and it still wins over the text (owner: "for district reporters the file code
    // still wins"). No such reporter exists in the shipped file, so one is made here.
    const two = parseReporterHandles({ version: 1, entries: [{ handle: "@two_district", handle_type: "person", names_en: ["TWODIST"], districts: ["Jaipur", "Delhi"], verified: true }] });
    const name = "BTN_RJ_BREAKING_6202_23NOV_US_CONTROL_TWODIST_KTA_BIG.txt";
    const p = parseBreaking(`${name.replace(/.txt$/, "")}

सड़क सुरक्षा पर बैठक आज
उदयपुर में भी होगी समीक्षा
`, name, book);
    const slot = slotFromTags(p.tags);
    const d = composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district }, rules, book, { ...opts, reporters: two });
    // A district reporter's untrusted code still wins over a district in the points (only the HEADLINE's opening beats it: P9)
    expect(d.headingPlace).toMatchObject({ source: "file_code", placement: "lead" });
    expect(line1(d).startsWith("#Kota: ")).toBe(true);
  });

  it("R2: a town of three words said at the headline's start takes its tag in place, never twice", () => {
    const d = draft(fileFor(null), ["नीम का थाना", "नीम का थाना में सड़क हादसा", ...POINTS]);
    expect(line1(d)).not.toMatch(/#नीमकाथाना: नीम का थाना/);
    expect(d.headingPlace.placement).toBe("inline");
    expect(line1(d)).toMatch(/^#Sikar #नीमकाथाना में सड़क हादसा$/);
  });

  it("R3: a place word in a compound or route is never replaced by its tag on line 1", () => {
    const d = draft(fileFor(null), ["चित्तौड़गढ़ के बेगूं से खबर", "बेगूं-चित्तौड़गढ़ मार्ग पर हादसा", ...POINTS]);
    expect(line1(d)).toContain("बेगूं-चित्तौड़गढ़ मार्ग पर हादसा");
    expect(d.headingPlace.placement).toBe("lead");
  });

  it("R7: a district the headline already tags is recorded as the post's city, never proposed as the composer's", () => {
    const d = draft(fileFor(null), ["जयपुर के चौमूं से खबर", "#Jaipur पुलिस की बड़ी कार्रवाई", ...POINTS]);
    expect(d.bodyText).toContain("#Jaipur");
    expect(d.headingPlace.tags).not.toContain("#Jaipur");
    expect(d.proposals.some((p) => p.item === "#Jaipur" && p.layer === "emit")).toBe(false);
  });

  it("R8: a national place on the card keeps its spaces", () => {
    const d = composeBreaking({ headline: "बड़ा फैसला", points: ["सरकार ने जारी किए आदेश"], district: "UttarPradesh", town: null, rajasthan: false, leaderPost: false }, rules, book, opts);
    expect(d.headingPlace.card).toBe("Uttar Pradesh");
  });

  it("P3 (owner, 25 Nov 2026, replacing Q1 (a)): a Jaipur reporter rule never goes on a national story", () => {
    const kasana = draft("BTN_NWS_BREAKING_7001_23NOV_US_CONTROL_DINESH_KASANA_BIG.txt", ["दिल्ली में संसद सत्र शुरू", "विपक्ष का हंगामा"]);
    expect(kasana.hashtags[0]).toBe(`#${BRAND_NATIONAL}`);
    expect(kasana.headingPlace.source).toBe("inferred");
    expect(allTags(kasana)).not.toContain("Jaipur");
    expect(allTags(kasana)).toContain("Delhi");
    const nobody = draft("BTN_NWS_BREAKING_7002_23NOV_US_CONTROL_BIG.txt", ["दिल्ली में संसद सत्र शुरू", "विपक्ष का हंगामा"]);
    expect(allTags(nobody)).toContain("Delhi");
    expect(allTags(nobody)).not.toContain("Jaipur");
  });

  it("Q2: a party, topic or label hashtag is not a city: the chain goes on, and a national story is flagged no_city", () => {
    const bjp = draft(fileFor("VIKAS"), ["#भाजपा: प्रदेश कार्यसमिति की बैठक आज", ...POINTS]);
    expect(bjp.headingPlace.placement).not.toBe("copy");
    expect(bjp.noCity).toBe(true);
    expect(allTags(bjp)).not.toContain("Jaipur");
    const sc = composeBreaking({ headline: "यमुना प्रदूषण पर सख्ती #सुप्रीमकोर्ट", points: ["सरकार से मांगा जवाब"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, opts);
    expect(sc.noCity).toBe(true);
    // An unknown single word leading line 1's run is the desk's place; a known town in any spelling counts anywhere
    expect(draft(fileFor("VIKAS"), ["#आकोला: खेत में मिला शव", ...POINTS]).headingPlace.placement).toBe("copy");
    expect(draft(fileFor("VIKAS"), ["खेत में मिला शव", "#बून्दी जिले की घटना"]).headingPlace.placement).toBe("copy");
    expect(deskPlaceTag(book, "भाजपा", true)).toBe(false);
    expect(deskPlaceTag(book, "सुप्रीमकोर्ट", true)).toBe(false);
    expect(deskPlaceTag(book, "आकोला", true)).toBe(true);
    expect(deskPlaceTag(book, "आकोला", false)).toBe(false);
    expect(deskPlaceTag(book, "नैनवा", false)).toBe(true);
  });
});

describe("the desk's own cases of 24 Nov 2026 (owner: no #Jaipur fallback)", () => {
  const live = (name: string, lines: string[]) => draft(name, lines);
  it("Merta: #Nagaur #मेड़ता: as before, card मेड़ता", () => {
    const d = live("BTN_RJ_BREAKING_1013_24NOV_MS_CONTROL_Ngr8_big.txt", ["नागौर के मेड़ता सिटी से खबर", "बारात की कार व बाइक में टक्कर", "बाइक सवार एक व्यक्ति की मौत, दो जने हुए घायल"]);
    expect(line1(d)).toBe("#Nagaur #मेड़ता: बारात की कार व बाइक में टक्कर");
    expect(d.headingPlace.card).toBe("मेड़ता");
  });
  it.each([
    ["Navin ACB (no code)", "btn_rj_breaking_6010_24nov_us_control_navin_karari_big.txt", ["RAS हरसहाय मीणा की अभियोजन स्वीकृति का ACB को इंतजार", "2013 में ACB ने दर्ज किया था पद के दुरुपयोग का मुकदमा"]],
    ["Amitabh / UP ATS", "btn_rj_breaking_24Nov_vks_1505_control_tv_big_breaking.txt", ["अमिताभ बच्चन के घर, सिंगर दिलजीत दोसांझ के शो को लेकर धमकी का मामला", "UP ATS ने बम धमकी वाले ई-मेल मामले में बड़ा खुलासा किया"]],
  ])("%s: no #Jaipur on the post or the card; flagged no_city, places offered", (_label, name, lines) => {
    const d = live(name, lines);
    expect(allTags(d)).not.toContain("Jaipur");
    expect(d.headingPlace).toMatchObject({ placement: "none", card: null });
    expect(d.noCity).toBe(true);
    expect(d.hashtagSuggestions).toContain("#Jaipur");
  });
  it("Delhi cabinet (P3, 25 Nov 2026): a national story, #FirstIndiaNews #Delhi, no #Jaipur anywhere (\"दिल्लीः\" with a visarga for the colon)", () => {
    const d = live("btn_rj_breaking_24Nov_vks_1643_control_tv_big_breaking.txt", ["दिल्लीः केंद्रीय कैबिनेट की कल बैठक होगी", "कल सुबह 11 बजे कैबिनेट की बैठक"]);
    expect(d.hashtags).toEqual([`#${BRAND_NATIONAL}`, "#Delhi"]);
    expect(allTags(d)).not.toContain("Jaipur");
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
  });
});
