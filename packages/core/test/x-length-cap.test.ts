// P2 (owner, 25 Nov 2026): the composed draft fits X's 280 (twitter-text weights: Devanagari 1 per code point). On
// 23-24 Nov 20 of 36 drafts were over and the desk cut handles on X, the party pair first. Tag-line items now go back
// to the suggestions in a fixed order (reason "length") before any text is cut.
// Fixtures: the desk's breaking files of 24 Nov.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BREAKING_POST_MAX, PlaceBook, assemblePostText, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData,
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
  it("Sirohi 24 Nov: the party handles go back to the suggestions, second one first; the text and the hashtags stay", () => {
    const uncapped = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: BREAKING_POST_MAX });
    expect(xLen(post(uncapped))).toBeGreaterThan(280);
    expect(uncapped.mentions).toEqual(expect.arrayContaining(["@INCRajasthan", "@BJP4Rajasthan"]));
    const d = draft(SIROHI_FILE, SIROHI, SIROHI_AT);
    expect(xLen(post(d))).toBeLessThanOrEqual(280);
    // Lines 1-2 as laid out without the cap: nothing more was cut
    expect(d.bodyText).toBe(uncapped.bodyText);
    expect(d.headlineCut).toBe(false);
    expect(d.mentions).not.toContain("@INCRajasthan");
    expect(d.mentions).not.toContain("@BJP4Rajasthan");
    // The second party named goes first, then the first; both offered first in the list, reason "length"
    expect(lengthMoves(d)).toEqual(["suggest:@BJP4Rajasthan", "suggest:@INCRajasthan"]);
    expect(d.handleSuggestions.slice(0, 2).map((h) => h.handle)).toEqual(["BJP4Rajasthan", "INCRajasthan"]);
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
    const e = draft(SIROHI_FILE, SIROHI, SIROHI_AT, { xLimit: BREAKING_POST_MAX, limit: 260 });
    expect(xLen(post(e))).toBeLessThanOrEqual(260);
  });
});
