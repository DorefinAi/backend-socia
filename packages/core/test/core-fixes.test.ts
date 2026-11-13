// The core fix batch of 13 Nov 2026 (R2–R4, S1–S4, O1–O3): one describe per fix, each pinned with the copy that
// showed it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND_NATIONAL, BRAND_RAJASTHAN, PlaceBook, namesOffice, composePostTags, deskPlacePrefix, inferHeadlineDistrict, composeBreaking, isHeadlineLabel, parseBeatHandles, parseBreaking, parseHashtagNormalise, slotFromTags, type BreakingDraft, parseDistricts, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, reporterPrior } from "../src";
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

// ─── O3: the reference composer follows the same desk rule ───────────────────

describe("O3: composePostTags applies rituraj's rule as composeBreaking does", () => {
  const ctx = {
    places, normaliser, reporterPolicy: "Jaipur",
    inferDistrict: (h: string) => inferHeadlineDistrict(book, h)?.tag ?? null,
    deskPlacePrefix: (h: string) => { const p = deskPlacePrefix(book, h); return !!p && !isHeadlineLabel(p); },
  };
  const { reporterPolicy: _drop, ...without } = ctx;

  it("a district the gazetteer infers no longer blocks it: #Jaipur leads, the inferred district is offered", () => {
    const t = composePostTags("डूंगरपुर में ACB कार्रवाई\n\nप्रभारी को रिश्वत लेते दबोचा\n\n#RajasthanWithFirstIndia", ctx);
    expect([t.lead, t.policy]).toEqual([["Jaipur"], "emit"]);
    expect(t.suggest).toContain("Dungarpur");
  });
  it("it never changes the brand: a national story keeps #FirstIndiaNews with or without the rule", () => {
    const text = "फ्रांस में सरकार के खिलाफ प्रदर्शन\n\nपेरिस में हजारों लोग सड़कों पर उतरे";
    const withRule = composePostTags(text, ctx);
    expect(withRule.lead).toEqual(["Jaipur"]);
    expect(withRule.trail).toEqual([BRAND_NATIONAL]);
    expect(withRule.trail).toEqual(composePostTags(text, without).trail);
  });
  it("what the desk wrote blocks it: a place tag (#JodhpurNews), its own tag run (#BJP:), a place before the colon", () => {
    for (const text of [
      "ग्राम पंचायत में पुनर्मतदान\n\nमतपत्र चोरी के चलते फैसला #JodhpurNews\n\n#RajasthanWithFirstIndia",
      "#BJP: प्रदेश कार्यकारिणी की बैठक\n\nनेताओं ने भाग लिया\n\n#RajasthanWithFirstIndia",
      "रामपुरा खुर्द: ग्रामीणों का प्रदर्शन\n\nपानी की समस्या\n\n#RajasthanWithFirstIndia",
    ]) {
      const t = composePostTags(text, ctx);
      expect(t.policy, text).toBeNull();
      expect(t.lead, text).not.toContain("Jaipur");
    }
    // A label before the colon does not
    expect(composePostTags("पंचायत चुनाव: सुबह 10 बजे तक 20 प्रतिशत मतदान\n\nलंबी कतारें\n\n#RajasthanWithFirstIndia", ctx).lead).toEqual(["Jaipur"]);
  });
  it("parity: on the same copy the reference composer and composeBreaking fire (or not) together", () => {
    const cases: string[][] = [
      ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"],
      ["डूंगरपुर में ACB कार्रवाई", "प्रभारी को रिश्वत लेते दबोचा"],
      ["ग्राम पंचायत में पुनर्मतदान", "मतपत्र चोरी के चलते फैसला #JodhpurNews"],
      ["केजरीवाल ने की प्रेस कॉन्फ्रेंस #DelhiNews", "भाजपा पर साधा निशाना"],
      ["रामपुरा खुर्द: ग्रामीणों का प्रदर्शन", "पानी की समस्या"],
      ["पंचायत चुनाव: सुबह 10 बजे तक 20 प्रतिशत मतदान", "लंबी कतारें"],
      ["#BJP: प्रदेश कार्यकारिणी की बैठक", "नेताओं ने भाग लिया"],
    ];
    for (const [h, pt] of cases) {
      const live = draft(RITURAJ, [h!, pt!]).districtSource === "reporter_policy";
      const ref = composePostTags(`${h}\n\n${pt}\n\n#RajasthanWithFirstIndia`, ctx).policy === "emit";
      expect(ref, h).toBe(live);
    }
  });
});

// ─── S1 / S2 / S4: the CS and CM office aliases ──────────────────────────────

describe("S1: the Chief Secretary uses the CM's 'MP/UP only beside the alias' rule; everyday English does not exclude it", () => {
  const cs = subjects.offices!.find((o) => o.key === "rajasthan_cs")!;
  it("'set up', 'follow up', 'ex-servicemen', 'सांसद/MP ने ...': still the Rajasthan CS", () => {
    for (const t of [
      "Chief Secretary set up a committee", "Chief Secretary will follow up on the flood relief", "मुख्य सचिव ने ex-servicemen से मुलाकात की",
      "सांसद/MP ने मुख्य सचिव से मुलाकात की", "MP ने CS से की मुलाकात", "UP से आए अधिकारियों ने मुख्य सचिव से की मुलाकात",
    ]) expect(namesOffice(cs, t), t).toBe(true);
  });
  it("'MP के मुख्य सचिव', 'UP CS', 'MP-CS', 'एमपी के मुख्य सचिव': another state's", () => {
    for (const t of ["MP के मुख्य सचिव", "UP CS ने कहा", "MP-CS ने कहा", "एमपी के मुख्य सचिव पहुंचे", "Chief Secretary of MP"]) expect(namesOffice(cs, t), t).toBe(false);
  });
  it("'Ex' and 'Former' in their own sense still exclude: 'Ex CS', 'Ex-CS', 'Former Chief Secretary', 'पूर्व मुख्य सचिव'", () => {
    for (const t of ["Ex CS writes to the CM", "Ex-CS writes to the CM", "EX Chief Secretary joins BJP", "Former Chief Secretary joins BJP", "former Chief Secretary joins BJP", "पूर्व मुख्य सचिव ने साधा निशाना", "MP के पूर्व CS का निधन"]) {
      expect(namesOffice(cs, t), t).toBe(false);
    }
  });
  it("on a draft: 'मुख्य सचिव ने ex-servicemen से की मुलाकात' is offered", () => {
    const d = draft(fileFor(null, "JPR3"), ["मुख्य सचिव ने ex-servicemen से की मुलाकात", "समस्याओं के समाधान का भरोसा दिलाया"]);
    expect(d.handleSuggestions.filter((h) => h.reason === "office").map((h) => h.handle)).toContain("svoruganti1466");
  });
});

describe("S2: the CS and the CM read one shared list of other states", () => {
  const cs = subjects.offices!.find((o) => o.key === "rajasthan_cs")!;
  const cm = subjects.offices!.find((o) => o.key === "rajasthan_cm")!;
  it("'छत्तीसगढ़ के मुख्य सचिव', 'Karnataka Chief Secretary meets', 'मप्र के मुख्य सचिव' and the rest: none", () => {
    for (const t of ["छत्तीसगढ़ के मुख्य सचिव ने ली बैठक", "Karnataka Chief Secretary meets the delegation", "मप्र के मुख्य सचिव पहुंचे", "केरल के मुख्य सचिव", "West Bengal Chief Secretary", "तेलंगाना के CS"]) {
      expect(namesOffice(cs, t), t).toBe(false);
    }
  });
  it("every state on the shared list excludes both offices", () => {
    const json = cfg("subject-handles.json");
    const states: string[] = json.office_exclusion_lists.other_states;
    expect(states.length).toBeGreaterThanOrEqual(45);
    for (const s of states) {
      expect(namesOffice(cs, `${s} के मुख्य सचिव ने कहा`), s).toBe(false);
      expect(namesOffice(cm, `${s} के मुख्यमंत्री ने कहा`), s).toBe(false);
    }
  });
  it("the CM's exclusions are exactly what they were before the list was shared", () => {
    const before = [
      "पूर्व", "दिल्ली", "मध्यप्रदेश", "मध्य प्रदेश", "मप्र", "यूपी", "उत्तर प्रदेश", "पंजाब", "गुजरात", "हरियाणा", "महाराष्ट्र", "बिहार", "छत्तीसगढ़", "कर्नाटक",
      "बंगाल", "पश्चिम बंगाल", "गोवा", "तमिलनाडु", "केरल", "असम", "ओडिशा", "झारखंड", "उत्तराखंड", "हिमाचल", "तेलंगाना", "आंध्र", "आंध्र प्रदेश", "मोहन यादव", "योगी",
      "रेखा गुप्ता", "भगवंत मान", "फडणवीस", "नीतीश", "गहलोत", "डिप्टी", "Deputy", "उप", "Former", "Ex", "Delhi", "Madhya Pradesh", "Uttar Pradesh", "Bihar",
      "Punjab", "Gujarat", "Haryana", "Maharashtra", "Chhattisgarh", "Karnataka", "Bengal", "West Bengal", "Goa", "Tamil Nadu", "Kerala", "Assam", "Odisha",
      "Jharkhand", "Uttarakhand", "Himachal", "Telangana", "Andhra", "Andhra Pradesh", "Yogi", "Rekha Gupta", "Mohan Yadav", "Gehlot", "Nitish", "Mann",
      "Bhagwant Mann", "Fadnavis",
    ];
    const json = cfg("subject-handles.json");
    const now = [...json.offices.rajasthan_cm.exclude_same_sentence, ...json.office_exclusion_lists.other_states];
    expect(new Set(now)).toEqual(new Set(before));
  });
  it("a list an office names that does not exist, or a malformed shared list, rejects the file", () => {
    const json = cfg("subject-handles.json");
    expect(() => parseSubjectHandles({ ...json, offices: { ...json.offices, rajasthan_cs: { ...json.offices.rajasthan_cs, exclude_same_sentence_lists: ["other_statez"] } } })).toThrow(/not a list in office_exclusion_lists/);
    expect(() => parseSubjectHandles({ ...json, office_exclusion_lists: { other_states: "Delhi" } })).toThrow(/must be a list of words/);
  });
});

describe("S4: the CM next to a code with a hyphen, a slash or the Hindi code", () => {
  const cm = subjects.offices!.find((o) => o.key === "rajasthan_cm")!;
  it("'एमपी के सीएम', 'MP-CM ने कहा', 'UP/CM', 'यूपी के मुख्यमंत्री': no CM suggestion", () => {
    for (const t of ["एमपी के सीएम ने की घोषणा", "MP-CM ने कहा", "MP - CM ने कहा", "UP/CM का दौरा", "यूपी के मुख्यमंत्री पहुंचे", "एमपी सीएम का बयान"]) expect(namesOffice(cm, t), t).toBe(false);
    const d = draft(fileFor(null, "JPR3"), ["एमपी के सीएम ने की घोषणा", "किसानों को मिलेगा लाभ"]);
    expect(d.handleSuggestions.filter((h) => h.reason === "office").map((h) => h.handle)).toEqual([]);
  });
  it("an MP (सांसद) meeting the CM still offers the CM", () => {
    for (const t of ["MP ने CM से मुलाकात की", "सांसद/MP ने CM से मुलाकात की", "एमपी ने सीएम से की मुलाकात"]) expect(namesOffice(cm, t), t).toBe(true);
  });
});

// ─── O2: one bad reporter entry takes down that entry only ───────────────────

describe("O2: a bad entry in reporter-handles.json rejects only that entry, named by its handle", () => {
  const shipped = cfg("reporter-handles.json");
  const victimIndex = shipped.entries.findIndex((e: { handle: string; verified: boolean }) => e.verified && !/rituraj/i.test(e.handle));
  const victim = shipped.entries[victimIndex];
  const victimKey = victim.handle.replace(/^@/, "").toLowerCase();
  const corrupt = (patch: Record<string, unknown>) => ({ ...shipped, entries: shipped.entries.map((e: object, i: number) => (i === victimIndex ? { ...e, ...patch } : e)) });
  const NONE = ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"];

  for (const [label, patch] of [
    ["a bad prior", { prior: { n: 50, handles: { RajGovOfficial: 1.5 } } }],
    ["prior_settings inside the entry", { prior_settings: { m: 20 } }],
    ["a bad policy block", { policy: "Jaipur" }],
  ] as const) {
    it(`${label}: that reporter is out, with a message naming the handle; the rest load, and rituraj's #Jaipur still works`, () => {
      const problems: string[] = [];
      const r = parseReporterHandles(corrupt(patch), (m) => problems.push(m), { directory });
      expect(problems.filter((m) => /entry REJECTED/.test(m)), label).toHaveLength(1);
      expect(problems.join(" ")).toContain(`@${victim.handle.replace(/^@/, "")}): entry REJECTED`);
      expect(r.profiles!.has(victimKey)).toBe(false);
      expect([...r.byToken.values()].some((m) => m.handle.toLowerCase() === victimKey)).toBe(false);
      // Everyone else is still there
      expect(r.profiles!.size).toBe(reporters.profiles!.size - 1);
      // The #Jaipur desk rule runs from the partly-loaded file
      const p = parseBreaking(fileText(RITURAJ, NONE), RITURAJ, book);
      const slot = slotFromTags(p.tags);
      const d = composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district }, rules, book, { subjects, reporters: r, parties });
      expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
      expect(d.districtSource).toBe("reporter_policy");
    });
  }

  it("file-level shape errors: ambiguous_tokens of the wrong type rejects the file (safer: a shared token could byline the wrong colleague)", () => {
    expect(() => parseReporterHandles({ ...shipped, ambiguous_tokens: "DINESH" })).toThrow(/ambiguous_tokens/);
  });
  it("file-level shape errors: bad prior_settings keep every byline and the desk rule, with the measured prior OFF", () => {
    const problems: string[] = [];
    const r = parseReporterHandles({ ...shipped, prior_settings: "m=20" }, (m) => problems.push(m), { directory });
    expect(r.profiles!.size).toBe(reporters.profiles!.size);
    expect([...r.profiles!.values()].every((p) => p.prior === null)).toBe(true);
    expect(r.profiles!.get("rituraj9999")!.districtWhenMissing).toBe("Jaipur");
    expect(problems.join(" ")).toMatch(/measured reporter prior is OFF.*prior_settings/);
  });
});
