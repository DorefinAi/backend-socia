// P7 (owner, 25 Nov 2026): the handles and the hashtag the desk adds by hand every day are OFFERED, never tagged by
// these rules: @DmChittorgarh on Chittorgarh's local copy (17 times on X, 23-24 Nov), @RajCMO when the CM is named,
// #Jaipur on a state-capital story that names no city (never one naming Delhi, another state or a foreign country).
// Fixtures: the desk's breaking files of 19-24 Nov (first lines only).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles,
  parseSuggestRules, slotFromTags, type BreakingDraft,
} from "../src";
import { stateCapitalStory } from "../src/breaking/capital";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));

function draft(name: string, lines: string[], at: string): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, suggestRules, at: new Date(at) },
  );
}
const tagged = (d: BreakingDraft) => d.handles.map((h) => h.handle.toLowerCase());
const offered = (d: BreakingDraft) => d.handleSuggestions.map((h) => h.handle.toLowerCase());

describe("P7: @DmChittorgarh on Chittorgarh's local copy", () => {
  it("offers it on a civic story with no byline (Begun smart meters, 23 Nov), and does not tag it", () => {
    const d = draft("BTN_RJ_BREAKING_23NOV_2745_AM_CONTROL_PK_AGARWAL_BIG_.txt", [
      "चित्तौड़गढ़ के बेगूं से खबर", "बेगूं में 1 दिसंबर से स्मार्ट मीटर की रीडिंग होगी ऑनलाइन", "3 से 6 दिसंबर के बीच उपभोक्ताओं के बिजली बिल होंगे जनरेट",
    ], "2026-11-23T07:14:30Z");
    expect(tagged(d)).not.toContain("dmchittorgarh");
    expect(offered(d)).toContain("dmchittorgarh");
    expect(d.proposals).toContainEqual(expect.objectContaining({ item: "@DmChittorgarh", layer: "suggest", source: "district.collector" }));
  });
  it("not on crime copy: the police take it (Parsoli thana, 23 Nov)", () => {
    const d = draft("BTN_RJ_BREAKING_1035_23NOV_MS_CONTROL_PK_big.txt", [
      "चित्तौड़गढ़ के बेगूं से खबर", "पारसोली थाना पुलिस ने अवैध बजरी से भरा डंपर किया जब्त", "रात की गश्त के दौरान पुलिस ने की कार्रवाई",
    ], "2026-11-23T11:27:20Z");
    expect(tagged(d)).toContain("chghpolice");
    expect(offered(d)).not.toContain("dmchittorgarh");
  });
  it("only a collector entry may carry offer_on_local", () => {
    const bad = { version: 2, state: [], districts: { Chittorgarh: [{ handle: "@ChghPolice", handle_type: "district", role: "police", verified: true, offer_on_local: true }] } };
    expect(() => parseHandleRules(bad)).toThrow(/offer_on_local/);
  });
});

describe("P7: @RajCMO when the CM is named", () => {
  it("'CM भजनलाल शर्मा ने श्री गुरु नानक देव जी की जयंती पर दी शुभकामनाएं' (24 Nov) offers @RajCMO and does not tag it", () => {
    const d = draft("BTN_RAJ_BREAKING_1313_24NOV_NDR_CONTROLL_TV_CM_BIG_FULL.txt", [
      "CM भजनलाल शर्मा ने श्री गुरु नानक देव जी की जयंती पर दी शुभकामनाएं", "गुरु नानक देव जी के पावन प्रकाश पर्व पर कोटि-कोटि नमन किया",
    ], "2026-11-24T03:21:29Z");
    expect(d.mentions).not.toContain("@RajCMO");
    expect(offered(d)).toContain("rajcmo");
  });
});

describe("P7: #Jaipur offered on a state-capital story", () => {
  const capitalOffer = (d: BreakingDraft) => d.hashtagSuggestionItems.find((t) => t.source === "district.capital");
  it("'मुख्य सचिव वी.श्रीनिवास पहुंचे लोकभवन' (23 Nov, no city): #Jaipur offered first, not applied", () => {
    const d = draft("BTN_RJ_BREAKING_2109_23NOV_mh_CONTROL_naresh_rituraj_big.txt", [
      "मुख्य सचिव वी.श्रीनिवास पहुंचे लोकभवन", "राज्यपाल हरिभाऊ बागडे से कर रहे मुलाकात", "दोनों के बीच हो रही शिष्टाचार भेंट",
    ], "2026-11-23T05:45:16Z");
    expect(d.bodyText).not.toMatch(/#Jaipur/);
    expect(d.hashtags).not.toContain("#Jaipur");
    expect(capitalOffer(d)?.tag).toBe("#Jaipur");
    expect(d.hashtagSuggestions[0]).toBe("#Jaipur");
  });
  it("never on copy naming Delhi: 'राजस्थान हाईकोर्ट जस्टिस … का दिल्ली दौरा' (24 Nov)", () => {
    const d = draft("BTN_RJ_BREAKING_2123_24NOV_mh_CONTROL_Krishan_Murari_big.txt", [
      "राजस्थान हाईकोर्ट जस्टिस अशोक कुमार जैन का दिल्ली दौरा", "इंडिगो फ्लाइट 6 E 6492 से जयपुर एयरपोर्ट से जाएंगे दिल्ली",
    ], "2026-11-24T06:54:02Z");
    expect(capitalOffer(d)).toBeUndefined();
  });
  it("stateCapitalStory: a foreign visit, a former CM and a constituency are not the capital", () => {
    expect(stateCapitalStory("मुख्य सचिव वी.श्रीनिवास का सियोल दौरा", book)).toBe(false);
    expect(stateCapitalStory("पूर्व मुख्यमंत्री अशोक गहलोत ने की मीडिया से बातचीत", book)).toBe(false);
    expect(stateCapitalStory("मंत्रीजी को अपने विधानसभा क्षेत्र में एक भी जगह नहीं मिली जीत", book)).toBe(false);
    expect(stateCapitalStory("पंजाब विधानसभा चुनाव पर बड़ी खबर", book)).toBe(false);
    expect(stateCapitalStory("सचिवालय से राजेंद्र छाबड़ा की Report", book)).toBe(true);
    expect(stateCapitalStory("विधानसभा अध्यक्ष वासुदेव देवनानी ने ली बैठक", book)).toBe(true);
  });
});
