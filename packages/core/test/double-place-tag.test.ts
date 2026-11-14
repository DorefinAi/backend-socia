// Desk fixes 14 Nov, point 6: a headline that already carries its place tag gets no second one in front of it, and a
// suggested hashtag never repeats a tag already on the post.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaceBook, composeBreaking, parseHandleRules, parsePlacesData } from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));

const story = (headline: string, extra: Partial<Parameters<typeof composeBreaking>[0]> = {}) => ({
  headline, points: ["पुलिस ने आरोपी से की लंबी पूछताछ", "परिजनों के बयान भी दर्ज"], district: "Jaipur", town: null,
  rajasthan: true, leaderPost: false, ...extra,
});
const lineOne = (d: { bodyText: string }) => d.bodyText.split("\n")[0];

describe("double place tag", () => {
  it("still adds the district tag when the headline has none", () => {
    expect(lineOne(composeBreaking(story("हत्या के आरोपी से पूछताछ"), rules, book))).toBe("#Jaipur: हत्या के आरोपी से पूछताछ");
  });

  it("adds no '#Jaipur: ' when the headline already starts with #Jaipur (no colon)", () => {
    const d = composeBreaking(story("#Jaipur जयपुर में हत्या के आरोपी से पूछताछ"), rules, book);
    expect(lineOne(d)).toBe("#Jaipur जयपुर में हत्या के आरोपी से पूछताछ");
    expect(d.districtSource).toBeNull();
  });

  it("matches the tag in any case", () => {
    expect(lineOne(composeBreaking(story("#jaipur में हत्या के आरोपी से पूछताछ"), rules, book))).toBe("#jaipur में हत्या के आरोपी से पूछताछ");
  });

  it("adds no '#Jaipur: ' when the headline carries #JaipurNews", () => {
    const d = composeBreaking(story("हत्या के आरोपी से पूछताछ #JaipurNews"), rules, book);
    expect(lineOne(d)).toBe("हत्या के आरोपी से पूछताछ #JaipurNews");
  });

  it("keeps a town tag the headline does not carry", () => {
    const d = composeBreaking(story("#Jaipur हत्या के आरोपी से पूछताछ", { town: "चौमूं" }), rules, book);
    expect(lineOne(d)).toMatch(/^#चौमूं: #Jaipur हत्या/u);
  });

  it("never suggests a tag already in line 1 or in the copy", () => {
    // An inferred district is offered (§2.8); here line 1 already carries it
    const d = composeBreaking(
      story("#Jaipur में हत्या के आरोपी से पूछताछ", { district: "Jaipur", districtFrom: "text" }),
      rules, book,
    );
    expect(d.hashtagSuggestions.map((t) => t.toLowerCase())).not.toContain("#jaipur");
    const news = composeBreaking(
      story("हत्या के आरोपी से पूछताछ #JaipurNews", { district: "Jaipur", districtFrom: "text" }),
      rules, book,
    );
    expect(news.hashtagSuggestions.map((t) => t.toLowerCase())).not.toContain("#jaipur");
  });

  it("still suggests an inferred district the copy does not carry", () => {
    const d = composeBreaking(story("हत्या के आरोपी से पूछताछ", { district: "Jaipur", districtFrom: "text" }), rules, book);
    expect(d.hashtagSuggestions).toContain("#Jaipur");
  });
});
