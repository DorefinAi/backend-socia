// Srimadhopur (श्रीमाधोपुर) is a town of SIKAR district, not of Sawai Madhopur (user check, 13 Nov 2026). The two
// names share "माधोपुर", so the places file, the gazetteer and the parser must never cross them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaceBook, composeBreaking, inferHeadlineDistrict, parseBreaking, parseHandleRules, parsePlacesData } from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const places = cfg("rajasthan-places.json");
const book = new PlaceBook(parsePlacesData(places));
const rules = parseHandleRules(cfg("district-handles.json"));
const file = (headline: string) => parseBreaking(["x_breaking", headline, "बिंदु एक"].join("\n"), "x_breaking.txt", book);

describe("Srimadhopur is in Sikar", () => {
  it("the places file lists श्रीमाधोपुर under Sikar and nowhere else", () => {
    const holders = (places.districts as { tag: string; towns: { hi: string }[] }[])
      .filter((d) => d.towns.some((t) => t.hi.includes("श्रीमाधोपुर") || t.hi.includes("श्री माधोपुर")))
      .map((d) => d.tag);
    expect(holders).toEqual(["Sikar"]);
    expect(book.lookup("श्रीमाधोपुर")?.districts.map((d) => d.tag)).toEqual(["Sikar"]);
    expect(book.hashtag("#श्रीमाधोपुर")?.districts.map((d) => d.tag)).toEqual(["Sikar"]);
  });

  it("a headline 'श्रीमाधोपुर में …' resolves to Sikar", () => {
    const s = file("श्रीमाधोपुर में सड़क हादसा, दो की मौत");
    expect(s.district).toBe("Sikar");
    expect(book.find("श्रीमाधोपुर में सड़क हादसा").map((m) => m.entry.data.districts.map((d) => d.tag))).toEqual([["Sikar"]]);
    // Not a district name, so it never stands in for one
    expect(inferHeadlineDistrict(book, "श्रीमाधोपुर में सड़क हादसा")).toBeNull();
  });

  it("'श्रीमाधोपुर:' and '#Sikar #श्रीमाधोपुर:' give Sikar and the town; the post tags the Sikar police", () => {
    for (const head of ["श्रीमाधोपुर: सड़क हादसा", "#श्रीमाधोपुर: सड़क हादसा", "#Sikar #श्रीमाधोपुर: सड़क हादसा"]) {
      const s = file(head);
      expect([s.district, s.town], head).toEqual(["Sikar", "श्रीमाधोपुर"]);
      const d = composeBreaking({ ...s, rawHeadline: s.rawHeadline }, rules, book, {});
      expect(d.handles.map((h) => h.handle), head).toEqual(["SikarPolice"]);
    }
  });

  it("सवाई माधोपुर itself still resolves to SawaiMadhopur", () => {
    for (const head of ["सवाई माधोपुर में बाघ दिखा", "सवाईमाधोपुर में बाघ दिखा"]) {
      expect(inferHeadlineDistrict(book, head)?.tag, head).toBe("SawaiMadhopur");
      expect(file(head).district, head).toBe("Sawai Madhopur");
    }
    const s = file("सवाई माधोपुर: सड़क हादसा");
    expect(s.district).toBe("Sawai Madhopur");
    expect(composeBreaking({ ...s, rawHeadline: s.rawHeadline }, rules, book, {}).handles.map((h) => h.handle)).toEqual(["SPsawaimadhopur"]);
  });
});
