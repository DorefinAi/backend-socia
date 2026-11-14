// Desk fixes 14 Nov, point 7: handles added in Settings ("manual") or promoted from staging reach the composer, matched
// on their own names (English, Hindi, aliases) and the keywords inside the handle, under the desk-add safety rules.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_HANDLE_KEYWORDS, directoryHandleNames, directoryHandleRules, districtKeywordCandidates, parseHandleRules, parseSubjectHandles, pickHandles,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const subjectsFile = json("../../../apps/worker/config/subject-handles.json");
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const subjects = parseSubjectHandles(subjectsFile);
const ctx = { candidates: [...districtKeywordCandidates(), ...(subjects.keywordCandidates ?? [])], fileHandles: [...rules.all!, ...subjects.handles!] };
const row = (handle: string, entityName: string, entityNameHi: string | null = null, aliases: string[] = []) => ({ handle, entityName, entityNameHi, aliases });

describe("Settings handles: the names they are matched on", () => {
  it("parseSubjectHandles carries the subject keyword candidates", () => {
    expect(subjects.keywordCandidates?.length).toBeGreaterThan(0);
  });

  it("own names first (English, Hindi, aliases), then the keywords inside the handle; each once", () => {
    expect(directoryHandleNames(row("BundiManual", "Bundi Updates", "बूंदी अपडेट्स", ["bundi updates", "बूंदी"]), ctx)).toEqual(["Bundi Updates", "बूंदी अपडेट्स", "बूंदी", "Bundi", "बूँदी"]);
  });

  it("a handle naming nothing still has its own names", () => {
    expect(directoryHandleNames(row("rm_writes", "Ramesh Meena", "रमेश मीणा", ["रमेश मीणा जी"]), ctx)).toEqual(["Ramesh Meena", "रमेश मीणा", "रमेश मीणा जी"]);
  });

  it("drops names under 3 letters", () => {
    expect(directoryHandleNames(row("rm_writes", "RM", null, ["रम"]), ctx)).toEqual([]);
  });

  it("withholds every name of an official's, a party's, a file handle or a lookalike", () => {
    for (const h of ["SPTonkCity", "BJP4Tonk", "jhalawarpolice", "JhalawarPolic"]) {
      expect(directoryHandleNames(row(h, "Tonk", "टोंक", ["Tonk"]), ctx), h).toEqual([]);
    }
  });

  it("caps the names at MAX_HANDLE_KEYWORDS", () => {
    const many = Array.from({ length: 40 }, (_, i) => `Name Number ${i}`);
    expect(directoryHandleNames(row("rm_writes", "Ramesh Meena", null, many), ctx)).toHaveLength(MAX_HANDLE_KEYWORDS);
  });
});

describe("Settings handles in pickHandles", () => {
  const desk = directoryHandleRules(
    [{ handle: "@KotaNewsDesk", entityName: "Kota", aliases: ["Kota", "कोटा"] }],
    [
      row("BundiManual", "Bundi", null, ["Bundi", "बूंदी"]),
      row("rm_writes", "Ramesh Meena", "रमेश मीणा", ["रमेश मीणा जी"]),
      row("SPTonkCity", "Tonk", "टोंक", ["Tonk"]),
    ],
    ctx,
  );
  const handles = (headline: string, points: string[] = []) =>
    pickHandles({ headline, points, district: null, rajasthan: true, leaderPost: false }, rules, { subjects, desk }).map((h) => h.handle);

  it("keeps the desk rows and the safe Settings rows only", () => {
    expect(desk.count).toBe(3);
  });

  it("matches a Settings row on a district keyword and on its Hindi name", () => {
    expect(handles("बूंदी में तेज बारिश")).toContain("BundiManual");
    expect(handles("रमेश मीणा ने किया दौरा")).toContain("rm_writes");
    expect(handles("कोटा में मेला", ["बूंदी में भी असर"])).toEqual(["KotaNewsDesk", "BundiManual"]);
  });

  it("never an official's Settings row", () => {
    expect(handles("टोंक में मेला")).not.toContain("SPTonkCity");
  });
});
