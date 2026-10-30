// Phase 1: breaking file names, folders, the parser, the composer and the handle rules, on small fixtures
// made from real files (reporter names replaced by placeholders).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, assemblePostText, composeBreaking, daysToScan, dayFolderName, fileTags, isBreakingFileName, matchDayFolder, matchMonthFolder,
  parseBreaking, parseHandleRules, parsePlacesData, phaseFeatures, phaseFrom, pickHandles, xLen, EMPTY_HANDLE_RULES,
} from "../src";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/breaking/${name}`, import.meta.url), "utf8");
const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const parse = (name: string) => parseBreaking(fixture(name), name, book);
const post = (name: string) => {
  const s = parse(name);
  const d = composeBreaking(s, rules, book);
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
  it("writes the house layout with the district police on crime news", () => {
    const { text } = post("btn_rj_breaking_29Oct_vks_1566_control_Reporter_big_breaking_full.txt");
    expect(text.startsWith("#Kota: कोटा में हिस्ट्रीशीटर")).toBe(true);
    expect(text.endsWith("\n\n#RajasthanWithFirstIndia @KotaPolice")).toBe(true);
    expect(text).toContain("तलवारे और डंडे लेकर आए बदमाशों ने किया हमला, दादाबाड़ी");
  });

  it("adds the Hindi town tag and cuts the points on a word with ...", () => {
    const { text } = post("BTN_RJ_BREAKING_6072_29OCT_US_CONTROL_REPORTER_karari_big.txt");
    expect(text.split("\n")[0]).toBe("#Chittorgarh #निम्बाहेड़ा: काश, पहले भी जारी हो जाती ऐसी एडवाइजरी !");
    expect(text.split("\n\n")[1]!.endsWith("...")).toBe(true);
    expect(xLen(text)).toBeLessThanOrEqual(280);
  });

  it("stays within 280 even for a huge headline", () => {
    const s = parseBreaking(`जयपुर\n${"बहुत लंबी हेडलाइन ".repeat(40)}\nबिंदु`, "x_breaking.txt", book);
    const d = composeBreaking(s, rules, book);
    expect(d.headlineCut).toBe(true);
    expect(xLen(assemblePostText(d.bodyText, d.hashtags, d.mentions))).toBeLessThanOrEqual(280);
  });

  it("uses #FirstIndiaNews outside Rajasthan and tags nobody there", () => {
    const s = parseBreaking("x\nदिल्ली\nभाजपा मुख्यालय में बैठक\nबिंदु एक", "x_breaking.txt", book);
    const d = composeBreaking(s, rules, book);
    expect(d.bodyText.startsWith("#Delhi: ")).toBe(true);
    expect([d.hashtags, d.mentions]).toEqual([["#FirstIndiaNews"], []]);
  });
});

describe("handle rules", () => {
  const story = (headline: string, district = "Jaipur") => ({ headline, points: [], district, rajasthan: true, leaderPost: false });

  it("tags police on crime, the collector on administration, the government on its decisions", () => {
    expect(pickHandles(story("जयपुर में चोरी का आरोपी गिरफ्तार"), rules).map((h) => h.handle)).toEqual(["jaipur_police"]);
    expect(pickHandles(story("जिला कलेक्टर ने की जनसुनवाई"), rules).map((h) => h.handle)).toEqual(["DcDmJaipur"]);
    expect(pickHandles(story("राज्य सरकार ने जारी किए आदेश"), rules).map((h) => h.handle)).toEqual(["RajGovOfficial"]);
    expect(pickHandles(story("मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण"), rules).map((h) => h.handle)).toEqual(["BhajanlalBjp"]);
  });

  it("never tags anyone on party or election news, or in a leader's post", () => {
    expect(pickHandles(story("मुख्यमंत्री भजनलाल शर्मा ने भाजपा प्रत्याशी के लिए किया जनसंपर्क"), rules)).toEqual([]);
    expect(pickHandles({ ...story("पुलिस ने किया गिरफ्तार"), leaderPost: true }, rules)).toEqual([]);
    expect(pickHandles(story("चोरी का आरोपी गिरफ्तार", "Tonk"), rules)).toEqual([]); // no verified Tonk police handle
  });

  it("skips unverified handles and refuses a malformed file", () => {
    const r = parseHandleRules({
      version: 1,
      state: [{ handle: "@RajGovOfficial", role: "govt", verified: false }],
      districts: { "Sawai Madhopur": [{ handle: "@SwmPolice", role: "police", verified: true }, { handle: "@SwmDm", role: "collector", verified: false }] },
    });
    expect(r.state.government).toEqual([]);
    expect(pickHandles(story("हत्या का आरोपी गिरफ्तार", "Sawai Madhopur"), r).map((h) => h.handle)).toEqual(["SwmPolice"]);
    expect(pickHandles(story("कलेक्टर ने किया दौरा", "Sawai Madhopur"), r)).toEqual([]);
    expect(() => parseHandleRules({ state: [{ handle: "not a handle!", role: "govt", verified: true }] })).toThrow(/not an X handle/);
    expect(() => parseHandleRules({ state: [{ handle: "@x", role: "mayor", verified: true }] })).toThrow(/role/);
    expect(() => parsePlacesData({ nope: true })).toThrow(/districts/);
    expect(pickHandles(story("चोरी"), EMPTY_HANDLE_RULES)).toEqual([]);
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
