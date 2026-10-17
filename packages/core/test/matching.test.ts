import { describe, expect, it } from "vitest";
import { Gazetteer, fold, handleGazetteer, hashtagGazetteer, selectHashtags, suggestMentions } from "../src";

describe("fold", () => {
  it("treats precomposed and decomposed nukta as the same", () => {
    expect(fold("ज़")).toBe(fold("ज़")); // ज़
    expect(fold("ज़िला")).toBe(fold("जिला"));
  });

  it("treats chandrabindu as anusvara", () => {
    expect(fold("माँ")).toBe(fold("मां"));
  });

  it("drops zero-width joiners and punctuation", () => {
    expect(fold("क्‍ष, Jaipur!")).toBe(fold("क्ष jaipur"));
  });
});

describe("Gazetteer", () => {
  const g = new Gazetteer([
    { id: "a", name: "जयपुर", aliases: ["Jaipur"], priority: 1, data: null },
    { id: "b", name: "जयपुर विकास प्राधिकरण", aliases: ["JDA"], priority: 1, data: null },
    { id: "c", name: "कोटा", aliases: [], priority: 1, data: null },
  ]);

  it("matches whole words only", () => {
    expect(g.find("कोटापुर में").map((m) => m.entry.id)).toEqual([]);
    expect(g.find("कोटा में").map((m) => m.entry.id)).toEqual(["c"]);
  });

  it("prefers the longer overlapping name", () => {
    expect(g.find("जयपुर विकास प्राधिकरण ने कहा").map((m) => m.entry.id)).toEqual(["b"]);
  });

  it("finds each entry once", () => {
    expect(g.find("Jaipur और जयपुर").map((m) => m.entry.id)).toEqual(["a"]);
  });

  it("marks a match on the canonical name as exact", () => {
    expect(g.find("Jaipur")[0]?.exact).toBe(false);
    expect(g.find("जयपुर")[0]?.exact).toBe(true);
  });
});

describe("selectHashtags", () => {
  const rules = hashtagGazetteer([
    { id: "1", matchType: "city", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 1 },
    { id: "2", matchType: "city", name: "कोटा", aliases: ["Kota"], hashtagLatin: "Kota", hashtagDevanagari: "कोटा", priority: 9 },
  ]);

  it("emits the canonical tag in the configured script, by priority", () => {
    expect(selectHashtags("जयपुर से कोटा तक", rules, { script: "devanagari", fixed: [], max: 4 })).toEqual(["#कोटा", "#जयपुर"]);
    expect(selectHashtags("Jaipur", rules, { script: "latin", fixed: [], max: 4 })).toEqual(["#Jaipur"]);
  });

  it("caps the total", () => {
    expect(selectHashtags("जयपुर कोटा", rules, { script: "latin", fixed: ["#A", "#B"], max: 3 })).toEqual(["#Kota", "#Jaipur", "#A"]);
  });
});

describe("suggestMentions", () => {
  const handles = handleGazetteer([
    { id: "1", entityName: "भजनलाल शर्मा", aliases: ["Bhajanlal Sharma"], handle: "BhajanlalBjp", priority: 5 },
    { id: "2", entityName: "अशोक गहलोत", aliases: ["गहलोत"], handle: "@ashokgehlot51", priority: 5 },
    { id: "3", entityName: "जयपुर पुलिस", aliases: [], handle: "jaipur_police", priority: 1 },
  ]);

  it("caps at two and ranks exact names first", () => {
    const found = suggestMentions("गहलोत ने भजनलाल शर्मा और जयपुर पुलिस पर कहा", handles);
    expect(found.map((m) => m.handle)).toEqual(["@BhajanlalBjp", "@jaipur_police"]);
  });

  it("normalises the @", () => {
    expect(suggestMentions("अशोक गहलोत", handles)[0]?.handle).toBe("@ashokgehlot51");
  });
});
