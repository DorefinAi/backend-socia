// The desk's handle and hashtag library learns from what the desk posts (core learn.ts): which names a story gives,
// which handles may learn, when a learned keyword is offered and when it is added, and a hashtag's rule keywords.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DESK_LEARNED_POSTED_USES, MAX_HANDLE_KEYWORDS, PlaceBook, PostedLearner, SETTINGS_POSTED_USES, deskAutoKey, deskHandleRules, deskKeywordAuto, deskKeywordOffered, districtKeywordCandidates,
  handleLearnWithheld, isFooterTag, keywordPostedCounts, knownTagNames, mergeKeywords, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles,
  parseSubjectHandles, pickHandlesExplained, storyNames, tagRuleKeywords, tagWords, withKeywordUses, type DeskHandleRow, type LearnStory,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const subjects = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const ctx = { book, subjects };
const story = (headline: string, body = "", district: string | null = null, town: string | null = null): LearnStory => ({ headline, body, district, town });

describe("storyNames: only the names the system recognises", () => {
  it("takes the district (both scripts), the place-line town, places and subjects in the text; never ordinary words", () => {
    const names = storyNames(story("मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण", "रावतभाटा में नई सड़क", "Kota", "रावतभाटा"), ctx);
    expect(names.slice(0, 3)).toEqual(["Kota", "कोटा", "रावतभाटा"]);
    expect(names).toEqual(expect.arrayContaining(["Bhajanlal Sharma", "भजनलाल शर्मा"]));
    for (const word of ["लोकार्पण", "सड़क", "नई", "किया"]) expect(names).not.toContain(word);
  });

  it("a district named in the text brings its English name too, each name once", () => {
    expect(storyNames(story("जैसलमेर में बारिश", "जैसलमेर के गांव में"), ctx)).toEqual(["Jaisalmer", "जैसलमेर"]);
  });

  it("a story naming nothing known gives nothing", () => {
    expect(storyNames(story("तेज बारिश से नदी उफान पर", "स्कूल बंद"), ctx)).toEqual([]);
    expect(storyNames(story("", ""), { book: null, subjects: null })).toEqual([]);
  });
});

describe("mergeKeywords", () => {
  it("adds only new names, folded, and stops at MAX_HANDLE_KEYWORDS", () => {
    expect(mergeKeywords(["Jaipur", "जयपुर"], ["jaipur", "Kota", "कोटा", "Kota"])).toEqual({ keywords: ["Jaipur", "जयपुर", "Kota", "कोटा"], added: ["Kota", "कोटा"] });
    const many = Array.from({ length: 40 }, (_, i) => `Name${i}`);
    expect(mergeKeywords([], many).keywords).toHaveLength(MAX_HANDLE_KEYWORDS);
    // Too short to match is never a keyword
    expect(mergeKeywords([], ["CM", "SP"]).added).toEqual([]);
  });
});

describe("which desk handles may learn", () => {
  const files = [...(rules.all ?? []), ...(subjects.handles ?? [])];
  const c = { candidates: districtKeywordCandidates(), fileHandles: files };
  it("withholds a data-file handle, a lookalike of one, a party's and an official's (the add rules)", () => {
    expect(handleLearnWithheld("@jaipur_police", c)).toBe("file_handle");
    expect(handleLearnWithheld("@jaipurpolice", c)).toBe("lookalike");
    expect(handleLearnWithheld("@BJP4Kota", c)).toBe("party");
    expect(handleLearnWithheld("@Thana_Rawatbhata", c)).toBe("official");
    expect(handleLearnWithheld("@JhalawarUpdates", c)).toBeNull();
  });
  it("withholds a lookalike of another handle in the org's directory, not the handle itself", () => {
    expect(handleLearnWithheld("@JhalawarUpdatse", { ...c, directoryHandles: ["@JhalawarUpdates", "JhalawarUpdatse"] })).toBe("lookalike");
    expect(handleLearnWithheld("@JhalawarUpdates", { ...c, directoryHandles: ["JhalawarUpdates"] })).toBeNull();
  });
  it("PostedLearner counts every directory file's handles as file handles: a reporter's never learns", () => {
    const reporters = parseReporterHandles(json("../../../apps/worker/config/reporter-handles.json"));
    const parties = parsePartyHandles(json("../../../apps/worker/config/party-handles.json"));
    const learner = new PostedLearner({ book, subjects, fileHandles: [...files, ...(parties.handles ?? []), ...(reporters.handles ?? [])] });
    const reporter = [...(reporters.handles ?? [])][0]!;
    expect(learner.handleWithheld(`@${reporter}`)).toBe("file_handle");
    expect(learner.handleWithheld("@JhalawarUpdates")).toBeNull();
  });
});

describe("a learned keyword: used from two desk-typed stories, never added on its own when it is a place", () => {
  it("counts each posted story once per keyword, the district field in both scripts", () => {
    const counts = keywordPostedCounts(["Jaipur", "जयपुर", "चाकसू"], [
      story("चाकसू में हादसा", "", "Jaipur"),
      story("जयपुर में बारिश, जयपुर में जाम"),
      story("कोटा में बारिश", "", "Kota"),
    ]);
    expect(Object.fromEntries(counts)).toEqual({ jaipur: 1, "जयपुर": 2, "चाकसू": 1 });
  });

  it("is the same threshold as the Settings handles", () => {
    expect(DESK_LEARNED_POSTED_USES).toBe(SETTINGS_POSTED_USES);
  });

  const row: DeskHandleRow = { handle: "@ChaksuNews", entityName: "ChaksuNews", aliases: ["चाकसू", "Jaipur", "जयपुर"] };
  it("a row read without its posts keeps the old rule (every keyword added); with them, one story uses nothing, two only offer a place", () => {
    expect(row.aliases.every((k) => deskKeywordAuto(row, k))).toBe(true);
    const once = withKeywordUses(row, [story("चाकसू में हादसा", "", "Jaipur")], districtKeywordCandidates());
    expect(once.aliases.map((k) => deskKeywordAuto(once, k))).toEqual([false, false, false]);
    expect(once.aliases.map((k) => deskKeywordOffered(once, k))).toEqual([false, false, false]);
    const twice = withKeywordUses(row, [story("चाकसू में हादसा", "", "Jaipur"), story("चाकसू में बारिश")], districtKeywordCandidates());
    expect(twice.aliases.map((k) => deskKeywordAuto(twice, k))).toEqual([false, false, false]);
    expect(twice.aliases.map((k) => deskKeywordOffered(twice, k))).toEqual([true, false, false]);
    expect(deskAutoKey([once])).not.toBe(deskAutoKey([twice]));
  });

  it("a keyword found inside the handle string is added from the start", () => {
    const own = withKeywordUses({ handle: "@JhalawarUpdates", entityName: "Jhalawar", aliases: ["Jhalawar", "झालावाड़", "Kota"] }, [], districtKeywordCandidates());
    expect(own.aliases.map((k) => deskKeywordAuto(own, k))).toEqual([true, true, false]);
  });

  it("pickHandles: one desk-typed story uses nothing, two offer a place, never tag it", () => {
    const once = withKeywordUses(row, [story("चाकसू में हादसा", "", "Jaipur")], districtKeywordCandidates());
    const many = withKeywordUses(row, [1, 2, 3, 4].map((i) => story(`चाकसू में हादसा ${i}`, "", "Jaipur")), districtKeywordCandidates());
    const pick = (r: DeskHandleRow) => pickHandlesExplained({ headline: "चाकसू में मेला", points: [], district: null, rajasthan: true, leaderPost: false }, rules, { subjects, desk: deskHandleRules([r]) });
    const unused = pick(once);
    expect(unused.handles.map((h) => h.handle)).not.toContain("ChaksuNews");
    expect(unused.suggestions.map((h) => h.handle)).not.toContain("ChaksuNews");
    const offered = pick(many);
    expect(offered.handles.map((h) => h.handle)).not.toContain("ChaksuNews");
    expect(offered.suggestions.map((h) => h.handle)).toContain("ChaksuNews");
  });
});

describe("hashtag rule keywords", () => {
  it("never the footer tags, nor a tag run on from one", () => {
    expect(isFooterTag("#RajasthanWithFirstIndia")).toBe(true);
    expect(isFooterTag("#firstindianews")).toBe(true);
    expect(isFooterTag("#RajasthanWithFirstIndiaJaipurPolice")).toBe(true);
    expect(isFooterTag("#Jaisalmer")).toBe(false);
  });

  it("a known district, town, national place or subject gets its own Hindi and English names", () => {
    expect(knownTagNames("#Jaisalmer", ctx)).toEqual(["Jaisalmer", "जैसलमेर"]);
    expect(knownTagNames("#Khairthal", ctx)).toEqual(expect.arrayContaining(["Khairthal-Tijara", "Khairthal", "खैरथल"]));
    expect(knownTagNames("#जैसलमेर", ctx)).toEqual(["Jaisalmer", "जैसलमेर"]);
    expect(knownTagNames("#Delhi", ctx)).toEqual(["Delhi", "दिल्ली"]);
    expect(knownTagNames("#BhajanlalSharma", ctx)).toEqual(expect.arrayContaining(["Bhajanlal Sharma", "भजनलाल शर्मा"]));
    expect(knownTagNames("#IPL", ctx)).toBeNull();
    // A known tag ignores the story it went on
    expect(tagRuleKeywords("#Jaisalmer", ctx)).toEqual({ keywords: ["Jaisalmer", "जैसलमेर"], known: true });
  });

  it("any other tag: only its CamelCase words (4 letters or more, no stop words, no places), never the story's names", () => {
    expect(tagWords("#RajasthanPanchayatElection2026")).toEqual(["Panchayat", "Election"]);
    expect(tagWords("#MSDhoni")).toEqual(["Dhoni"]);
    expect(tagWords("#bbhbh")).toEqual([]);
    expect(tagWords("#IPL")).toEqual([]);
    expect(tagRuleKeywords("#JaswantYadav", ctx)).toEqual({ keywords: ["Jaswant", "Yadav"], known: false });
    // Nothing to match on: the rule is saved inactive
    expect(tagRuleKeywords("#RCA", ctx)).toEqual({ keywords: [], known: false });
  });
});
