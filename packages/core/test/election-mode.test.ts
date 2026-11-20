// Election mode (owner, 20 Nov 2026, panchayat counting day). The desk typed by hand on every result post:
//   #RajasthanWithFirstIndia #RajasthanPanchayatElection2026 #Bikaner @BikanerDm @INCRajasthan @bjprajasthan
// An `election` campaign in campaigns.json now puts its tag on the post by itself, and the handle picker tags the
// collector, every party the copy names (both when both are named), their hashtags and every reporter the file
// name carries. Fixtures are the 20 Nov breaking files.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_RAJASTHAN, DataFileRejected, PlaceBook, composeBreaking, electionOf, namedParties, parseBreaking, parseHandleRules, parsePartyHandles,
  parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules, pickReporters, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const COUNTING_DAY = new Date("2026-11-20T09:30:00Z");
const AFTER = new Date("2026-12-05T09:30:00Z");

const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
function draft(name: string, lines: string[], at = COUNTING_DAY): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, suggestRules, at },
  );
}
const handles = (d: BreakingDraft) => d.handles.map((h) => h.handle.toLowerCase());

// BTN_RJ_BREAKING_20NOV_2714_AM_CONTROL_LAXMAN_BKN_BIG_ (posted by hand at 15:32 with both parties and the collector)
const BIKANER = [
  "बीकानेर से लक्ष्मण राघव की रिपोर्ट",
  "राजस्थान पंचायत चुनाव-2026",
  "जिला परिषद और पंचायत समिति, दोनों में कांग्रेस की बम्पर जीत",
  "37 जिला परिषदों की तस्वीर, कांग्रेस 24 और भाजपा 8 में आगे या जीती",
];

describe("an election story on counting day", () => {
  it("Laxman's Bikaner result: election tag, both parties and their hashtags, the collector", () => {
    const d = draft("BTN_RJ_BREAKING_20NOV_2714_AM_CONTROL_LAXMAN_BKN_BIG_.txt", BIKANER);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`, "#RajasthanPanchayatElection2026", "#Congress", "#BJP"]);
    expect(handles(d)).toEqual(["bikanerdm", "incrajasthan", "bjp4rajasthan"]);
    expect(d.why).toMatch(/election story/);
    // On the post, so never offered again
    expect(d.hashtagSuggestions).not.toContain("#RajasthanPanchayatElection2026");
  });

  it("one party named: only that party and its hashtag", () => {
    const d = draft("BTN_RJ_BREAKING_20NOV_2708_AM_CONTROL_SURYAVEER_JSL_BIG_.txt", [
      "जैसलमेर: जिला परिषद वार्ड संख्या 3 से कांग्रेस जिलाध्यक्ष अमरदीन फकीर ने दर्ज की जीत",
      "जीत की खबर मिलते ही समर्थकों में खुशी की लहर",
    ]);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`, "#RajasthanPanchayatElection2026", "#Congress"]);
    expect(handles(d)).toContain("incrajasthan");
    expect(handles(d)).not.toContain("bjp4rajasthan");
  });

  it("a result line in the desk's shorthand ('पंचायत समिति के वार्ड 1 से बीजेपी जीती') is an election story", () => {
    const d = draft("btn_rj_breaking_8901_20nov_yn_control_laxmikant_big.txt", ["चौमूं पंचायत समिति के वार्ड नंबर 1 से बीजेपी जीती"]);
    expect(d.hashtags).toContain("#RajasthanPanchayatElection2026");
    expect(handles(d)).toContain("bjp4rajasthan");
    expect(d.hashtags).toContain("#BJP");
  });

  it("a DM on every election story: the district the headline names is enough, for the DM only (owner, 20 Nov 2026)", () => {
    // btn_rj_breaking_9980_20nov_yn_control_Laxman_big: no file code, no place line; "बीकानेर" only in the headline
    const d = draft("btn_rj_breaking_9980_20nov_yn_control_Laxman_big.txt", ["बीकानेर जिला परिषद वार्ड 24 से कांग्रेस के शिवलाल गोदारा की जीत"]);
    expect(handles(d)[0]).toBe("bikanerdm");
    expect(handles(d)).toContain("incrajasthan");
    expect(handles(d)).not.toContain("bikaner_police");
  });
  it("an ordinary panchayat samiti meeting is not an election story", () => {
    const d = draft("BTN_RJ_BREAKING_6001_20NOV_US_CONTROL_RITURAJ_BIG.txt", ["आकोला: पंचायत समिति की बैठक", "विकास कार्यों पर चर्चा"]);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
  });

  it("after the window the same result story is back to the old rules: nothing added on its own", () => {
    const d = draft("BTN_RJ_BREAKING_20NOV_2714_AM_CONTROL_LAXMAN_BKN_BIG_.txt", BIKANER, AFTER);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(handles(d)).not.toContain("incrajasthan");
  });
});

describe("electionOf and the campaigns file", () => {
  it("names the election only inside the window", () => {
    expect(electionOf("कांग्रेस 24 पर आगे", suggestRules, COUNTING_DAY)).toBe("RajasthanPanchayatElection2026");
    expect(electionOf("कांग्रेस 24 पर आगे", suggestRules, AFTER)).toBeNull();
    expect(electionOf("सड़क हादसे में दो की मौत", suggestRules, COUNTING_DAY)).toBeNull();
  });
  it("an evergreen keyword cannot be an election (it would never stop)", () => {
    expect(() => parseSuggestRules({ entries: [{ tag: "Chunav", kind: "keyword", election: true, pattern: "चुनाव" }] })).toThrow(DataFileRejected);
  });
});

describe("namedParties", () => {
  it("both parties, in the order the copy names them, state handles on Rajasthan copy", () => {
    expect(namedParties("भाजपा 8, कांग्रेस 24", parties, true).map((p) => p.handle)).toEqual(["BJP4Rajasthan", "INCRajasthan"]);
    expect(namedParties("कांग्रेस 24, भाजपा 8", parties, true).map((p) => p.hashtag)).toEqual(["Congress", "BJP"]);
    expect(namedParties("Congress leads", parties, false).map((p) => p.handle)).toEqual(["INCIndia"]);
  });
  it("a wing is never one of them", () => {
    expect(namedParties("एनएसयूआई का प्रदर्शन", parties, true)).toEqual([]);
  });
});

describe("several reporters on one file name", () => {
  const h = (t: string) => pickReporters(t, reporters).matches.map((m) => m.handle.toLowerCase());
  it("each name the roster knows is a reporter; a show name between them is skipped", () => {
    expect(h("NARESH RITURAJ")).toEqual(["naresh_jsharma", "rituraj9999"]);
    expect(h("DINESH DANGI KARARI")).toEqual(["dineshdangi84"]);
    expect(h("YOGESH KARARI")).toEqual(["yogesh2727sh1"]);
  });
  it("this week's real file names and misspellings (owner's Jaipur list, 20 Nov 2026)", () => {
    expect(h("VIKAS AISHWARAY")).toEqual(["ml_vikas", "aishwaryam99"]);
    expect(h("RITURAJ CS")).toEqual(["rituraj9999"]);
    expect(h("SHIVENDRA RITURAJ")).toEqual(["parmarshivendra", "rituraj9999"]);
    expect(h("DINESHKASANA")).toEqual(["dineshkasana15"]);
    expect(h("DINESH KASANA VIKASH")).toEqual(["dineshkasana15", "ml_vikas"]);
    expect(h("RITUAJ")).toEqual(["rituraj9999"]);
    expect(h("AISWARYA")).toEqual(["aishwaryam99"]);
    expect(h("VIKAS SATYA")).toEqual(["ml_vikas", "satyatv99_news"]);
  });
  it("OM is Om Sharma, but OM PRAKASH is nobody (owner, 20 Nov 2026: not_reporters)", () => {
    expect(h("OM")).toEqual(["omsharma8888"]);
    expect(h("OM KAMALKANT")).toEqual(["omsharma8888", "vyaskamalkant"]);
    expect(h("OM PRAKASH")).toEqual([]);
    expect(h("OM PRAKASH RITURAJ")).toEqual(["rituraj9999"]);
  });
  it("the whole name still decides first, and an unknown or ambiguous name tags nobody", () => {
    expect(h("RITURAJ")).toEqual(["rituraj9999"]);
    expect(pickReporters("LAXMAN", reporters)).toMatchObject({ matches: [], unmatchedToken: "LAXMAN" });
    expect(pickReporters("DINESH", reporters)).toMatchObject({ matches: [], collision: "DINESH" });
  });
  it("on an election story both reporters go last, after the collector and the party", () => {
    const d = draft("BTN_RJ_BREAKING_2236_20NOV_mh_CONTROL_NARESH_RITURAJ_JPR_big.txt", ["जयपुर: जिला परिषद चुनाव परिणामों में कांग्रेस को बहुमत"]);
    expect(handles(d).slice(-2)).toEqual(["naresh_jsharma", "rituraj9999"]);
    expect(handles(d)).toContain("incrajasthan");
    expect(d.handles.length).toBeLessThanOrEqual(4);
  });
});
