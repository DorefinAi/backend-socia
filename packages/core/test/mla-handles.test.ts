// Two MLA handles in party-handles.json (13 Nov 2026): suggest-only.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, namesAnyParty, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, pickMlaHandles,
  pickPartyHandles, slotFromTags,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));

/** A breaking file as the desk saves it: the name on line 1, then the headline and the points */
const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const FILE = "BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_JPR3_BIG.txt";

// ─── 5. MLA handles ───────────────────────────────────────────────────────────
//
// User decision, 13 Nov 2026: scope "mla" is SUGGEST-ONLY. The handle is offered (unticked) when the copy names
// the member, never put on the post, and naming the member is not naming the party: before the MLA entries existed
// such a headline was not political, and it must not become political because of them.

/** The draft for a desk file with this headline and these points */
const draft = (headline: string, points: string[], opts: { subjects?: typeof subjects; parties?: typeof parties } = {}) => {
  const p = parseBreaking(fileText(FILE, [headline, ...points]), FILE, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects: opts.subjects ?? subjects, reporters, parties: opts.parties ?? parties },
  );
};
const lower = (hs: { handle: string }[]) => hs.map((h) => h.handle.toLowerCase());
/** The party file as it was before the two MLA entries were added */
const preMla = (() => {
  const j = cfg("party-handles.json");
  return parsePartyHandles({ ...j, entries: j.entries.filter((e: { scope?: string }) => e.scope !== "mla") });
})();

describe("5. MLA handles in party-handles.json", () => {
  const json = cfg("party-handles.json");
  const entry = (h: string) => json.entries.find((e: { handle: string }) => e.handle === h);

  it("both are listed with their source and check date, and both are MLA (suggest-only) rules", () => {
    for (const h of ["@BMacharyaBJP", "@officialkharra"]) {
      expect(entry(h), h).toMatchObject({ party: "bjp", scope: "mla", source: `https://api.fxtwitter.com/${h.slice(1)}`, checkedAt: "2026-11-13" });
      expect(typeof entry(h).verified).toBe("boolean");
      expect(parties.handles!.has(h.slice(1).toLowerCase())).toBe(true);
    }
    expect(parties.mla!.map((r) => r.handle).sort()).toEqual(["BMacharyaBJP", "officialkharra"]);
    // Never among the party's own rules: they cannot be emitted, clash, or make copy political
    expect(parties.rules.some((r) => r.scope === "mla")).toBe(false);
    expect(parties.rules.map((r) => r.handle)).toEqual(preMla.rules.map((r) => r.handle));
  });

  it("@officialkharra: a headline naming Kharra OFFERS the handle; it is not in the post", () => {
    expect(entry("@officialkharra").verified).toBe(true);
    const p = pickPartyHandles("UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", "अपने पैतृक गांव में किया मतदान", parties, true);
    expect(p.emit).toBeNull();
    expect(pickMlaHandles("UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", parties).map((r) => r.handle)).toEqual(["officialkharra"]);
    const d = draft("UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", ["अपने पैतृक गांव भारनी में किया मतदान"]);
    expect(lower(d.handles)).not.toContain("officialkharra");
    expect(d.mentions).not.toContain("@officialkharra");
    expect(lower(d.handleSuggestions)).toContain("officialkharra");
  });

  it("@BMacharyaBJP: kept verified:false, still OFFERED when the copy names Balmukund Acharya, never in the post", () => {
    expect(entry("@BMacharyaBJP").verified).toBe(false);
    expect(pickPartyHandles("विधायक बालमुकुंद आचार्य ने किया निरीक्षण", "", parties, true)).toEqual({ emit: null, suggest: [] });
    for (const head of ["विधायक बालमुकुंद आचार्य ने किया निरीक्षण", "विधायक बालमुकुंदाचार्य पहुंचे नगर निगम"]) {
      const d = draft(head, ["औचक निरीक्षण करने पहुंचे नगर निगम"]);
      expect(lower(d.handles), head).not.toContain("bmacharyabjp");
      expect(d.mentions, head).not.toContain("@BMacharyaBJP");
      expect(lower(d.handleSuggestions), head).toContain("bmacharyabjp");
    }
  });

  it("a member named only in the points is offered as well", () => {
    const d = draft("नगर निगम में औचक निरीक्षण", ["विधायक बालमुकुंद आचार्य पहुंचे"]);
    expect(lower(d.handles)).not.toContain("bmacharyabjp");
    expect(lower(d.handleSuggestions)).toContain("bmacharyabjp");
  });

  it("no duplicate: with the subject entry verified, @officialkharra appears once (tagged by the subject), not also offered", () => {
    const sj = cfg("subject-handles.json");
    const both = parseSubjectHandles({ ...sj, entries: sj.entries.map((e: { handle: string }) => (e.handle === "@officialkharra" ? { ...e, verified: true } : e)) });
    for (const s of [subjects, both]) {
      const d = draft("UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", ["अपने पैतृक गांव भारनी में किया मतदान"], { subjects: s });
      const all = [...d.handles, ...d.handleSuggestions].map((h) => h.handle.toLowerCase()).filter((h) => h === "officialkharra");
      expect(all).toEqual(["officialkharra"]);
      expect(d.mentions.filter((m) => m === "@officialkharra")).toHaveLength(s === both ? 1 : 0);
      expect(lower(d.handleSuggestions).filter((h) => h === "officialkharra")).toHaveLength(s === both ? 0 : 1);
    }
  });

  it("an MLA never displaces the state party handle, and is offered beside it", () => {
    const p = pickPartyHandles("भाजपा के मंत्री झाबर सिंह खर्रा ने किया मतदान", "", parties, true);
    expect(p.emit?.handle).toBe("BJP4Rajasthan");
    const d = draft("भाजपा के मंत्री झाबर सिंह खर्रा ने किया मतदान", ["गांव में किया मतदान"]);
    expect(lower(d.handles)).not.toContain("officialkharra");
    expect(lower(d.handleSuggestions)).toContain("officialkharra");
  });

  it("naming an MLA is not naming the party: the class and the post's handles are what they were before the MLA entries", () => {
    expect(namesAnyParty("झाबर सिंह खर्रा ने किया अस्पताल का निरीक्षण", parties)).toBe(false);
    expect(namesAnyParty("बालमुकुंद आचार्य ने किया निरीक्षण", parties)).toBe(false);
    for (const [head, points] of [
      ["झाबर सिंह खर्रा ने किया अस्पताल का निरीक्षण", ["पुलिस और प्रशासन मौजूद"]],
      ["UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", ["अपने पैतृक गांव भारनी में किया मतदान"]],
      ["बालमुकुंद आचार्य की गाड़ी से हादसा, युवक घायल", ["पुलिस मौके पर"]],
      ["कांग्रेस ने झाबर सिंह खर्रा पर साधा निशाना", ["बयान जारी"]],
    ] as const) {
      const now = draft(head, [...points]);
      const before = draft(head, [...points], { parties: preMla });
      expect(now.cls, head).toBe(before.cls);
      expect(lower(now.handles), head).toEqual(lower(before.handles));
    }
  });
});
