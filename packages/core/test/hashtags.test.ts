// Which hashtags a breaking post carries. The contract is one line long — the footer tag goes on the
// post, every topic rule is offered to the desk instead — and the last block measures it against real
// posts the desk published, because that contract was decided by measurement and is only worth what the
// measurement says.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CATEGORY_SEED_RULES, EMPTY_HANDLE_RULES, PlaceBook, composeBreaking, hashtagGazetteer, parseBreaking, parseHandleRules, parsePlacesData } from "../src";
import { BASELINE, postFormat, replayHashtags, segmentPost } from "./hashtag-replay";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const topics = hashtagGazetteer(
  CATEGORY_SEED_RULES.map((r, i) => ({
    id: `seed${i}`, matchType: "entity" as const, name: r.name, aliases: [...r.aliases], hashtagLatin: r.tag,
    hashtagDevanagari: null, priority: r.priority, negativePhrases: [...(r.negativePhrases ?? [])],
  })),
);
const compose = (text: string, name = "x_breaking.txt") => composeBreaking(parseBreaking(text, name, book), rules, book, { topics });

describe("what goes on the post", () => {
  it("applies the footer tag and nothing else, however many rules match", () => {
    const d = compose("जयपुर\nहत्या के आरोपी को पुलिस ने किया गिरफ्तार\nसड़क हादसे में दो घायल, भारी बारिश जारी");
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    // Three rules matched and all three are offered, not applied
    expect(d.hashtagSuggestions.length).toBeGreaterThan(1);
    expect(d.bodyText).not.toContain("#RajasthanPolice");
  });

  it("uses the national footer outside Rajasthan and offers no Rajasthan-only tag there", () => {
    const d = compose("x\nदिल्ली\nहत्या का आरोपी गिरफ्तार\nपुलिस ने की कार्रवाई");
    expect(d.hashtags).toEqual(["#FirstIndiaNews"]);
    expect(d.hashtagSuggestions.filter((t) => /^#Rajasthan/i.test(t))).toEqual([]);
  });

  it("keeps the district and town in front of the headline, where the desk writes them", () => {
    const d = compose("झालावाड़ के डग से खबर\nबिजली गुल\nबिंदु एक");
    expect(d.bodyText.startsWith("#Jhalawar #डग: ")).toBe(true);
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
  });

  it("offers nothing when the org has no topic rules", () => {
    const d = composeBreaking(parseBreaking("जयपुर\nहत्या का आरोपी गिरफ्तार\nबिंदु", "x_breaking.txt", book), rules, book);
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    expect(d.hashtagSuggestions).toEqual([]);
  });

  it("gives the shorter tag line back to the copy", () => {
    // One tag instead of three leaves room for more of the story, which is the point of the change
    const long = Array.from({ length: 6 }, (_, i) => `सड़क हादसे में ${i} लोग घायल, भारी बारिश के बाद ट्रेन रद्द`).join("\n");
    const d = compose(`जयपुर\nपुलिस ने हत्या के आरोपी को किया गिरफ्तार\n${long}`);
    const withThree = composeBreaking(
      { ...parseBreaking(`जयपुर\nपुलिस ने हत्या के आरोपी को किया गिरफ्तार\n${long}`, "x_breaking.txt", book), town: null },
      rules, book, { topics, limit: 280 - 30 },
    );
    expect(d.bodyText.length).toBeGreaterThan(withThree.bodyText.length);
  });
});

describe("reading a published post back", () => {
  it("splits the leading run, the body and the tag line", () => {
    const s = segmentPost("#Sikar #अजीतगढ़: पंचायत समिति का पहला परिणाम जारी\n\nग्राम पंचायत बुर्जा में सुनीता देवी विजयी\n\n#RajasthanWithFirstIndia #RajasthanPanchayatElection2026\n@1stIndiaNews");
    expect(s.lead).toEqual(["Sikar", "अजीतगढ़"]);
    expect(s.headline).toBe("पंचायत समिति का पहला परिणाम जारी");
    expect(s.points).toEqual(["ग्राम पंचायत बुर्जा में सुनीता देवी विजयी"]);
    expect(s.trail).toEqual(["RajasthanWithFirstIndia", "RajasthanPanchayatElection2026"]);
  });

  it("tells the three post shapes apart", () => {
    expect(postFormat("#Jaipur: कुछ हुआ\n\n#RajasthanWithFirstIndia")).toBe("A");
    expect(postFormat("Govardhan Puja 2026 | Rajasthan News\n\n#FINVideo")).toBe("B");
    expect(postFormat("सड़क पर हादसा\n\n#Jaipur #RajasthanWithFirstIndia")).toBe("C");
    // A news-bulletin colon headline is not a video post
    expect(postFormat("Breaking News: चमोली में भूस्खलन\n\n#FirstIndiaNews")).toBe("C");
  });
});

describe("against the posts the desk really published", () => {
  // 39 real posts of 30 Oct 2026, the format this pipeline composes
  const { posts } = json("./fixtures/published-posts-sample.json") as { posts: { text: string }[] };

  it("is the shape we compose: every fixture post leads with its district", () => {
    expect(posts.length).toBeGreaterThan(30);
    expect(posts.every((p) => postFormat(p.text) === "A")).toBe(true);
  });

  it("puts the right tags on the post, measured against the desk's own", () => {
    const r = replayHashtags(posts, book, topics);
    // Applying the topic rules instead of offering them scored 55.8% here
    expect(r.precision).toBeGreaterThanOrEqual(BASELINE.precision);
    expect(r.exact).toBeGreaterThanOrEqual(BASELINE.exact);
    expect(r.brand.ok / r.brand.of).toBeGreaterThanOrEqual(BASELINE.brand);
  });

  it("puts no tag on a post that the desk did not write, beyond the footer it disagrees about", () => {
    const r = replayHashtags(posts, book, topics);
    // The only tag we can get wrong now is which footer: there is nothing else to be wrong about
    expect(r.wrong.every(([t]) => t === "RajasthanWithFirstIndia" || t === "FirstIndiaNews")).toBe(true);
  });

  it("names what we still do not produce, so the gap stays visible", () => {
    const r = replayHashtags(posts, book, topics);
    // The campaign tag of a polling day is the biggest one, and it needs a dated rule we do not have
    expect(r.missed.length).toBeGreaterThan(0);
  });
});
