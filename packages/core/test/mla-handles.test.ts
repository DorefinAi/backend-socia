// Two MLA handles in party-handles.json (13 Nov 2026).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, pickPartyHandles, slotFromTags,
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

describe("5. MLA handles in party-handles.json", () => {
  const json = cfg("party-handles.json");
  const entry = (h: string) => json.entries.find((e: { handle: string }) => e.handle === h);

  it("both are listed with their source and check date", () => {
    for (const h of ["@BMacharyaBJP", "@officialkharra"]) {
      expect(entry(h), h).toMatchObject({ party: "bjp", scope: "mla", source: `https://api.fxtwitter.com/${h.slice(1)}`, checkedAt: "2026-11-13" });
      expect(typeof entry(h).verified).toBe("boolean");
      expect(parties.handles!.has(h.slice(1).toLowerCase())).toBe(true);
    }
  });

  it("@officialkharra: verified, tagged when the headline names him", () => {
    expect(entry("@officialkharra").verified).toBe(true);
    const p = pickPartyHandles("UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", "अपने पैतृक गांव में किया मतदान", parties, true);
    expect(p.emit?.handle).toBe("officialkharra");
  });

  it("@officialkharra fires once, even with the subject entry verified as well", () => {
    const sj = cfg("subject-handles.json");
    const both = parseSubjectHandles({ ...sj, entries: sj.entries.map((e: { handle: string }) => (e.handle === "@officialkharra" ? { ...e, verified: true } : e)) });
    for (const s of [subjects, both]) {
      const p = parseBreaking(fileText(FILE, ["UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", "अपने पैतृक गांव भारनी में किया मतदान"]), FILE, book);
      const slot = slotFromTags(p.tags);
      const d = composeBreaking({ ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, { subjects: s, reporters, parties });
      const all = [...d.handles, ...d.handleSuggestions].map((h) => h.handle.toLowerCase()).filter((h) => h === "officialkharra");
      expect(all).toEqual(["officialkharra"]);
      expect(d.mentions.filter((m) => m === "@officialkharra")).toHaveLength(1);
    }
  });

  it("@BMacharyaBJP: not corroborated beyond its own bio, held unverified, so never tagged", () => {
    expect(entry("@BMacharyaBJP").verified).toBe(false);
    expect(entry("@BMacharyaBJP").note).toMatch(/HELD/);
    const p = pickPartyHandles("विधायक बालमुकुंद आचार्य ने किया निरीक्षण", "", parties, true);
    expect(p.emit).toBeNull();
    expect(p.suggest).toEqual([]);
  });

  it("like the AICC media handle, an MLA never displaces the state party handle", () => {
    const p = pickPartyHandles("भाजपा के मंत्री झाबर सिंह खर्रा ने किया मतदान", "", parties, true);
    expect(p.emit?.handle).toBe("BJP4Rajasthan");
  });
});
