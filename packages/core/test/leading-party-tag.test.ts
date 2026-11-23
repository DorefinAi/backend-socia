// Handle fixes F10 (14 Nov 2026): a headline that leads with a party, topic or label tag ("#BJP: …") lost the place.
// Such a tag does not fill the district slot: the stated district or a reporter's desk rule still goes in front of it,
// the text's district is still offered, and the desk's own tags stay where it wrote them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaceBook, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, slotFromTags, type BreakingDraft } from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const opts = { subjects: parseSubjectHandles(cfg("subject-handles.json")), reporters: parseReporterHandles(cfg("reporter-handles.json")), parties: parsePartyHandles(cfg("party-handles.json")) };
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;
function draft(name: string, lines: string[]): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking({ ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, opts);
}
const line1 = (d: BreakingDraft) => d.bodyText.split("\n")[0]!;

describe("F10: a leading party tag does not fill the district slot", () => {
  it("F10 test: '#BJP: …' filed by rituraj with no place → '#Jaipur: ' added before it, #BJP kept", () => {
    const d = draft(fileFor("RITURAJ"), ["#BJP: प्रदेश कार्यसमिति की बैठक आज", "संगठन चुनाव पर होगी चर्चा"]);
    expect(line1(d)).toBe("#Jaipur: #BJP: प्रदेश कार्यसमिति की बैठक आज");
    expect(d.districtSource).toBe("reporter_policy");
  });

  it("#Congress and #INC too; a run of two non-place tags too", () => {
    for (const run of ["#Congress:", "#INC:", "#BJP #Congress:"]) {
      expect(line1(draft(fileFor("RITURAJ"), [`${run} प्रदेश कार्यसमिति की बैठक आज`, "संगठन चुनाव पर चर्चा"])), run).toBe(`#Jaipur: ${run} प्रदेश कार्यसमिति की बैठक आज`);
    }
  });

  it("the district from the text goes in the tag line, not line 1 (no reporter rule); the party tag stays as written", () => {
    // Vikas carries no desk rule (Naresh, used here before, got one on 23 Nov 2026)
    const d = draft(fileFor("VIKAS"), ["#BJP: कोटा में प्रदेश कार्यसमिति की बैठक", "संगठन चुनाव पर चर्चा"]);
    expect(line1(d)).toBe("#BJP: कोटा में प्रदेश कार्यसमिति की बैठक");
    expect(d.hashtags).toContain("#Kota");
    expect(d.headingPlace).toMatchObject({ source: "inferred", placement: "trailing" });
    // Naresh now has the #Jaipur desk rule; a place found only in the text does not block it (13 Nov decision)
    expect(line1(draft(fileFor("NARESH"), ["#BJP: कोटा में प्रदेश कार्यसमिति की बैठक", "संगठन चुनाव पर चर्चा"]))).toBe("#Jaipur: #BJP: कोटा में प्रदेश कार्यसमिति की बैठक");
  });

  it("a run WITH a place is still the desk's line 1, as written: no tag added", () => {
    expect(line1(draft(fileFor("RITURAJ"), ["#BJP #Kota: बैठक आज", "संगठन चुनाव पर चर्चा"]))).toBe("#BJP #Kota: बैठक आज");
    expect(line1(draft(fileFor("RITURAJ"), ["#Congress #Jodhpur: प्रदर्शन आज", "कलेक्ट्रेट पर धरना"]))).toBe("#Congress #Jodhpur: प्रदर्शन आज");
  });

  it("the reporter rule keeps its guards: a place written elsewhere in the copy still blocks #Jaipur", () => {
    const d = draft(fileFor("RITURAJ"), ["#BJP: प्रदेश कार्यसमिति की बैठक", "संगठन चुनाव पर चर्चा #JodhpurNews"]);
    expect(line1(d)).toBe("#BJP: प्रदेश कार्यसमिति की बैठक");
  });
});
