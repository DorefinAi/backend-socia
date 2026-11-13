// Phase 1: breaking file names, folders, the parser, the composer and the handle rules, on small fixtures
// made from real files (reporter names replaced by placeholders).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_SEED_RULES, EMPTY_HANDLE_RULES, LINKING_WORDS, PlaceBook, actingAgents, assemblePostText, composeBreaking, daysToScan, dayFolderName,
  fileTags, hashtagGazetteer, isBreakingFileName, matchDayFolder, matchMonthFolder, parseBreaking, parseHandleRules,
  parsePlacesData, parseSubjectHandles, phaseFeatures, phaseFrom, pickCategoryTags, pickHandles, xLen,
  breakingDots, crispPoints, plainHeadline, BREAKING_BODY_FLOOR, BREAKING_BODY_MAX, BREAKING_BODY_MIN, BREAKING_POST_MAX,
} from "../src";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/breaking/${name}`, import.meta.url), "utf8");
const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
/** The org's topic rules as the category seed installs them */
const topics = hashtagGazetteer(
  CATEGORY_SEED_RULES.map((r, i) => ({
    id: `seed${i}`, matchType: "entity" as const, name: r.name, aliases: [...r.aliases], hashtagLatin: r.tag, hashtagDevanagari: null,
    priority: r.priority, negativePhrases: [...(r.negativePhrases ?? [])],
  })),
);
const parse = (name: string) => parseBreaking(fixture(name), name, book);
const post = (name: string) => {
  const s = parse(name);
  const d = composeBreaking(s, rules, book, { topics });
  return { s, d, text: assemblePostText(d.bodyText, d.hashtags, d.mentions) };
};

describe("breaking file names", () => {
  it("takes BREAKING .txt files only", () => {
    expect(isBreakingFileName("BTN_RAJ_BREAKING_1300_29OCT_NDR_X_BIG.txt")).toBe(true);
    expect(isBreakingFileName("btn_rj_breaking_29Oct_vks_1501_control_KTA4_big_breaking_full.txt")).toBe(true);
    expect(isBreakingFileName("दbtn_rj_breaking_1_29OCT.txt")).toBe(true);
    expect(isBreakingFileName("BTN_RAJ_SCROLL_1_29OCT_NDR_SET.txt")).toBe(false);
    expect(isBreakingFileName("nat_flash_rj_breaking_601_bps_29OCT_control_TV_BIG.txt")).toBe(false);
    expect(isBreakingFileName("nat_fash_rj_breaking_602.txt")).toBe(false);
    expect(isBreakingFileName("BTN_RAJ_BREAKING_1.odt")).toBe(false);
    expect(isBreakingFileName("BTN_RJ_BRAKING_2001_29OCT.txt")).toBe(true);
    expect(isBreakingFileName("BTN_RJ_BREKING_2001_29OCT.txt")).toBe(true);
    expect(isBreakingFileName("BTN_RJ_BREAK_2001_29OCT.txt")).toBe(true);
    expect(isBreakingFileName("BTN_RJ_BREAK_SCROLL_29OCT.txt")).toBe(false);
    expect(isBreakingFileName("a.txtbtn_rj_breaking_2.txt")).toBe(false);
  });

  it("reads the tags in any order and case", () => {
    expect(fileTags("BTN_RAJ_BREAKING_1303_29OCT_NDR_Reporter_BIG_FULL.txt", book.codes)).toMatchObject({
      big: true, full: true, update: false, desk: "NDR", reporter: "REPORTER", date: "29OCT", districtCode: null,
    });
    expect(fileTags("btn_rj_breaking_29Oct_vks_1501_control_KTA4_big_breaking_full.txt", book.codes)).toMatchObject({ districtCode: "KTA", district: "Kota", desk: "VKS", big: true, full: true });
    expect(fileTags("BTN_RJ_BREAKING_6006_29OCT_US_CONTROLL_Name_dl_big.txt", book.codes)).toMatchObject({ district: "Delhi", desk: "US", reporter: "NAME" });
    expect(fileTags("BTN_RJ_BREAKING_29OCT_2725_AM_CONTROL_PRG5_BIG_UPDATE_.txt", book.codes)).toMatchObject({ district: "Pratapgarh", update: true, desk: "AM" });
    expect(fileTags("x_18SPET_KARARI_EXCLUSIVE_PHOTO_WEB_TV.txt", book.codes)).toMatchObject({ date: "18SPET", exclusive: true, photo: true, web: true, tv: true, other: ["KARARI"] });
  });
});

describe("day folders", () => {
  it("finds today's folder by loose rules, in India time", () => {
    const at = new Date("2026-10-30T20:00:00Z"); // 01:30 on the 31st in India
    const { today, yesterday } = daysToScan(at);
    expect(today).toEqual({ year: 2026, month: 10, day: 31 });
    expect(yesterday).toEqual({ year: 2026, month: 10, day: 30 });
    // Yesterday all day: late files land in it (a 28_OCTOBER file saved at 06:54 on the 29th)
    expect(daysToScan(new Date("2026-10-31T06:00:00Z")).yesterday).toEqual({ year: 2026, month: 10, day: 30 });
    expect(dayFolderName(today)).toBe("31_OCTOBER_2026");

    const top = ["2025", "2024", "JANUARAY_2026", "MARCH 2026", "MAY_2026", "OCTOBER_2026", "Thumbs.db"];
    expect(matchMonthFolder(top, { year: 2026, month: 1, day: 5 })).toBe("JANUARAY_2026");
    expect(matchMonthFolder(top, { year: 2026, month: 3, day: 5 })).toBe("MARCH 2026");
    expect(matchMonthFolder(top, { year: 2025, month: 4, day: 5 })).toBeNull(); // never into 2025\APRIL_2025
    expect(matchDayFolder(["01_SEPTEMBER_2026", "02SEPTEMBER_2026", "12_SEPTEMBER_2026"], { year: 2026, month: 9, day: 2 })).toBe("02SEPTEMBER_2026");
    expect(matchDayFolder(["1_JANUARY_2026", "10_JANUARY_2026"], { year: 2026, month: 1, day: 1 })).toBe("1_JANUARY_2026");
    expect(matchDayFolder(["30_OCTOBER_2026"], { year: 2026, month: 10, day: 3 })).toBeNull();
  });
});

describe("parseBreaking", () => {
  it("drops a byline place line and keeps the reporter's district", () => {
    const s = parse("BTN_RJ_BREAKING_29OCT_2702_AM_CONTROL_REPORTER_KRO_BIG_KARARI_.txt");
    expect(s.district).toBe("Karauli");
    expect(s.districtFrom).toBe("place_line");
    expect(s.headline).toBe("मासलपुर पंचायत समिति की ग्राम पंचायतों में उम्मीदवारों की संख्या ने पोलिंग पार्टी को डाला चिंता में");
    expect(s.points).toHaveLength(3);
  });

  it("reads district and town from 'X के Y से खबर'", () => {
    const s = parse("BTN_RJ_BREAKING_6072_29OCT_US_CONTROL_REPORTER_karari_big.txt");
    expect([s.district, s.town]).toEqual(["Chittorgarh", "निम्बाहेड़ा"]);
    expect(s.headline).toBe("काश, पहले भी जारी हो जाती ऐसी एडवाइजरी !");
  });

  it("joins a line ending in a comma with the next, and flags UPDATE from the name", () => {
    const s = parse("BTN_RAJ_BREAKING_1307_29OCT_NDR_REPORTER_UPDATE_BIG.txt");
    expect([s.district, s.town, s.tags.update, s.tags.desk]).toEqual(["Dausa", "बांदीकुई", true, "NDR"]);
    expect(s.headline).toBe("रेलवे स्टेशन पर यात्रियों की भीड़, स्पेशल ट्रेन चलाने की मांग");
  });

  it("takes out a desk note and flags it", () => {
    const s = parse("BTN_RJ_BREAKING_5101_28OCT_KS_CONTROL_REPORTER_BIG_BREAK_FULL_SCREEN_CM.txt");
    expect(s.deskNote).toContain("फुलस्क्रीन करावें");
    expect(s.needsCheck).toContain("desk_note");
    expect(s.headline).toBe("मुख्यमंत्री भजनलाल शर्मा का आज का प्रस्तावित कार्यक्रम");
    expect(s.needsCheck).not.toContain("no_district"); // state-level news
  });

  it("strips a 'place:' prefix from the headline", () => {
    const s = parse("BTN_RJ_BREAKING_2198_28OCT_mh_CONTROL_AJM3_big.txt");
    expect(s.district).toBe("Beawar");
    expect(s.districtFrom).toBe("headline_prefix");
    expect(s.headline.startsWith("ट्रेन की चपेट")).toBe(true);
  });

  it("finds the district in the text, and marks a leader's post", () => {
    expect(parse("btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt")).toMatchObject({ district: "Kota", districtFrom: "text" });
    const leader = parse("btn_rj_breaking_29Oct_vks_1611_control_MJSM.txt");
    expect(leader.leaderPost).toBe(true);
    expect(leader.needsCheck).toEqual([]);
  });

  describe("hashtag place prefix", () => {
    const file = (headline: string, name = "BTN_RJ_BREAKING_29OCT_2702_AM_CONTROL_JPR_BIG.txt") =>
      parseBreaking(["BTN_RJ_BREAKING_x", headline, "पहला बिंदु यहां है", "दूसरा बिंदु"].join("\n"), name, book);

    it("reads '#Jhalawar #डग:' as district and town, and keeps only the text after the colon", () => {
      const s = file("#Jhalawar #डग: विद्युत विभाग की बड़ी लापरवाही, बड़ा हादसा टला");
      expect([s.district, s.town, s.districtFrom]).toEqual(["Jhalawar", "डग", "headline_prefix"]);
      expect(s.headline).toBe("विद्युत विभाग की बड़ी लापरवाही, बड़ा हादसा टला");
      expect(s.points).toEqual(["पहला बिंदु यहां है", "दूसरा बिंदु"]);
    });

    it("lets '#Alwar:' win over the file code and the CM words", () => {
      const s = file("#Alwar: मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण");
      expect([s.district, s.town, s.districtFrom]).toEqual(["Alwar", null, "headline_prefix"]);
      expect(s.headline).toBe("मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण");
    });

    it("takes a district from a town tag on its own, and an ambiguous town by the district tag", () => {
      const s = file("#डग: विद्युत विभाग की लापरवाही", "x_breaking.txt");
      expect([s.district, s.town, s.headline]).toEqual(["Jhalawar", "डग", "विद्युत विभाग की लापरवाही"]);
      const g = file("#SawaiMadhopur #गंगापुर: सड़क पर जाम", "x_breaking.txt");
      expect([g.district, g.town, g.headline]).toEqual(["Sawai Madhopur", "गंगापुर", "सड़क पर जाम"]);
    });

    it("keeps the prefix in the headline unless every tag is a place: '#Foo:', '#BJP:', '#ब्रेकिंग:'", () => {
      const s = file("#Foo: झालावाड़ में बिजली गुल", "x_breaking.txt");
      expect([s.district, s.town, s.districtFrom, s.headline]).toEqual(["Jhalawar", null, "text", "#Foo: झालावाड़ में बिजली गुल"]);
      const t = file("#Jhalawar #Foo: बिजली गुल", "x_breaking.txt");
      expect(t.headline).toBe("#Jhalawar #Foo: बिजली गुल");
      expect(file("#BJP: कोटा में सभा", "x_breaking.txt")).toMatchObject({ headline: "#BJP: कोटा में सभा", district: "Kota", districtFrom: "text" });
      const b = file("#ब्रेकिंग: झालावाड़: हादसा", "x_breaking.txt");
      expect([b.headline, b.district]).toEqual(["#ब्रेकिंग: झालावाड़: हादसा", "Jhalawar"]);
    });

    it("tags no official on party news under a place tag: '#Congress #Kota:', '#BJP:'", () => {
      for (const headline of ["#Congress #Kota: कोटा में धरना, पुलिस मौजूद", "#BJP: कोटा में धरना, पुलिस मौजूद", "#Kota #भाजपा: कोटा में धरना, पुलिस मौजूद"]) {
        const s = file(headline, "x_breaking.txt");
        expect(s.headline).toBe(headline); // the party tag is not taken off
        expect(s.district).toBe("Kota");
        const d = composeBreaking(s, rules, book, { topics });
        expect(d.mentions).toEqual([]);
        // The desk's own tags are line 1 as written: no "#Kota: " put in front of them
        expect(d.bodyText.split("\n")[0]).toBe(headline);
      }
      // The raw headline line is read too, should a caller pass a headline without its prefix
      const story = { headline: "कोटा में धरना, पुलिस ने संभाला मोर्चा", rawHeadline: "#BJP #Kota: कोटा में धरना, पुलिस ने संभाला मोर्चा", points: ["पुलिस ने की कार्रवाई"], district: "Kota", rajasthan: true, leaderPost: false };
      expect(pickHandles(story, rules)).toEqual([]);
      expect(pickHandles({ ...story, rawHeadline: undefined }, rules)).not.toEqual([]);
    });

    it("keeps a plain party prefix in the headline and tags nobody, with no raw headline passed", () => {
      for (const head of ["भाजपा: कोटा में धरना, पुलिस ने संभाला मोर्चा", "कांग्रेस : कोटा में धरना, पुलिस ने संभाला मोर्चा", "BJP: कोटा में धरना, पुलिस ने संभाला मोर्चा", "Congress: कोटा में धरना, पुलिस ने संभाला मोर्चा", "#BJP: कोटा में धरना, पुलिस ने संभाला मोर्चा"]) {
        const s = file(head, "x_breaking.txt");
        expect([s.headline, s.district, s.town]).toEqual([head, "Kota", null]);
        const { rawHeadline: _raw, ...stored } = s; // as the worker composes: from the stored story, no raw line
        const d = composeBreaking(stored, rules, book, { topics });
        expect(d.mentions).toEqual([]);
        expect(d.bodyText).not.toContain("#भाजपा");
      }
      // A party word on its own line is not a place line either
      expect(parseBreaking(["x_breaking", "भाजपा", "कोटा में धरना", "बिंदु"].join("\n"), "x_breaking.txt", book).town).toBeNull();
    });

    it("keeps one unknown Hindi word before the colon as the town when there is no district: 'आकोला:'", () => {
      const s = file("आकोला: 100 साल पुरानी परंपरा से लगाया नए साल की खुशहाली का अनुमान", "BTN_RAJ_BREAKING_1313_9NOV_NDR_PK_BIG.txt");
      expect([s.district, s.town, s.headline]).toEqual([null, "आकोला", "100 साल पुरानी परंपरा से लगाया नए साल की खुशहाली का अनुमान"]);
      expect(s.needsCheck).toContain("no_district"); // the desk still looks
      expect(composeBreaking(s, rules, book, { topics }).bodyText.split("\n")[0]).toBe("#आकोला: 100 साल पुरानी परंपरा से लगाया नए साल की खुशहाली का अनुमान");
      // A known town still brings its district
      expect(file("डग: बिजली गुल", "x_breaking.txt")).toMatchObject({ district: "Jhalawar", town: "डग", headline: "बिजली गुल" });
      // Not a party, not a generic word, not two words, not with digits
      expect(file("भाजपा: बिजली गुल", "x_breaking.txt")).toMatchObject({ headline: "भाजपा: बिजली गुल", town: null });
      expect(file("ब्रेकिंग: बिजली गुल", "x_breaking.txt")).toMatchObject({ headline: "ब्रेकिंग: बिजली गुल", town: null });
      expect(file("#ब्रेकिंग: बिजली गुल", "x_breaking.txt")).toMatchObject({ headline: "#ब्रेकिंग: बिजली गुल", town: null });
      expect(file("नया गांव: बिजली गुल", "x_breaking.txt").town).toBeNull();
      expect(file("वार्ड15: बिजली गुल", "x_breaking.txt").town).toBeNull();
    });

    it("prefers a Rajasthan district over a national place: '#Delhi #Jaipur:'", () => {
      const s = file("#Delhi #Jaipur: बैठक में फैसला", "x_breaking.txt");
      expect([s.district, s.rajasthan, s.headline]).toEqual(["Jaipur", true, "बैठक में फैसला"]);
      expect(s.needsCheck).not.toContain("place_conflict");
    });

    it("flags tags naming two districts, directly or through a town; the first stands", () => {
      const two = file("#Kota #Jhalawar: बिजली गुल", "x_breaking.txt");
      expect([two.district, two.town, two.headline]).toEqual(["Kota", null, "बिजली गुल"]);
      expect(two.needsCheck).toContain("place_conflict");
      const viaTown = file("#Kota #डग: बिजली गुल", "x_breaking.txt");
      expect([viaTown.district, viaTown.town]).toEqual(["Kota", null]);
      expect(viaTown.needsCheck).toContain("place_conflict");
      expect(file("#Jhalawar #डग: बिजली गुल", "x_breaking.txt").needsCheck).not.toContain("place_conflict");
    });

    it("keeps one unknown one-word Hindi tag after a district as its town: '#Jhalawar #नयागांव:'", () => {
      const s = file("#Jhalawar #नयागांव: सड़क पर जाम", "x_breaking.txt");
      expect([s.district, s.town, s.headline]).toEqual(["Jhalawar", "नयागांव", "सड़क पर जाम"]);
      expect(composeBreaking(s, rules, book, { topics }).bodyText.split("\n")[0]).toBe("#Jhalawar #नयागांव: सड़क पर जाम");
      // Not before the district, not two of them, not a non-place word
      expect(file("#नयागांव #Jhalawar: सड़क पर जाम", "x_breaking.txt").headline).toBe("#नयागांव #Jhalawar: सड़क पर जाम");
      expect(file("#Jhalawar #नयागांव #पुरागांव: जाम", "x_breaking.txt").headline).toBe("#Jhalawar #नयागांव #पुरागांव: जाम");
      expect(file("#Jhalawar #ब्रेकिंग: जाम", "x_breaking.txt").headline).toBe("#Jhalawar #ब्रेकिंग: जाम");
    });

    it("lets the tag win over a place line naming another district, and flags it", () => {
      const s = parseBreaking(["x_breaking", "कोटा", "#Jhalawar: बिजली गुल", "बिंदु"].join("\n"), "x_breaking.txt", book);
      expect([s.district, s.districtFrom, s.headline]).toEqual(["Jhalawar", "headline_prefix", "बिजली गुल"]);
      expect(s.needsCheck).toContain("place_conflict");
      const same = parseBreaking(["x_breaking", "झालावाड़ के डग से खबर", "#Jhalawar: बिजली गुल", "बिंदु"].join("\n"), "x_breaking.txt", book);
      expect([same.district, same.town, same.districtFrom, same.needsCheck]).toEqual(["Jhalawar", "डग", "place_line", []]);
    });

    it("composes line 1 as the desk tagged it, with no repeated or glued tags", () => {
      const line1 = (headline: string) => composeBreaking(file(headline), rules, book, { topics }).bodyText.split("\n")[0];
      expect(line1("#Jhalawar #डग: विद्युत विभाग की बड़ी लापरवाही, बड़ा हादसा टला")).toBe("#Jhalawar #डग: विद्युत विभाग की बड़ी लापरवाही, बड़ा हादसा टला");
      expect(line1("#Alwar: मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण")).toBe("#Alwar: मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण");
    });

    it("leaves 'Jaipur:' and Hindi 'place:' prefixes as before", () => {
      const s = file("मेड़तासिटी : पंच व सरपंच के चुनाव कल", "x_breaking.txt");
      expect(s.headline).toBe("पंच व सरपंच के चुनाव कल");
      expect(s.town).toBe("मेड़तासिटी"); // one unknown word before the colon: the desk's place, kept as the town
      const r = file("रावतभाटा : परमाणु बिजलीघर में मॉक ड्रिल", "x_breaking.txt");
      expect([r.district, r.districtFrom, r.headline]).toEqual(["Chittorgarh", "headline_prefix", "परमाणु बिजलीघर में मॉक ड्रिल"]);
      const j = file("Jaipur: बिजली गुल", "x_breaking.txt");
      expect(j.headline).toBe("Jaipur: बिजली गुल");
    });
  });

  it("never crashes on empty, Latin-only, precomposed-nukta or very long files", () => {
    expect(parse("BTN_RJ_BREAKING_9999_29OCT_US_CONTROL_EMPTY.txt").needsCheck).toContain("empty");
    expect(parseBreaking("x_breaking\nOnly English text here\nmore", "x_breaking.txt", book).needsCheck).toContain("no_hindi");
    // ZWJ / ZWNJ stay in the text: they decide how a conjunct is drawn
    const zwj = "क्‍ष से जुड़ी हेडलाइन यहां पूरी है";
    expect(parseBreaking(["x_breaking", "जयपुर", zwj, "बिंदु"].join("\n"), "x_breaking.txt", book).headline).toBe(zwj);
    // U+095C (precomposed ड़) is folded like the decomposed form
    expect(parseBreaking("चित्तौड़गढ़\nहेडलाइन यहां है", "x_breaking.txt", book).district).toBe("Chittorgarh");
    const long = Array.from({ length: 40 }, (_, i) => `पंक्ति ${i}`).join("\n");
    expect(parseBreaking(`जयपुर\n${long}`, "x_breaking.txt", book).needsCheck).toContain("very_long");
  });
});

describe("composeBreaking", () => {
  it("writes the house layout: the footer tag alone; a district only the headline names is offered, and picks no police (b6 P0)", () => {
    const { text, d } = post("btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt");
    // No place line, no place prefix: "कोटा में ..." is inferred, so it is offered and goes neither in line 1
    // nor to @KotaPolice. Before b7 this file went out "#Kota: ..." with @KotaPolice.
    expect(text.startsWith("कोटा में हिस्ट्रीशीटर")).toBe(true);
    expect(d.hashtagSuggestions[0]).toBe("#Kota");
    expect(text.endsWith("\n\n#RajasthanWithFirstIndia")).toBe(true);
    expect(d.mentions).toEqual([]);
    // "वारदात" still matches #RajasthanPolice — it is offered to the desk, not put on the post
    expect(d.hashtagSuggestions).toContain("#RajasthanPolice");
    expect(text).not.toContain("#RajasthanPolice");
    expect(text).toContain("तलवारे और डंडे लेकर आए बदमाशों ने किया हमला, दादाबाड़ी");
    expect(d.composeVersion).toBe("b8.0");
  });

  it("adds the Hindi town tag and cuts line 2 right after a linking word, at the desk's length, with 3 or 4 dots (b8)", () => {
    const { text } = post("BTN_RJ_BREAKING_6072_29OCT_US_CONTROL_REPORTER_karari_big.txt");
    expect(text.split("\n")[0]).toBe("#Chittorgarh #निम्बाहेड़ा: काश, पहले भी जारी हो जाती ऐसी एडवाइजरी !");
    const body = text.split("\n\n")[1]!;
    expect(body).toMatch(/[^.]\.{3,4}$/);
    expect(LINKING_WORDS.has(body.replace(/\.+$/, "").split(" ").pop()!)).toBe(true);
    expect(xLen(body)).toBeGreaterThanOrEqual(100);
    expect(xLen(body)).toBeLessThanOrEqual(130);
    expect(xLen(text)).toBeLessThanOrEqual(280);
  });

  it("cuts a headline only past the post's limit: 1,000 by default, or a limit the caller sets", () => {
    const long = parseBreaking(`जयपुर\n${"बहुत लंबी हेडलाइन ".repeat(40)}\nबिंदु`, "x_breaking.txt", book);
    expect(composeBreaking(long, rules, book, { topics }).headlineCut).toBe(false);
    const huge = composeBreaking(parseBreaking(`जयपुर\n${"बहुत लंबी हेडलाइन ".repeat(80)}\nबिंदु`, "x_breaking.txt", book), rules, book, { topics });
    expect(huge.headlineCut).toBe(true);
    expect(xLen(assemblePostText(huge.bodyText, huge.hashtags, huge.mentions))).toBeLessThanOrEqual(BREAKING_POST_MAX);
    const capped = composeBreaking(long, rules, book, { topics, limit: 280 });
    expect(capped.headlineCut).toBe(true);
    expect(xLen(assemblePostText(capped.bodyText, capped.hashtags, capped.mentions))).toBeLessThanOrEqual(280);
  });

  it("uses #FirstIndiaNews outside Rajasthan, only national-safe category tags, and tags nobody there", () => {
    const s = parseBreaking("x\nदिल्ली\nभाजपा मुख्यालय में बैठक\nबिंदु एक", "x_breaking.txt", book);
    const d = composeBreaking(s, rules, book, { topics });
    expect(d.bodyText.startsWith("#Delhi: ")).toBe(true);
    expect([d.hashtags, d.mentions]).toEqual([["#FirstIndiaNews"], []]);
    expect(d.hashtagSuggestions).toEqual(["#BJP"]); // offered, not applied
    const crime = composeBreaking(parseBreaking("x\nदिल्ली\nहत्या का आरोपी गिरफ्तार\nपुलिस ने की कार्रवाई", "x_breaking.txt", book), rules, book, { topics });
    expect([crime.hashtags, crime.mentions]).toEqual([["#FirstIndiaNews"], []]);
    // A national story is never even offered a Rajasthan-only tag
    expect(crime.hashtagSuggestions).toEqual([]);
  });

  it("puts the footer tag on the post and offers the topic tags, headline match first", () => {
    const points = Array.from({ length: 8 }, (_, i) => `सड़क हादसे में ${i} लोग घायल, मानसून की भारी बारिश के बाद ट्रेन रद्द`);
    const s = parseBreaking(`जयपुर\nपुलिस ने हत्या के आरोपी को किया गिरफ्तार\n${points.join("\n")}`, "x_breaking.txt", book);
    const d = composeBreaking(s, rules, book, { topics });
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    expect(d.hashtagSuggestions).toEqual(["#RajasthanPolice", "#RoadAccident"]); // the headline's tag first
    expect(d.mentions).toEqual(["@jaipur_police"]);
    expect(xLen(assemblePostText(d.bodyText, d.hashtags, d.mentions))).toBeLessThanOrEqual(280);
  });

  it("adds no dots when every point fits, and no category tag without topic rules", () => {
    const d = composeBreaking(parseBreaking("जयपुर\nहत्या के आरोपी से पूछताछ\nपुलिस ने आरोपी से की लंबी पूछताछ\nपरिजनों के बयान भी दर्ज", "x_breaking.txt", book), rules, book);
    expect(d.bodyText).toBe("#Jaipur: हत्या के आरोपी से पूछताछ\n\nपुलिस ने आरोपी से की लंबी पूछताछ, परिजनों के बयान भी दर्ज");
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
  });

  it("never tags another district's police: 'बूंदी SP ने' in a Jaipur story", () => {
    const d = composeBreaking(parseBreaking("जयपुर\nDGP ने ली अधिकारियों की बैठक\nबूंदी SP ने की मुलाकात", "x_breaking.txt", book), rules, book, { topics });
    expect(d.mentions).toEqual(["@PoliceRajasthan"]);
    const own = composeBreaking(parseBreaking("जयपुर\nचोरी का खुलासा\nजयपुर पुलिस ने आरोपी को पकड़ा", "x_breaking.txt", book), rules, book, { topics });
    expect(own.mentions).toEqual(["@jaipur_police"]);
  });

  it("never tags another district's police named in two words or with 'जिले के'", () => {
    const jaipur = (point: string) => composeBreaking(parseBreaking(`जयपुर
चोरी का खुलासा
${point}`, "x_breaking.txt", book), rules, book, { topics }).mentions;
    expect(jaipur("सवाई माधोपुर एसपी ने आरोपी को पकड़ा")).toEqual([]);
    expect(jaipur("बूंदी जिले के एसपी ने आरोपी को पकड़ा")).toEqual([]);
    expect(jaipur("बूंदी जिला पुलिस ने आरोपी को पकड़ा")).toEqual([]);
    expect(jaipur("जयपुर जिले के एसपी ने आरोपी को पकड़ा")).toEqual(["@jaipur_police"]);
  });

  it("tags no district police when the story has no district: 'बूंदी SP ने' fails safe", () => {
    const story = { headline: "बूंदी SP ने की मुलाकात", points: ["बूंदी SP ने आरोपी को पकड़ा"], district: null, rajasthan: true, leaderPost: false };
    expect(pickHandles(story, rules).map((h) => h.reason)).not.toContain("police");
  });
});

describe("the catchy cut (b8 crispPoints scoring)", () => {
  const lead = "कुंभलगढ़ घूमने आए मध्यप्रदेश के पर्यटकों की कार हादसे का शिकार";

  it("stops on a describing word with the payoff still to come", () => {
    expect(crispPoints([lead, "ओलादर ब्रिज पर डंपर और कार के बीच हुई जोरदार टक्कर", "भीषण सड़क हादसे में पांच पर्यटक घायल"], "....")).toBe(
      `${lead}, ओलादर ब्रिज पर डंपर और कार के बीच हुई जोरदार टक्कर, भीषण....`,
    );
  });

  it("stops on the person or thing just before its action", () => {
    expect(crispPoints(["सादुलपुर पुलिस को मिली बड़ी सफलता", "आरोपी रमेश उर्फ मोनू गिरफ्तार", "आरोपी अनिल उर्फ मोलड़ के गोली मारकर शव फेंक गए थे सूरतपुरा गांव में"], "....")).toBe(
      "सादुलपुर पुलिस को मिली बड़ी सफलता, आरोपी रमेश उर्फ मोनू गिरफ्तार, आरोपी अनिल उर्फ मोलड़ के गोली मारकर शव फेंक....",
    );
  });

  it("never stops inside a number range ('10 से 15')", () => {
    const out = crispPoints(["जयपुर में तेज बारिश से कई इलाकों में जलभराव की स्थिति", "शहर के निचले इलाकों में पानी भरा", "बारिश के बाद 10 से 15 मकानों में घुसा पानी"], "...");
    expect(out).not.toMatch(/10 से\.+$/u);
    expect(out.endsWith("मकानों में...")).toBe(true);
  });

  it("prefers a linking word over a word that finishes the statement", () => {
    const out = crispPoints(["पुलिस ने अवैध शराब के खिलाफ अभियान चलाकर बड़ी कार्रवाई की", "तस्करों के ठिकानों पर दबिश देकर शराब बरामद", "दो आरोपियों को किया गिरफ्तार और वाहन जब्त"], "...");
    expect(out.endsWith("दो आरोपियों को...")).toBe(true);
  });

  it("counts the dots inside 100–130", () => {
    for (const dots of ["...", "...."]) {
      const out = crispPoints([lead, "ओलादर ब्रिज पर डंपर और कार के बीच हुई जोरदार टक्कर", "भीषण सड़क हादसे में पांच पर्यटक घायल"], dots);
      expect(xLen(out)).toBeGreaterThanOrEqual(BREAKING_BODY_MIN);
      expect(xLen(out)).toBeLessThanOrEqual(BREAKING_BODY_MAX);
    }
  });

  it("cuts one huge word by letters instead of losing line 2", () => {
    const out = crispPoints(["अ".repeat(200)], "...");
    expect(out).toBe(`${"अ".repeat(BREAKING_BODY_MAX - 3)}...`);
  });

  it("drops a line 2 under the 40-character floor, never a stub", () => {
    expect(crispPoints(["पुलिस ने आरोपी को पकड़ा", "जांच जारी"], "....")).toBe("");
    expect(crispPoints([lead, "ओलादर ब्रिज पर डंपर और कार के बीच हुई जोरदार टक्कर"], "...", 35)).toBe("");
    const tight = crispPoints([lead, "ओलादर ब्रिज पर डंपर और कार के बीच हुई जोरदार टक्कर"], "...", 60);
    expect(xLen(tight)).toBeGreaterThanOrEqual(BREAKING_BODY_FLOOR);
    expect(xLen(tight)).toBeLessThanOrEqual(60);
  });

  it("keeps a short story whole, with no dots, when it is over the floor", () => {
    expect(crispPoints(["पुलिस ने हत्या के आरोपी को किया गिरफ्तार", "जांच जारी, परिजनों ने राहत की सांस ली"], "...")).toBe(
      "पुलिस ने हत्या के आरोपी को किया गिरफ्तार, जांच जारी, परिजनों ने राहत की सांस ली",
    );
  });

  it("stays fast on a 200-point story (stops scanning past the limit)", () => {
    const big = Array.from({ length: 200 }, (_, i) => `क्षेत्र में ${i} श्रद्धालुओं के लिए व्यवस्था की गई और प्रशासन ने निर्देश दिए`);
    const t = performance.now();
    const out = crispPoints(big, "....");
    expect(performance.now() - t).toBeLessThan(1000);
    expect(xLen(out)).toBeLessThanOrEqual(BREAKING_BODY_MAX);
  });

  it("measures Devanagari the way X does and never goes over the limit", () => {
    const points = Array.from({ length: 12 }, (_, i) => `क्षेत्र में ${i} श्रद्धालुओं के लिए व्यवस्था की गई और प्रशासन ने निर्देश दिए`);
    for (const max of [60, 90, 130]) {
      const out = crispPoints(points, "...", max);
      expect(xLen(out)).toBeLessThanOrEqual(max);
      expect(out).toMatch(/[^,्.]\.\.\.$/u);
    }
  });

  it("seeds the dots with the headline without its tags", () => {
    expect(plainHeadline("#Jaipur #डग:  बिजली गुल")).toBe("बिजली गुल");
    expect(plainHeadline("#Chittorgarh #आकोला में पैंथर")).toBe("में पैंथर");
    expect(plainHeadline("कोटा में हादसा")).toBe("कोटा में हादसा");
  });
});

describe("the whole breaking post (b8 decisions §1)", () => {
  it("keeps line 2 at 100–130 when a long headline and many handles push the post past 280", () => {
    const head = "जयपुर में राज्य सरकार के मंत्री ने विधानसभा में बजट घोषणाओं की समीक्षा बैठक में अधिकारियों को दिए सख्त निर्देश और समय पर काम पूरा करने को कहा";
    const points = Array.from({ length: 6 }, (_, i) => `बैठक में ${i} विभागों के अधिकारियों ने अपनी योजनाओं की प्रगति रिपोर्ट पेश की और लंबित कामों की जानकारी दी`);
    const d = composeBreaking(parseBreaking(`जयपुर\n${head}\n${points.join("\n")}`, "x_breaking.txt", book), rules, book, { topics });
    const line2 = d.bodyText.split("\n\n")[1]!;
    expect(xLen(line2)).toBeGreaterThanOrEqual(BREAKING_BODY_MIN);
    expect(xLen(line2)).toBeLessThanOrEqual(BREAKING_BODY_MAX);
    expect(xLen(assemblePostText(d.bodyText, d.hashtags, d.mentions))).toBeLessThanOrEqual(BREAKING_POST_MAX);
  });

  it("uses the bodyMax option as line 2's ceiling", () => {
    const points = Array.from({ length: 6 }, (_, i) => `बैठक में ${i} विभागों के अधिकारियों ने अपनी योजनाओं की प्रगति रिपोर्ट पेश की और लंबित कामों की जानकारी दी`);
    const d = composeBreaking(parseBreaking(`जयपुर\nसमीक्षा बैठक\n${points.join("\n")}`, "x_breaking.txt", book), rules, book, { topics, bodyMax: 80 });
    const line2 = d.bodyText.split("\n\n")[1]!;
    expect(xLen(line2)).toBeLessThanOrEqual(80);
    expect(xLen(line2)).toBeGreaterThanOrEqual(BREAKING_BODY_FLOOR);
  });
});

describe("category hashtags", () => {
  const footer = ["#RajasthanWithFirstIndia"];
  const tags = (headline: string, points: string[] = [], rajasthan = true) => pickCategoryTags({ headline, points, rajasthan }, topics, footer);

  it("maps the desk's keywords to one tag each, never twice", () => {
    expect(tags("चाकूबाजी की वारदात", ["हत्या के आरोपी गिरफ्तार"])).toEqual(["#RajasthanPolice"]);
    expect(tags("तेज रफ्तार कार की टक्कर से युवक की मौत")).toEqual(["#RoadAccident"]);
    expect(tags("RPSC ने जारी किया परीक्षा कार्यक्रम")).toEqual(["#RajasthanJobs"]);
    expect(tags("IAS अधिकारियों के तबादले")).toEqual(["#RajasthanIAS"]);
    expect(tags("स्कूल को बम से उड़ाने की धमकी")).toEqual(["#BombThreat"]);
    expect(tags("भजनलाल शर्मा ने किया लोकार्पण")).toEqual(["#BhajanlalSharma"]);
    expect(tags("जयपुर में भारी बारिश")).toEqual(["#HeavyRain"]); // not #Monsoon as well: "भारी बारिश" is one match
    expect(tags("बारिश से किसानों के चेहरे खिले")).toEqual(["#Monsoon"]);
  });

  it("ranks headline matches first, then priority, at most 2", () => {
    expect(tags("ट्रेन से कटकर युवक की मौत", ["भाजपा नेता पहुंचे"])).toEqual(["#Train", "#BJP"]);
    expect(tags("भाजपा और कांग्रेस के बीच हाईकोर्ट में बहस", ["हत्या का मामला"])).toHaveLength(2);
    expect(tags("बैठक", ["रेलवे स्टेशन पर भाजपा नेता"])).toEqual(["#BJP", "#Train"]);
  });

  it("gives national stories only national-safe tags", () => {
    expect(tags("हाईकोर्ट ने गिरफ्तार आरोपी को दी जमानत, भाजपा ने उठाए सवाल", [], false)).toEqual(["#BJP"]);
    expect(tags("IAS अफसरों के तबादले, RPSC परीक्षा", [], false)).toEqual([]);
  });

  it("skips the look-alikes: a patient, a close contest, an averted accident, a threat that is not a bomb, other Gehlots", () => {
    expect(tags("घायल युवक को अस्पताल में भर्ती कराया")).toEqual([]);
    expect(tags("दोनों प्रत्याशियों में कांटे की टक्कर")).toEqual([]);
    expect(tags("बड़ा हादसा टल गया")).toEqual([]);
    expect(tags("युवक को जान से मारने की धमकी")).toEqual([]);
    expect(tags("हाईकोर्ट से मुकेश गहलोत को राहत")).toEqual(["#RajasthanHighCourt"]);
    expect(tags("पायलट प्रोजेक्ट शुरू")).toEqual([]);
  });

  it("matches aliases as whole words only: a compound that contains one is not it", () => {
    expect(tags("युवक ने की आत्महत्या")).toEqual([]); // not हत्या
    expect(tags("सीमा पर बमबारी")).toEqual([]); // not बम
    expect(tags("भर्तीकर्ता कंपनी का दफ्तर")).toEqual([]); // not भर्ती
    expect(tags("आत्महत्या के बाद हत्या का केस")).toEqual(["#RajasthanPolice"]); // the whole word still counts
  });

  it("keeps the recruitment tag for a hospital's recruitment, not for a patient admitted", () => {
    expect(tags("RPSC ने अस्पताल में नर्स भर्ती परीक्षा की तारीख घोषित की")).toEqual(["#RajasthanJobs"]);
    expect(tags("घायल को अस्पताल में भर्ती कराया")).toEqual([]);
    expect(tags("मरीज अस्पताल में भर्ती")).toEqual([]);
  });

  it("matches decomposed Devanagari (NFD nukta) the same, and needs topic rules", () => {
    expect(tags("सड़क हादसे में दो की मौत")).toEqual(["#RoadAccident"]);
    expect(pickCategoryTags({ headline: "हत्या", points: [], rajasthan: true }, null)).toEqual([]);
    expect(pickCategoryTags({ headline: "हत्या", points: [], rajasthan: true }, hashtagGazetteer([]))).toEqual([]);
  });
});

describe("handle rules", () => {
  const story = (headline: string, district = "Jaipur", points: string[] = []) => ({ headline, points, district, rajasthan: true, leaderPost: false });
  const acting = (text: string) => [...actingAgents(text)].sort();

  it("tags the district police on any incident, the collector on administration, the government on its decisions", () => {
    // Crime words alone now DO tag the district police: 248 of 302 police tags in the published corpus
    // were the only handle on the post, and "बेकाबू कार ने मारी टक्कर" names no police at all
    expect(pickHandles(story("जयपुर में चोरी का आरोपी गिरफ्तार"), rules).map((h) => h.handle)).toEqual(["jaipur_police"]);
    expect(pickHandles(story("पुलिस ने चोरी के आरोपी को किया गिरफ्तार"), rules).map((h) => h.handle)).toEqual(["jaipur_police"]);
    expect(pickHandles(story("जिला कलेक्टर ने की जनसुनवाई"), rules).map((h) => h.handle)).toEqual(["DcDmJaipur"]);
    expect(pickHandles(story("राज्य सरकार ने जारी किए आदेश"), rules).map((h) => h.handle)).toEqual(["RajGovOfficial"]);
    expect(pickHandles(story("मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण"), rules).map((h) => h.handle)).toEqual(["BhajanlalBjp"]);
  });

  it("knows when the police or the collector are the ones acting", () => {
    expect(acting("पुलिस ने आरोपी को पकड़ा")).toEqual(["police"]);
    expect(acting("दादाबाड़ी थाना पुलिस कर रही बदमाशों की तलाश")).toEqual(["police"]);
    expect(acting("पुलिस मामले की जांच में जुटी")).toEqual(["police"]);
    expect(acting("शिप्रापथ थाना पुलिस की बड़ी कार्रवाई")).toEqual(["police"]);
    expect(acting("पुलिस को मिली बड़ी सफलता")).toEqual(["police"]);
    expect(acting("थाना प्रभारी रामलाल मीणा ने बताया")).toEqual(["police"]);
    expect(acting("कलेक्टर टीना डाबी ने किया निरीक्षण")).toEqual(["collector"]);
    expect(acting("जिला प्रशासन ने जारी किए आदेश")).toEqual(["collector"]);
    expect(acting("कलेक्टर की अध्यक्षता में बैठक")).toEqual(["collector"]);
    expect(acting("पुलिस व प्रशासन ने हटाया अतिक्रमण")).toEqual(["police"]);
    expect(acting("पुलिस और कलेक्टर ने किया दौरा")).toEqual(["collector", "police"]);
  });

  it("does not count the police as acting when they are the object, the place, a former officer or another force", () => {
    expect(acting("बदमाशों ने पुलिस पर किया हमला")).toEqual([]);
    expect(acting("पुलिस थाने में हंगामा कर रहे ग्रामीण")).toEqual([]);
    expect(acting("पुलिस की लापरवाही से गई जान")).toEqual([]);
    expect(acting("सेवानिवृत्त ASP विपिन शर्मा ने भी दी जानकारी")).toEqual([]);
    expect(acting("ACB सीआई सुरजीत सिंह ने दिया कार्रवाई को अंजाम")).toEqual([]);
    expect(acting("पुलिसकर्मी के घर चोरी")).toEqual([]);
    expect(acting("SP को सौंपा ज्ञापन")).toEqual([]);
  });

  it("tags the leader on campaign copy and nobody in a leader's own post, never the police beside a party", () => {
    // Campaign copy is political: it tags the leader (and the party, where party rules are loaded) — the
    // old blanket "party news tags nobody" guard dropped 99 party tags across the published corpus
    expect(pickHandles(story("मुख्यमंत्री भजनलाल शर्मा ने भाजपा प्रत्याशी के लिए किया जनसंपर्क"), rules).map((h) => h.handle)).toEqual(["BhajanlalBjp"]);
    // What the old guard was protecting is still enforced: no police handle on political copy
    expect(pickHandles(story("भाजपा प्रत्याशी के समर्थन में जनसंपर्क, पुलिस ने संभाला मोर्चा"), rules).map((h) => h.reason)).not.toContain("police");
    expect(pickHandles({ ...story("पुलिस ने किया गिरफ्तार"), leaderPost: true }, rules)).toEqual([]);
    // An incident tags the district's own verified handle, named as acting or not
    expect(rules.districts.tonk?.police.length).toBeGreaterThan(0);
    expect(pickHandles(story("चोरी का आरोपी गिरफ्तार", "Tonk"), rules).map((h) => h.reason)).toEqual(["police"]);
    expect(pickHandles(story("टोंक पुलिस ने चोरी का आरोपी किया गिरफ्तार", "Tonk"), rules).map((h) => h.reason)).toEqual(["police"]);
  });

  it("skips unverified handles and refuses a malformed file", () => {
    const r = parseHandleRules({
      version: 1,
      state: [{ handle: "@RajGovOfficial", role: "govt", verified: false }],
      districts: { "Sawai Madhopur": [{ handle: "@SwmPolice", role: "police", verified: true }, { handle: "@SwmDm", role: "collector", verified: false }] },
    });
    expect(r.state.government).toEqual([]);
    expect(pickHandles(story("हत्या का आरोपी पुलिस ने किया गिरफ्तार", "Sawai Madhopur"), r).map((h) => h.handle)).toEqual(["SwmPolice"]);
    expect(pickHandles(story("कलेक्टर ने किया दौरा", "Sawai Madhopur"), r)).toEqual([]);
    expect(() => parseHandleRules({ state: [{ handle: "not a handle!", role: "govt", verified: true }] })).toThrow(/not an X handle/);
    expect(() => parseHandleRules({ state: [{ handle: "@x", role: "mayor", verified: true }] })).toThrow(/role/);
    expect(() => parsePlacesData({ nope: true })).toThrow(/districts/);
    expect(pickHandles(story("पुलिस ने चोरी पकड़ी"), EMPTY_HANDLE_RULES)).toEqual([]);
  });
});

describe("subject handles", () => {
  const problems: string[] = [];
  const subjects = parseSubjectHandles(
    {
      version: 1,
      entries: [
        { handle: "@NWRailways", kind: "department", title: "North Western Railway", names_hi: ["उत्तर पश्चिम रेलवे"], keywords_hi: ["रेलवे"], verified: true },
        { handle: "@INCRajasthan", kind: "party", names_hi: ["राजस्थान कांग्रेस"], verified: true },
        { handle: "@SomeoneX", kind: "person", names_hi: ["फलां सिंह"], verified: false },
        { handle: "not a handle!", kind: "person", names_hi: ["कोई"], verified: true },
        { handle: "@NoKind", kind: "mayor", names_hi: ["महापौर"], verified: true },
        { handle: "@NoNames", kind: "company", verified: true },
        { handle: "ashokgehlot51", kind: "person", names_hi: ["अशोक गहलोत"], names_en: ["Ashok Gehlot"], verified: true, source: "x", checkedAt: "2026-10-31" },
      ],
    },
    (m) => problems.push(m),
  );
  const story = (headline: string, points: string[] = [], rajasthan = true) => ({ headline, points, district: "Jaipur", rajasthan, leaderPost: false });
  const handles = (headline: string, points: string[] = [], rajasthan = true) => pickHandles(story(headline, points, rajasthan), rules, { subjects }).map((h) => h.handle);

  it("keeps only verified, non-party entries and reports malformed ones instead of failing", () => {
    expect(subjects.count).toBe(2);
    expect(problems).toHaveLength(3);
    expect(() => parseSubjectHandles({ version: 1 })).toThrow(/entries/);
    const shipped: string[] = [];
    expect(parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"), (m) => shipped.push(m)).count).toBeGreaterThan(0); // the shipped file
    expect(shipped).toEqual([]);
    expect(handles("राजस्थान कांग्रेस के नेता बोले")).toEqual([]); // party news: nobody, and never a party handle
  });

  it("tags the subject, headline first, at most 2, matching Hindi and English names", () => {
    expect(handles("रेलवे ने रद्द की ट्रेन, स्टेशन पर पुलिस ने पकड़ा चोर")).toEqual(["NWRailways", "jaipur_police"]);
    expect(handles("रेलवे स्टेशन पर पुलिस ने पकड़ा चोर")).toEqual(["jaipur_police"]); // a department only when it acts
    expect(handles("पुलिस ने पकड़ा चोर", ["उत्तर पश्चिम रेलवे ने जारी की सूचना"])).toEqual(["jaipur_police", "NWRailways"]);
    expect(handles("ASHOK GEHLOT met railway officials")).toEqual(["ashokgehlot51"]);
    expect(handles("मुख्यमंत्री भजनलाल शर्मा और अशोक गहलोत रेलवे स्टेशन पहुंचे")).toEqual(["BhajanlalBjp", "ashokgehlot51"]);
    expect(handles("रेलवे स्टेशन पर भीड़", [], false)).toEqual([]); // national: nobody
    const pick = pickHandles(story("उत्तर पश्चिम रेलवे ने चलाई नई ट्रेन"), rules, { subjects })[0];
    expect(pick).toEqual({ handle: "NWRailways", reason: "subject", title: "North Western Railway" });
  });

  it("with the shipped file, tags no state institution that is not acting, and no person on a common or partial name", () => {
    const shipped = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
    const real = (headline: string, points: string[] = []) => pickHandles(story(headline, points), rules, { subjects: shipped }).map((h) => h.handle);
    // An incident in the district tags the district's police, whoever the copy makes the actor — the
    // force is still the one in the story when it is the target or the victim
    expect(real("जयपुर पुलिस पर पथराव")).toEqual(["jaipur_police"]);
    expect(real("राजस्थान पुलिस के जवान की हादसे में मौत")).toEqual(["jaipur_police"]);
    expect(real("ट्रेन से कटकर युवक की मौत", ["रेलवे ट्रैक पर मिला शव"])).toEqual(["jaipur_police"]);
    expect(real("खींवसर में सड़क हादसा")).toEqual(["jaipur_police"]); // a town, not the minister
    expect(real("संजय शर्मा नाम के आरोपी को पकड़ा")).toEqual(["jaipur_police"]); // a common name: no subject
    // State institutions are still tagged only when the copy names them acting
    expect(real("DGP से मिले अधिकारी")).toEqual([]);
    expect(real("डीजीपी राजीव शर्मा ने ली बैठक")).toEqual(["PoliceRajasthan"]);
    expect(real("राज्य सरकार के खिलाफ धरना")).toEqual([]);
    expect(real("राज्य सरकार का बड़ा फैसला")).toEqual(["RajGovOfficial"]); // deciding: still the government
    expect(real("शिवराज और हेमंत मीणा पहुंचे")).toEqual([]);
    // Still tagged: a named person, a department acting, the police acting
    expect(real("गजेंद्र सिंह खींवसर ने किया अस्पताल का दौरा")).toEqual(["GajendraKhimsar"]);
    // An exam result is not an election bulletin: bare "परिणाम" only means one in an election's company
    expect(real("आरपीएससी ने जारी किया परिणाम")).toEqual(["RPSC1"]);
    expect(real("जयपुर पुलिस ने पकड़ा चोर")).toEqual(["jaipur_police"]);
  });
});

describe("places data", () => {
  it("skips bad entries and says why, instead of dropping the whole file", () => {
    const problems: string[] = [];
    const data = parsePlacesData(
      {
        version: 1,
        districts: [
          { tag: "Jodhpur", hi: ["जोधपुर"], codes: ["JDR"], towns: [{ hi: "पीपाड़", tag: "पीपाड़" }, { hi: "Pipar" }, { hi: "बिलाड़ा", tag: 5 }] },
          { tag: "Jodhpur", hi: ["जोधपुर"], codes: [], towns: [] },
          { tag: "Kota #", hi: ["कोटा"], codes: [], towns: [] },
          { tag: "Kota", hi: [], codes: [], towns: [] },
          { tag: "Ajmer", hi: ["अजमेर"], codes: ["JDR", "AJM"], towns: [] },
        ],
      },
      (m) => problems.push(m),
    );
    expect(data.districts.map((d) => [d.tag, d.codes, d.towns.length])).toEqual([["Jodhpur", ["JDR"], 1], ["Ajmer", ["AJM"], 0]]);
    expect(problems).toHaveLength(6);
    expect(problems.join(" | ")).toMatch(/twice.*English hashtag.*no Hindi name/s);
  });
});

describe("PHASE", () => {
  it("is 2 unless set to 1, and refuses anything else", () => {
    expect(phaseFrom(undefined)).toBe(2);
    expect(phaseFrom(" 1 ")).toBe(1);
    expect(() => phaseFrom("one")).toThrow(/PHASE/);
    expect(phaseFeatures(1)).toMatchObject({ xApiPosting: false, cardOnDemand: true, samvadia: false, webScraper: true, copyPosted: true });
    expect(phaseFeatures(2)).toMatchObject({ xApiPosting: true, cardOnDemand: false });
  });
});

describe("crispPoints (b8 line 2)", () => {
  const points = [
    "मंडी की एडवाइजरी में भी सियासी सवाल",
    "किसान पहले जाएं या मौसम देखें",
    "फसल खाली जमीन पर नहीं रखने का फरमान",
    "किसानों की मजबूरी पर किसी का ध्यान नहीं",
  ];

  it("shows points that fit whole, with no dots", () => {
    expect(crispPoints(["पुलिस ने हत्या के आरोपी को किया गिरफ्तार", "जांच जारी, परिजनों ने राहत की सांस ली"], "....")).toBe(
      "पुलिस ने हत्या के आरोपी को किया गिरफ्तार, जांच जारी, परिजनों ने राहत की सांस ली",
    );
  });

  it("cuts long points to the desk's 100–130 and ends with the given dots", () => {
    for (const dots of ["...", "...."]) {
      const body = crispPoints(points, dots);
      expect(body.endsWith(dots)).toBe(true);
      expect(body.slice(0, -dots.length).endsWith(".")).toBe(false);
      expect(xLen(body)).toBeGreaterThanOrEqual(BREAKING_BODY_MIN);
      expect(xLen(body)).toBeLessThanOrEqual(BREAKING_BODY_MAX);
    }
  });

  it("withholds the payoff: stops on a linking word before the noun, not after a finished verb", () => {
    const body = crispPoints(points, "...");
    const last = body.replace(/\.+$/, "").split(" ").pop()!;
    expect(LINKING_WORDS.has(last)).toBe(true);
  });

  it("goes shorter only when it is given less room, and never past it", () => {
    for (const max of [40, 70, 90]) expect(xLen(crispPoints(points, "....", max))).toBeLessThanOrEqual(max);
    expect(crispPoints(points, "...", 0)).toBe("");
    expect(crispPoints([], "...")).toBe("");
  });
});

describe("breakingDots", () => {
  it("is the same for the same headline, and mixes 3 and 4 dots across headlines", () => {
    expect(breakingDots("जयपुर में हादसा")).toBe(breakingDots("जयपुर में हादसा"));
    const seen = new Set(Array.from({ length: 50 }, (_, i) => breakingDots(`खबर ${i}`)));
    expect([...seen].sort()).toEqual(["...", "...."]);
  });

  it("reads composed and decomposed Hindi alike (NFC)", () => {
    const h = "बड़ी ख़बर";
    expect(breakingDots(h.normalize("NFD"))).toBe(breakingDots(h.normalize("NFC")));
  });
});

describe("the shared crispPoints cases (b8 decisions #11)", () => {
  // 200 real cases from the desk's posts; the frontend's Fit test reads the same file and must match every one
  const { cases } = json("./fixtures/crisp-cases.json") as { cases: { points: string[]; dots: string; max: number; expected: string }[] };

  it("matches every case", () => {
    expect(cases.length).toBe(200);
    for (const c of cases) expect(crispPoints(c.points, c.dots, c.max)).toBe(c.expected);
  });
});
