// P2 (owner, 25 Nov 2026): the composed draft fits X's 280 (twitter-text weights: Devanagari 1 per code point). On
// 23-24 Nov 20 of 36 drafts were over and the desk cut handles on X, the party pair first. Tag-line items now go back
// to the suggestions in a fixed order (reason "length") before any text is cut.
// Fixtures: the desk's breaking files of 24 Nov.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BREAKING_BODY_FLOOR, BREAKING_POST_MAX, PlaceBook, assemblePostText, handleProposal, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData,
  parseReporterHandles, parseSubjectHandles, parseSuggestRules, slotFromTags, xLen, type BreakingDraft, type BreakingComposeOptions,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));

function draft(name: string, lines: string[], at: string, extra: BreakingComposeOptions = {}): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, suggestRules, at: new Date(at), ...extra },
  );
}
const post = (d: BreakingDraft) => assemblePostText(d.bodyText, d.hashtags, d.mentions);
const lengthMoves = (d: BreakingDraft) => d.proposals.filter((p) => p.reason === "length").map((p) => `${p.layer}:${p.item}`);

// BTN_RJ_BREAKING_24NOV_2810_AM_CONTROL_ASHOK_SIR_BIG_KARARI_ (Sirohi): 306 characters as composed; on X the desk kept
// the election tag and both party hashtags and dropped both party handles
const SIROHI = [
  "सिरोही",
  "जिला प्रमुख की कुर्सी पर कांग्रेस में घमासान, दो चेहरों के नाम पर मंथन !",
  "जिला परिषद की 27 में से 22 सीटें जीतकर कांग्रेस ने बनाया बहुमत, भाजपा के पास महज 5 सीट",
  "कल 25 नवंबर को जिला प्रमुख और 26 नवंबर को होगा उप जिला प्रमुख का चुनाव",
  "जिला परिषद के DRDA हॉल में संपन्न होगी निर्वाचन प्रक्रिया",
];
const SIROHI_FILE = "BTN_RJ_BREAKING_24NOV_2810_AM_CONTROL_ASHOK_SIR_BIG_KARARI_.txt";
const SIROHI_AT = "2026-11-24T13:45:32Z";

describe("P2: the draft fits X's 280", () => {
  it("Sirohi 24 Nov: the party handles, second one first, then the collector go back to the suggestions; the text and the hashtags stay", () => {
    const uncapped = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: BREAKING_POST_MAX });
    expect(xLen(post(uncapped))).toBeGreaterThan(280);
    expect(uncapped.mentions).toEqual(expect.arrayContaining(["@INCRajasthan", "@BJP4Rajasthan"]));
    const d = draft(SIROHI_FILE, SIROHI, SIROHI_AT);
    expect(xLen(post(d))).toBeLessThanOrEqual(280);
    // Lines 1-2 as laid out without the cap: nothing more was cut
    expect(d.bodyText).toBe(uncapped.bodyText);
    expect(d.headlineCut).toBe(false);
    // Line 2 is whole points since 27 Nov 2026 (shorter than the old 130 cut): only the second party handle has to go
    expect(d.mentions).toEqual(["@Dmsirohi", "@INCRajasthan"]);
    expect(lengthMoves(d)).toEqual(["suggest:@BJP4Rajasthan"]);
    // Tighter: the second party named goes first, then the first, then the collector; offered first, reason "length"
    const tight = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: 250 });
    expect(xLen(post(tight))).toBeLessThanOrEqual(250);
    expect(lengthMoves(tight)).toEqual(["suggest:@BJP4Rajasthan", "suggest:@INCRajasthan", "suggest:@Dmsirohi"]);
    expect(tight.handleSuggestions.slice(0, 3).map((h) => h.handle)).toEqual(["BJP4Rajasthan", "INCRajasthan", "Dmsirohi"]);
    // The hashtags the desk kept on X stay on the post
    expect(d.hashtags).toEqual(uncapped.hashtags);
    expect(d.hashtags).toContain("#RajasthanPanchayatElection2026");
  });

  it("never moves the city tag, the brand tag, the reporter byline or a subject handle (Rathore at BJP HQ, 24 Nov)", () => {
    const lines = [
      "मंत्री राज्यवर्धन राठौड़ निकले बीजेपी प्रदेश मुख्यालय से", "प्रभारी संजय भाटिया और प्रदेश अध्यक्ष मदन राठौड़ से मिले",
      "पंचायत चुनाव परिणाम पर आपसी बातचीत हुई", "कैबिनेट मंत्री राज्यवर्धन राठौड़ ने अपनी ओर से दिया Feedback",
    ];
    const name = "BTN_RJ_BREAKING_2125_24NOV_mh_CONTROL_Yogesh_big.txt";
    const uncapped = draft(name, ["जयपुर से खबर", ...lines], "2026-11-24T06:56:58Z", { xLimit: BREAKING_POST_MAX });
    expect(xLen(post(uncapped))).toBeGreaterThan(280);
    const d = draft(name, ["जयपुर से खबर", ...lines], "2026-11-24T06:56:58Z");
    expect(lengthMoves(d).length).toBeGreaterThan(0);
    expect(xLen(post(d))).toBeLessThanOrEqual(280);
    const kept = new Set(d.mentions);
    for (const h of uncapped.handles) {
      if (h.reason === "reporter" || h.reason === "subject" || h.reason === "cm") expect(kept.has(`@${h.handle}`), h.handle).toBe(true);
    }
    expect(d.hashtags[0]).toBe("#RajasthanWithFirstIndia");
    expect(d.headingPlace.tags).toEqual(uncapped.headingPlace.tags);
    for (const t of d.headingPlace.tags) expect(`${d.bodyText}\n${d.hashtags.join(" ")}`).toContain(t);
  });

  it("a post already within 280 moves nothing", () => {
    const d = draft("BTN_RJ_BREAKING_24NOV_2799_AM_CONTROL_JPR9_BIG_.txt", [
      "जमवारामगढ़ से खबर", "जयपुर-जमवारामगढ़ स्टेट हाईवे पर भीषण सड़क हादसा", "तेज रफ्तार डंपर ने मारी बाइक को टक्कर",
    ], "2026-11-24T12:43:47Z");
    expect(xLen(post(d))).toBeLessThanOrEqual(280);
    expect(lengthMoves(d)).toEqual([]);
  });

  it("the cap is configurable and the tighter of xLimit and limit applies", () => {
    const d = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: 240 });
    expect(xLen(post(d))).toBeLessThanOrEqual(240);
    // Hashtags never move for length (on X the desk keeps them; moving them lost 10 kept for 4 avoided): line 2 gives way
    expect(d.hashtags).toEqual(draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: BREAKING_POST_MAX }).hashtags);
    expect(d.proposals.filter((p) => p.reason === "length" && p.kind === "hashtag")).toEqual([]);
    const e = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: BREAKING_POST_MAX, limit: 260 });
    expect(xLen(post(e))).toBeLessThanOrEqual(260);
  });

  it("an incident's police handle stays; line 2 gives way first (Jaipur court-ordered possession, 20 Nov)", () => {
    // BTN_RJ_BREAKING_6105_20NOV_US_CONTROL_om_court_jpr_kamalkant_big: the cap used to move @jaipur_police off at full line 2
    const name = "BTN_RJ_BREAKING_6105_20NOV_US_CONTROL_om_court_jpr_kamalkant_big.txt";
    const lines = [
      "जयपुर", "वित्तीय आस्तियों का प्रतिभूतिकरण व पुनर्गठन एवं प्रतिभूतिहित का प्रवर्तन एक्ट, 2002 से जुड़ा प्रकरण",
      "अदालत के आदेश से सीज की गई संपत्ति के ताले तोड़ कर किया गया अवैध कब्जा", "अतिरिक्त मुख्य न्यायिक मजिस्ट्रेट ने बंधक संपत्ति पर पुनः कब्जा दिलाने के दिए आदेश",
      "आवश्यकता होने पर पुलिस को नियमानुसार इमदाद उपलब्ध कराने के भी दिए निर्देश",
    ];
    const at = "2026-11-20T14:10:49Z";
    const uncapped = draft(name, lines, at, { xLimit: BREAKING_POST_MAX });
    expect(uncapped.mentions).toContain("@jaipur_police");
    // Whole-point line 2 (27 Nov 2026): this post now fits 280 as it is, police included
    const d = draft(name, lines, at);
    expect(xLen(post(d))).toBeLessThanOrEqual(280);
    expect(d.mentions).toContain("@jaipur_police");
    expect(lengthMoves(d)).toEqual([]);
    // Line 2 cannot shrink inside a point: when only dropping it makes room, it goes and the police handle stays (it never
    // loses both: a handle moved off comes back once line 2 has gone)
    const tight = draft(name, lines, at, { xLimit: 230 });
    expect(xLen(post(tight))).toBeLessThanOrEqual(230);
    expect(tight.mentions).toContain("@jaipur_police");
    expect(tight.bodyText.split("\n\n")[1]).toBeUndefined();
    expect(lengthMoves(tight)).toEqual([]);
  });

  it("a handle moved for length carries movedFor and logs reason 'length' (the desk's suggestion reason too)", () => {
    const d = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: 250 });
    const moved = d.handleSuggestions.filter((h) => h.movedFor === "length");
    expect(moved.map((h) => h.handle)).toEqual(["BJP4Rajasthan", "INCRajasthan", "Dmsirohi"]);
    for (const h of moved) expect(handleProposal(h, "suggest")).toMatchObject({ layer: "suggest", reason: "length" });
  });
});
