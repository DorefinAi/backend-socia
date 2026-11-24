// The learning fix (25 Nov 2026), rule by rule, on the cases the audit found: @jpr_rural learned Air India and
// Hyderabad, @JaipurDiscom1 Mumbai and IndiGo, @NitinNabin Delhi and Punjab, @forest (a stub of @ForestRajasthan)
// Tonk; @hbh and @nwr were offered on almost every story and never taken; #RajasthanPanchayatElection2026 learned
// the stories' places; the desk typed #Balotrapolice for @BalotraPolice. Rule 1 (only what the desk typed) is
// packages/db typedHandles; the cleanup is packages/db learn-cleanup.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DESK_LEARNED_AUTO_USES, DESK_LEARNED_POSTED_USES, PlaceBook, PostedLearner, SUGGEST_RETIRE_OFFERS, deskAutoKey, deskHandleRules, deskKeywordAuto, deskKeywordOffered,
  districtKeywordCandidates, handleDistricts, handleLookalikeOf, handleStoryNames, mergeKeywords, parseHandleRules, parsePlacesData, parseSubjectHandles,
  pickHandlesExplained, placeDistricts, placeOutsideHandle, strictHandlePrefix, suggestionRetired, tagLooksLikeHandle, tagRuleKeywords, withKeywordUses,
  type DeskHandleRow, type LearnStory,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const subjects = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const ctx = { book, subjects };
const files = [...(rules.all ?? []), ...(subjects.handles ?? [])];
const learner = new PostedLearner({ book, subjects, fileHandles: files });
const candidates = [...districtKeywordCandidates(), ...(subjects.keywordCandidates ?? [])];
const story = (headline: string, body = "", district: string | null = null, town: string | null = null): LearnStory => ({ headline, body, district, town });
const pick = (headline: string, district: string | null, rows: DeskHandleRow[]) =>
  pickHandlesExplained({ headline, points: [], district, rajasthan: true, leaderPost: false }, rules, { subjects, desk: deskHandleRules(rows) });

describe("rule 2: a learned place never makes a handle tagged on its own", () => {
  const jaipurStories = [1, 2, 3, 4, 5].map((i) => story(`जयपुर में बैठक ${i}`, "", "Jaipur"));
  it("@jpr_rural with a learned Jaipur, on five desk-typed Jaipur stories: offered, never added", () => {
    const r = withKeywordUses({ handle: "jpr_rural", entityName: "jpr_rural", aliases: ["Jaipur", "जयपुर", "जोबनेर"] }, jaipurStories, candidates);
    expect(r.aliases.map((k) => deskKeywordAuto(r, k))).toEqual([false, false, false]);
    expect(r.aliases.map((k) => deskKeywordOffered(r, k))).toEqual([true, true, false]);
    const p = pick("जयपुर में बैठक", "Jaipur", [r]);
    expect(p.handles.map((h) => h.handle)).not.toContain("jpr_rural");
    expect(p.suggestions.map((h) => h.handle)).toContain("jpr_rural");
  });
  it("a place that is part of the handle string is added from the start (@BaranNews ↔ Baran)", () => {
    const r = withKeywordUses({ handle: "BaranNews", entityName: "BaranNews", aliases: ["Baran", "बारां", "Kota"] }, [], candidates);
    expect(r.aliases.map((k) => deskKeywordAuto(r, k))).toEqual([true, true, false]);
  });
  it("a subject's handle never counts the district in its name as its own (@JaipurDiscom1 is not Jaipur)", () => {
    const r = withKeywordUses({ handle: "JaipurDiscom1", entityName: "Jaipur Discom", aliases: ["Jaipur Discom", "Jaipur", "जयपुर"] }, jaipurStories, candidates);
    expect(r.aliases.map((k) => deskKeywordAuto(r, k))).toEqual([true, false, false]);
  });
  it(`a learned subject (not a place) is added from ${DESK_LEARNED_AUTO_USES} desk-typed stories`, () => {
    const subject = (subjects.keywordCandidates ?? []).find((c) => c.latin === "JVVNL")!;
    expect(subject).toBeDefined();
    const row: DeskHandleRow = { handle: "PowerDeskRaj", entityName: "PowerDeskRaj", aliases: ["JVVNL"] };
    const at = (n: number) => withKeywordUses(row, Array.from({ length: n }, (_, i) => story(`JVVNL ने बिजली काटी ${i}`)), candidates);
    expect([1, 2, 3].map((n) => [deskKeywordOffered(at(n), "JVVNL"), deskKeywordAuto(at(n), "JVVNL")])).toEqual([[false, false], [true, false], [true, true]]);
  });
});

describe("rule 3: places only from the story's own district and town, only the handle's own", () => {
  it("knows a handle's district from its name or its file code; a person's or a stub's has none", () => {
    expect(handleDistricts("@jpr_rural", book)).toEqual(["Jaipur"]);
    expect(handleDistricts("@JprRuralPolice", book)).toEqual(["Jaipur"]);
    expect(handleDistricts("@BaranPolice", book)).toEqual(["Baran"]);
    for (const h of ["@NitinNabin", "@forest", "@hbh", "@nwr", "@satyatv99", "@laxmanraghav"]) expect(handleDistricts(h, book)).toEqual([]);
  });
  it("@jpr_rural learns its Jaipur town, never Air India, Hyderabad or IndiGo from the body", () => {
    const s = story("जोबनेर में हादसा", "एयर इंडिया की उड़ान हैदराबाद से आई, IndiGo की भी", "Jaipur", "जोबनेर");
    expect(handleStoryNames("@jpr_rural", s, ctx)).toEqual(["Jaipur", "जयपुर", "जोबनेर"]);
  });
  it("@jpr_rural typed on a Jhalawar or Hanumangarh story learns nothing", () => {
    expect(handleStoryNames("@jpr_rural", story("झालावाड़ में हादसा", "", "Jhalawar", "झालावाड़"), ctx)).toEqual([]);
    expect(handleStoryNames("@jpr_rural", story("हनुमानगढ़ में बारिश", "", "Hanumangarh"), ctx)).toEqual([]);
  });
  it("@NitinNabin (a person) never learns Delhi, Telangana, Punjab or Jaipur", () => {
    for (const [d, t] of [["Delhi", "दिल्ली"], ["Jaipur", "जयपुर"], [null, null]] as const) {
      expect(handleStoryNames("@NitinNabin", story("दिल्ली, तेलंगाना और पंजाब में बैठक", "जयपुर से अमित शाह", d, t), ctx)).toEqual([]);
    }
  });
  it("@JaipurDiscom1 learns only its own subject's names, never Mumbai, IndiGo, Jodhpur or Tonk", () => {
    const names = handleStoryNames("@JaipurDiscom1", story("मालपुरा में JVVNL की कटौती", "मुंबई की IndiGo उड़ान, जोधपुर", "Tonk", "मालपुरा"), ctx);
    expect(names).toContain("JVVNL");
    for (const n of names) expect(placeDistricts(n, book)).toBeNull();
  });
  it("places outside a handle's own district are told apart from its own", () => {
    expect(placeOutsideHandle("@jpr_rural", "जोबनेर", ctx)).toBe(false);
    expect(placeOutsideHandle("@jpr_rural", "Hyderabad", ctx)).toBe(true);
    expect(placeOutsideHandle("@jpr_rural", "Jhalawar", ctx)).toBe(true);
    expect(placeOutsideHandle("@forest", "Tonk", ctx)).toBe(true);
    expect(placeOutsideHandle("@jpr_rural", "IndiGo", ctx)).toBe(false);
  });
});

describe("rule 4: a learned keyword needs two desk-typed stories before it is even offered", () => {
  it(`counts only the stories it is given (the desk-typed ones), ${DESK_LEARNED_POSTED_USES} needed`, () => {
    const row: DeskHandleRow = { handle: "jpr_rural", entityName: "jpr_rural", aliases: ["चौमूं"] };
    const one = withKeywordUses(row, [story("चौमूं में मेला", "", "Jaipur", "चौमूं")], candidates);
    const two = withKeywordUses(row, [story("चौमूं में मेला", "", "Jaipur", "चौमूं"), story("चौमूं में जाम")], candidates);
    expect(pick("चौमूं में बारिश", "Jaipur", [one]).suggestions.map((h) => h.handle)).not.toContain("jpr_rural");
    expect(pick("चौमूं में बारिश", "Jaipur", [two]).suggestions.map((h) => h.handle)).toContain("jpr_rural");
    expect(deskAutoKey([one])).not.toBe(deskAutoKey([two]));
  });
});

describe("rule 5: a typo or stub of a known handle is not learned; the known one is named instead", () => {
  const directory = ["forestRajasthan", "NWRailways", "khairthalpolice", "Khirthalpolice", "forest", "nwr", "satyatv99_news"];
  it("strict prefix (3 letters or more) and near duplicates, case-insensitive", () => {
    expect(strictHandlePrefix("@forest", "forestRajasthan")).toBe(true);
    expect(strictHandlePrefix("@forestRajasthan", "forest")).toBe(false);
    expect(strictHandlePrefix("@jp", "jpr_rural")).toBe(false);
    expect(handleLookalikeOf("@forest", directory)).toBe("forestRajasthan");
    expect(handleLookalikeOf("@nwr", directory)).toBe("NWRailways");
    expect(handleLookalikeOf("@Khirthalpolice", directory)).toBe("khairthalpolice");
    expect(handleLookalikeOf("@hbh", directory)).toBeNull();
  });
  it("@forest learns nothing (lookalike) and the desk is pointed at @forestRajasthan; the full handle is not a lookalike of its stub", () => {
    expect(learner.handleWithheld("@forest", directory)).toBe("lookalike");
    expect(learner.handleLookalike("@forest", directory)).toBe("forestRajasthan");
    // @forestRajasthan is a subject-file handle: the file decides when it is tagged, so it never learns either
    expect(learner.handleWithheld("@forestRajasthan", directory)).toBe("file_handle");
    expect(learner.handleWithheld("@JhalawarUp", ["JhalawarUpdates"])).toBe("lookalike");
    expect(learner.handleWithheld("@JhalawarUpdates", ["JhalawarUp"])).toBeNull();
  });
  it("a desk row that is a stub of another desk row is never suggested", () => {
    const forest: DeskHandleRow = { handle: "forest", entityName: "forest", aliases: ["Tonk", "टोंक"] };
    const real: DeskHandleRow = { handle: "forestRajasthan", entityName: "forestRajasthan", aliases: [] };
    expect(deskHandleRules([forest]).count).toBe(1);
    expect(deskHandleRules([forest, real]).count).toBe(0);
  });
});

describe("rule 6: a typed hashtag learns its own words, never places; a #handle is never a rule", () => {
  it("#RajasthanPanchayatElection2026 learns Panchayat, Election, never the stories' places", () => {
    expect(tagRuleKeywords("#RajasthanPanchayatElection2026", ctx)).toEqual({ keywords: ["Panchayat", "Election"], known: false });
    expect(tagRuleKeywords("#WeatherUpdate", ctx)).toEqual({ keywords: ["Weather"], known: false });
    expect(tagRuleKeywords("#JaipurMetro", ctx)).toEqual({ keywords: ["Metro"], known: false });
    expect(learner.tagKeywords("#bbhbh")).toEqual({ keywords: [], known: false });
  });
  it("#Balotrapolice (meant @BalotraPolice) and other handle-shaped tags are handles", () => {
    for (const t of ["#Balotrapolice", "#Khirthalpolice", "#JaipurDM", "#TonkCollector"]) expect(tagLooksLikeHandle(t)).toBe(true);
    expect(tagLooksLikeHandle("#jaipur_police", ["jaipur_police"])).toBe(true);
    expect(tagLooksLikeHandle("#JaipurPoliceNews")).toBe(false);
    for (const t of ["#RajasthanPanchayatElection2026", "#Jaisalmer", "#जयपुर"]) expect(tagLooksLikeHandle(t)).toBe(false);
  });
  it("a tag naming a known subject is a topic even when a handle of that name exists (#NarendraModi)", () => {
    expect(learner.tagIsHandle("#NarendraModi", ["narendramodi"])).toBe(false);
    expect(learner.tagIsHandle("#Balotrapolice", [])).toBe(true);
  });
});

describe("rule 7: a desk handle the desk keeps ignoring is offered no more", () => {
  it(`offered ${SUGGEST_RETIRE_OFFERS} times or more and taken under 5%`, () => {
    expect(suggestionRetired({ offered: 123, accepted: 0 })).toBe(true); // @hbh
    expect(suggestionRetired({ offered: 124, accepted: 0 })).toBe(true); // @nwr
    expect(suggestionRetired({ offered: 55, accepted: 1 })).toBe(true); // @jpr_rural's suggestions
    expect(suggestionRetired({ offered: 19, accepted: 0 })).toBe(false);
    expect(suggestionRetired({ offered: 40, accepted: 2 })).toBe(false);
    expect(suggestionRetired(undefined)).toBe(false);
  });
  it("@hbh is not suggested once retired, and the change rebuilds the rules", () => {
    const evidence = (offered: number) => ({ stories: [1, 2, 3].map((i) => story(`बूंदी में हादसा ${i}`, "", "Bundi")), suggest: { offered, accepted: 0 } });
    const fresh = withKeywordUses({ handle: "hbh", entityName: "hbh", aliases: ["Bundi", "बूंदी"] }, evidence(5), candidates);
    const retired = withKeywordUses({ handle: "hbh", entityName: "hbh", aliases: ["Bundi", "बूंदी"] }, evidence(123), candidates);
    expect(pick("बूंदी में बारिश", "Bundi", [fresh]).suggestions.map((h) => h.handle)).toContain("hbh");
    expect(pick("बूंदी में बारिश", "Bundi", [retired]).suggestions.map((h) => h.handle)).not.toContain("hbh");
    expect(deskAutoKey([fresh])).not.toBe(deskAutoKey([retired]));
  });
});

describe("G6: re-running the learning over decisions-like posts", () => {
  // Shaped like post_decisions rows (decisions_1524): the story's district and town, the final post, and each handle's
  // outcome. Emitted (kept) and accepted handles are what fed the old loop; only desk_added ones may teach now.
  type Row = { district: string | null; town: string | null; text: string; handles: [string, "desk_added" | "kept" | "accepted"][] };
  const rows: Row[] = [
    { district: "Jaipur", town: "जोबनेर", text: "जोबनेर में हादसा, एयर इंडिया की उड़ान", handles: [["@jpr_rural", "desk_added"]] },
    { district: "Jaipur", town: "चौमूं", text: "चौमूं में जाम, हैदराबाद से लौटे यात्री", handles: [["@jpr_rural", "desk_added"]] },
    { district: "Jhalawar", town: "झालावाड़", text: "झालावाड़ में IndiGo की चर्चा", handles: [["@jpr_rural", "kept"]] },
    { district: "Hanumangarh", town: null, text: "हनुमानगढ़ में स्वास्थ्य मंत्रालय की टीम", handles: [["@jpr_rural", "desk_added"]] },
    { district: "Tonk", town: "मालपुरा", text: "मालपुरा में बिजली कटौती, मुंबई की IndiGo", handles: [["@JaipurDiscom1", "kept"]] },
    { district: "Jodhpur", town: null, text: "जोधपुर में JVVNL जैसी कटौती, CMO Rajasthan", handles: [["@JaipurDiscom1", "desk_added"]] },
    { district: "Delhi", town: "दिल्ली", text: "दिल्ली में बैठक, तेलंगाना और पंजाब के नेता", handles: [["@NitinNabin", "desk_added"]] },
    { district: "Jaipur", town: "जयपुर", text: "जयपुर में अमित शाह, सचिन पायलट", handles: [["@NitinNabin", "accepted"], ["@forest", "desk_added"]] },
    { district: "Tonk", town: "टोंक", text: "टोंक में वन विभाग, सवाई माधोपुर रणथंभौर", handles: [["@forest", "desk_added"], ["@hbh", "desk_added"]] },
    { district: "Bikaner", town: null, text: "बीकानेर में निर्वाचन, तेलंगाना", handles: [["@laxmanraghav", "desk_added"], ["@satyatv99", "desk_added"], ["@nwr", "desk_added"]] },
  ];
  const directory = ["jpr_rural", "JaipurDiscom1", "NitinNabin", "forest", "forestRajasthan", "laxmanraghav", "satyatv99", "satyatv99_news", "hbh", "nwr", "NWRailways"];

  it("no handle learns a keyword outside its own district or name", () => {
    const learned = new Map<string, string[]>(directory.map((h) => [h, []]));
    for (const r of rows) {
      for (const [h, outcome] of r.handles) {
        if (outcome !== "desk_added") continue;
        const handle = h.replace(/^@/, "");
        if (learner.handleWithheld(handle, directory)) continue;
        const names = learner.handleNames(handle, story(r.text, "", r.district, r.town));
        learned.set(handle, mergeKeywords(learned.get(handle) ?? [], names).keywords);
      }
    }
    for (const [handle, keywords] of learned) {
      const own = new Set(learner.ownSubjectNames(handle));
      for (const k of keywords) {
        expect(placeOutsideHandle(handle, k, ctx), `${handle} ← ${k}`).toBe(false);
        expect(placeDistricts(k, book) !== null || own.has(k), `${handle} ← ${k} is neither its place nor its subject`).toBe(true);
      }
    }
    expect(learned.get("jpr_rural")).toEqual(["Jaipur", "जयपुर", "जोबनेर", "चौमूं"]);
    expect(learned.get("JaipurDiscom1")).toEqual(expect.arrayContaining(["JVVNL"]));
    for (const h of ["NitinNabin", "forest", "laxmanraghav", "satyatv99", "hbh", "nwr"]) expect(learned.get(h), h).toEqual([]);
  });
});
