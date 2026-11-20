// Changes #3 step 5 (Q5, Q6, check 4): the Extracted sheet's hashtags that the desk used on 3+ posts, as suggest-only
// rules in campaigns.json. The analysis that chose them (and lists every tag left out) is
// C:\vartmaan\code\testing\sbs\c3\hashtags.ts; this pins its result.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, parseDistricts, parseHandleRules, parsePlacesData, parseSuggestRules, suggestTags, tagPlace,
} from "../src";
import { DAY_FLOORS, dayExports, readExport } from "./day-replay";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const places = parseDistricts(cfg("districts.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const campaigns = cfg("campaigns.json") as { entries: { tag: string; kind: string; pattern: string; start?: string; end?: string; note?: string }[] };
const suggestRules = parseSuggestRules(campaigns);

const KEYWORDS = ["JaswantYadav", "PMModi", "NarendraModi", "WeatherUpdate", "PremBhandari", "AQI", "RashtriyaSwayamsevakSangh", "IASShikharAgrawal", "SupremeCourt", "JaipurAirport", "RajasthanGovernment", "DharmendraRathore"];
const CAMPAIGNS: Record<string, [string, string]> = {
  RajasthanPanchayatElection: ["2026-10-21", "2026-11-14"],
  GovardhanPuja2026: ["2026-11-10", "2026-11-13"],
  GovardhanPuja: ["2026-11-10", "2026-11-13"],
  BhaiDooj2026: ["2026-11-11", "2026-11-14"],
};
const NEW = [...KEYWORDS, ...Object.keys(CAMPAIGNS)];
const entry = (t: string) => campaigns.entries.find((e) => e.tag === t)!;

describe("Changes #3 step 5: the sheet's hashtags as suggest-only rules", () => {
  it("campaigns.json loads whole, with the 16 new rules beside the 2 it had (and #RCA, #Delhi of 17 Nov, and the 2 election parts of 20 Nov)", () => {
    expect(suggestRules.rules).toHaveLength(22);
    // The 20 Nov election: one tag, three patterns (300 characters each at most), all election campaigns
    expect(suggestRules.rules.filter((r) => r.tag === "RajasthanPanchayatElection2026").map((r) => r.election)).toEqual([true, true, true]);
    for (const t of NEW) expect(entry(t), t).toBeDefined();
  });

  it("12 evergreen keyword rules and 4 campaigns, each window the first and last day of use, end + 3 days", () => {
    for (const t of KEYWORDS) expect(entry(t)).toMatchObject({ kind: "keyword" });
    for (const [t, [start, end]] of Object.entries(CAMPAIGNS)) expect(entry(t)).toMatchObject({ kind: "campaign", start, end });
  });

  it("none is a brand, video, <X>News or place tag (the post logic owns those)", () => {
    for (const t of NEW) {
      expect(t).not.toMatch(/News$|^(RajasthanWithFirstIndia|FirstIndiaNews|FINVideo)$/);
      expect(tagPlace(t, places), t).toBeNull();
    }
  });

  it("whole words only: 'मोदी' offers #PMModi, 'मोदीनगर' does not; Latin aliases in any case", () => {
    const at = new Date("2026-11-12T06:30:00Z");
    expect(suggestTags("प्रधानमंत्री मोदी ने किया उद्घाटन", suggestRules, at)).toContain("PMModi");
    expect(suggestTags("मोदीनगर में हुआ कार्यक्रम", suggestRules, at)).not.toContain("PMModi");
    expect(suggestTags("SUPREME COURT ने सुनाया फैसला", suggestRules, at)).toContain("SupremeCourt");
    expect(suggestTags("सुप्रीम कोर्ट ने सुनाया फैसला", suggestRules, at)).toContain("SupremeCourt");
  });

  it("a campaign is offered inside its window only", () => {
    const text = "Govardhan Puja 2026: मंदिरों में अन्नकूट";
    expect(suggestTags(text, suggestRules, new Date("2026-11-11T06:30:00Z"))).toEqual(expect.arrayContaining(["GovardhanPuja2026", "GovardhanPuja"]));
    expect(suggestTags(text, suggestRules, new Date("2026-11-20T06:30:00Z"))).not.toContain("GovardhanPuja");
  });

  it("suggest only: offered with source 'campaign', never on the post", () => {
    const d = composeBreaking(
      { headline: "सुप्रीम कोर्ट ने सुनाया अहम फैसला", points: ["याचिका पर हुई सुनवाई, प्रधानमंत्री मोदी का जिक्र"], district: "Jaipur", town: null, rajasthan: true, leaderPost: false },
      rules, book, { suggestRules, at: new Date("2026-11-12T06:30:00Z") },
    );
    expect(d.hashtagSuggestions).toEqual(expect.arrayContaining(["#SupremeCourt", "#PMModi"]));
    expect(d.hashtagSuggestionItems.filter((t) => ["#SupremeCourt", "#PMModi"].includes(t.tag)).every((t) => t.source === "campaign")).toBe(true);
    expect(d.bodyText).not.toMatch(/#SupremeCourt|#PMModi/);
    expect(d.hashtags.join(" ")).not.toMatch(/SupremeCourt|PMModi/);
    expect(d.proposals.some((p) => p.layer === "emit" && /SupremeCourt|PMModi/.test(p.item))).toBe(false);
  });

  // Check 4, re-run: each new rule at 50% precision or more on the 8 days (skipped without the exports)
  const exportsHere = dayExports().every((e) => e.present);
  (exportsHere ? it : it.skip)("check 4: every new rule is at 50% precision or more on the 2,704 posts", () => {
    const HASHTAG = /#([A-Za-z0-9_\u0900-\u0963\u0966-\u097F]+)/gu;
    const posts = dayExports().flatMap(({ day, path }) => readExport(path).map((text) => ({
      date: DAY_FLOORS[day].date,
      tags: new Set([...text.matchAll(HASHTAG)].map((m) => m[1]!.toLowerCase())),
      copy: text.replace(/https?:\/\/\S+/g, " ").replace(HASHTAG, " ").replace(/@\w+/g, " ").normalize("NFC"),
    })));
    expect(posts).toHaveLength(2704);
    for (const t of NEW) {
      const one = parseSuggestRules({ entries: [entry(t)] });
      let fires = 0;
      let hits = 0;
      for (const p of posts) {
        if (suggestTags(p.copy, one, new Date(`${p.date}T06:30:00Z`)).length) {
          fires++;
          if (p.tags.has(t.toLowerCase())) hits++;
        }
      }
      expect(fires, t).toBeGreaterThan(0);
      expect(hits / fires, t).toBeGreaterThanOrEqual(0.5);
    }
  });
});
