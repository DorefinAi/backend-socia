// Handles added in Settings ("manual") or promoted from staging reach the composer (desk fixes 14 Nov, point 7), under
// the handle fixes F1 (14 Nov): a type for every row; only police, collector and admin may match by district; the rest
// only on their own keywords and names, whole words; suggest-only until the desk has posted the handle twice.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_HANDLE_KEYWORDS, SETTINGS_POSTED_USES, directoryHandleDistricts, directoryHandleNames, directoryHandleRules, directoryRowType, parseHandleRules,
  parseSubjectHandles, pickHandlesExplained, settingsHandleType, type DirectoryHandleRow, type SettingsHandleType,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const subjects = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
const ctx = { fileHandles: [...rules.all!, ...subjects.handles!] };
const row = (handle: string, entityName: string, entityNameHi: string | null = null, aliases: string[] = [], type: SettingsHandleType | null = "organisation", postedUses = 0): DirectoryHandleRow =>
  ({ handle, entityName, entityNameHi, aliases, type, postedUses });

const metro = (postedUses = 0) => row("JaipurMetro", "Jaipur Metro Rail", null, ["मेट्रो", "Metro", "जयपुर मेट्रो"], "organisation", postedUses);
const pick = (settings: DirectoryHandleRow[], headline: string, points: string[] = [], district: string | null = null) => {
  const desk = directoryHandleRules([], settings, ctx);
  const r = pickHandlesExplained({ headline, points, district, rajasthan: true, leaderPost: false }, rules, { subjects, desk });
  return { cls: r.cls, handles: r.handles.map((h) => h.handle), suggested: r.suggestions.map((h) => h.handle) };
};

describe("F1: Settings handles, the four owner tests", () => {
  it("F1 test 1: a #Jaipur story with no metro word → no @JaipurMetro", () => {
    for (const story of [pick([metro()], "जयपुर में बारिश से सड़कों पर जलभराव", [], "Jaipur"), pick([metro(5)], "जयपुर में बारिश से सड़कों पर जलभराव", [], "Jaipur")]) {
      expect(story.handles).not.toContain("JaipurMetro");
      expect(story.suggested).not.toContain("JaipurMetro");
    }
  });

  it("F1 test 2: a story containing 'जयपुर मेट्रो' → @JaipurMetro suggested, not emitted", () => {
    const s = pick([metro()], "जयपुर मेट्रो का किराया बढ़ा, यात्रियों में नाराजगी", [], "Jaipur");
    expect(s.handles).not.toContain("JaipurMetro");
    expect(s.suggested).toContain("JaipurMetro");
  });

  it("F1 test 3: after 2 posted uses, the same story → follows the organisation rule (on the post)", () => {
    expect(SETTINGS_POSTED_USES).toBe(2);
    expect(pick([metro(1)], "जयपुर मेट्रो का किराया बढ़ा, यात्रियों में नाराजगी", [], "Jaipur").handles).not.toContain("JaipurMetro");
    const s = pick([metro(2)], "जयपुर मेट्रो का किराया बढ़ा, यात्रियों में नाराजगी", [], "Jaipur");
    expect(s.handles).toContain("JaipurMetro");
    expect(s.suggested).not.toContain("JaipurMetro");
  });
  // F1 test 4 (saving a Settings handle without a type → refused) is an API test: apps/api/test/settings-handles.test.ts
});

describe("F1: what a Settings handle is matched on", () => {
  it("its own names only (English, Hindi, keywords), each once; nothing from inside the handle string", () => {
    expect(directoryHandleNames(row("BundiManual", "Bundi Updates", "बूंदी अपडेट्स", ["bundi updates", "बूंदी"]), ctx)).toEqual(["Bundi Updates", "बूंदी अपडेट्स", "बूंदी"]);
    expect(directoryHandleNames(row("JaipurMetro", "Rail Corp", null, ["मेट्रो"]), ctx)).toEqual(["Rail Corp", "मेट्रो"]);
  });

  it("drops names under 3 letters; caps them at MAX_HANDLE_KEYWORDS", () => {
    expect(directoryHandleNames(row("rm_writes", "RM", null, ["रम"]), ctx)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `Name Number ${i}`);
    expect(directoryHandleNames(row("rm_writes", "Ramesh Meena", null, many), ctx)).toHaveLength(MAX_HANDLE_KEYWORDS);
  });

  it("a data-file handle or a lookalike of one is never matched", () => {
    for (const h of ["jhalawarpolice", "JhalawarPolic"]) {
      expect(directoryHandleNames(row(h, "Tonk", "टोंक", ["Tonk"], "police"), ctx), h).toEqual([]);
      expect(directoryHandleDistricts(row(h, "Tonk", "टोंक", ["Tonk"], "police"), ctx), h).toEqual([]);
    }
  });

  it("only police, collector and admin rows have districts (from the handle or a name that is a district)", () => {
    expect(directoryHandleDistricts(row("JhalawarTraffic", "Traffic Cell", null, ["ट्रैफिक सेल"], "police"), ctx)).toEqual(["jhalawar"]);
    expect(directoryHandleDistricts(row("TrafficCellX", "Traffic Cell", null, ["झालावाड़"], "admin"), ctx)).toEqual(["jhalawar"]);
    for (const t of ["organisation", "person", "party"] as const) expect(directoryHandleDistricts(row("JhalawarTraffic", "Traffic Cell", null, ["झालावाड़"], t), ctx), t).toEqual([]);
  });

  it("an untyped row is an organisation; the six types map to the code's three", () => {
    expect(directoryRowType({ type: null })).toBe("organisation");
    expect(directoryRowType({})).toBe("organisation");
    expect(["police", "collector", "admin", "organisation", "party", "person"].map((t) => settingsHandleType(t as SettingsHandleType)))
      .toEqual(["district", "district", "district", "institution", "institution", "person"]);
  });
});

describe("F1: Settings handles in pickHandles", () => {
  it("an organisation with a district in its handle never matches by district or by that district's name", () => {
    const s = pick([row("BundiManual", "Bundi Fair Desk", null, ["मेला समिति"], "organisation", 9)], "बूंदी में तेज बारिश", [], "Bundi");
    expect([...s.handles, ...s.suggested]).not.toContain("BundiManual");
  });

  it("whole words only: 'मेट्रोपॉलिटन' is not 'मेट्रो'", () => {
    const s = pick([metro(5)], "मेट्रोपॉलिटन मजिस्ट्रेट ने दिया आदेश", [], "Jaipur");
    expect([...s.handles, ...s.suggested]).not.toContain("JaipurMetro");
  });

  it("a person and a party row match on their names; suggest-only until posted twice", () => {
    const person = row("rm_writes", "Ramesh Meena", "रमेश मीणा", [], "person");
    expect(pick([person], "रमेश मीणा ने किया दौरा").suggested).toContain("rm_writes");
    expect(pick([{ ...person, postedUses: 2 }], "रमेश मीणा ने किया दौरा").handles).toContain("rm_writes");
    const party = row("BJP4Bundi", "BJP Bundi", "भाजपा बूंदी", ["बूंदी भाजपा"], "party");
    expect(pick([party], "बूंदी भाजपा की बैठक आज").suggested).toContain("BJP4Bundi");
  });

  it("a police row matches by the stated district: offered, and tagged on an incident once posted twice", () => {
    const police = (n: number) => row("JhalawarTraffic", "Jhalawar Traffic", null, ["ट्रैफिक पुलिस झालावाड़"], "police", n);
    const crash = "झालावाड़ में ट्रक और बाइक की भिड़ंत, युवक की मौत";
    const fresh = pick([police(0)], crash, [], "Jhalawar");
    expect(fresh.cls).toBe("incident");
    expect(fresh.handles).not.toContain("JhalawarTraffic");
    expect(fresh.suggested).toContain("JhalawarTraffic");
    expect(pick([police(2)], crash, [], "Jhalawar").handles).toContain("JhalawarTraffic");
    // Another district: nothing; a non-incident story in its district: offered, never tagged
    expect([...pick([police(2)], "बूंदी में ट्रक और बाइक की भिड़ंत, युवक की मौत", [], "Bundi").handles]).not.toContain("JhalawarTraffic");
    const political = pick([police(2)], "झालावाड़ में मुख्यमंत्री का दौरा, कार्यकर्ताओं में उत्साह", [], "Jhalawar");
    expect(political.handles).not.toContain("JhalawarTraffic");
    expect(political.suggested).toContain("JhalawarTraffic");
  });

  it("a promoted organisation on an incident story is offered, not tagged (the district force stands alone)", () => {
    const s = pick([metro(5)], "जयपुर मेट्रो स्टेशन पर हादसा, युवक घायल", [], "Jaipur");
    expect(s.cls).toBe("incident");
    expect(s.handles).not.toContain("JaipurMetro");
    expect(s.suggested).toContain("JaipurMetro");
  });

  it("desk-added rows keep their rule (tagged on non-exclusive classes)", () => {
    const desk = directoryHandleRules([{ handle: "@KotaNewsDesk", entityName: "Kota", aliases: ["Kota", "कोटा"] }], [], ctx);
    const r = pickHandlesExplained({ headline: "कोटा में मेला", points: [], district: null, rajasthan: true, leaderPost: false }, rules, { subjects, desk });
    expect(r.handles.map((h) => h.handle)).toContain("KotaNewsDesk");
  });
});
