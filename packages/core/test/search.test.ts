import { describe, expect, it } from "vitest";
import { GLOSSARY, SEARCH_GLOSSARY, SEARCH_MAX_WORDS, SNIPPET_CHARS, SNIPPET_SCAN_CHARS, wholeWordPattern, expandQuery, fieldMatches, fold, formMatch, phoneticKey, searchField, searchPattern, searchSnippet, type SearchWord } from "../src";

const word = (q: string) => expandQuery(q).words[0]!;

describe("phoneticKey", () => {
  it("Roman Hindi meets Hindi: hadsa / haadsa ↔ हादसा", () => {
    expect(phoneticKey("hadsa")).toBe(phoneticKey("हादसा"));
    expect(phoneticKey("haadsa")).toBe(phoneticKey("हादसा"));
    // An inflected form still starts with the key (the word-final a is dropped)
    expect(phoneticKey("हादसे").startsWith(phoneticKey("hadsa"))).toBe(true);
  });

  it("jaipur / jaypur / JAIPUR ↔ जयपुर", () => {
    for (const q of ["jaipur", "jaypur", "JAIPUR", "Jaipur"]) expect(phoneticKey(q)).toBe(phoneticKey("जयपुर"));
  });

  it("baadh ↔ बाढ़, with or without the nukta", () => {
    expect(phoneticKey("baadh")).toBe(phoneticKey("बाढ़"));
    expect(phoneticKey("baadh")).toBe(phoneticKey("बाढ"));
  });

  it("squeezes the usual spelling variants", () => {
    expect(phoneticKey("phool")).toBe(phoneticKey("fool"));
    expect(phoneticKey("sheetal")).toBe(phoneticKey("shital"));
    expect(phoneticKey("wardh")).toBe(phoneticKey("vardh"));
    expect(phoneticKey("pulis")).toBe(phoneticKey("पुलिस"));
  });

  it("keeps words apart, drops punctuation, and is empty for nothing", () => {
    expect(phoneticKey("जयपुर: हादसा!")).toBe("jaipur hads");
    expect(phoneticKey("  —  ")).toBe("");
  });
});

describe("expandQuery", () => {
  it("accident (and accidents) brings in दुर्घटना and हादसा", () => {
    for (const q of ["accident", "Accidents"]) {
      const w = word(q);
      expect(w.texts).toEqual(expect.arrayContaining(["दुर्घटना", "हादसा"]));
      expect(w.keys).toContain(phoneticKey("हादसा"));
      expect(w.expanded).toEqual(expect.arrayContaining(["दुर्घटना", "हादसा"]));
    }
    expect(word("injuries").texts).toContain("घायल");
    expect(word("arrested").texts).toContain("गिरफ्तार");
  });

  it("the typed word comes first in texts and keys", () => {
    const w = word("Flood");
    expect(w.raw).toBe("flood");
    expect(w.texts[0]).toBe("flood");
    expect(w.keys[0]).toBe(phoneticKey("flood"));
    expect(w.texts).toContain(fold("बाढ़"));
    expect(w.expanded).toEqual(expect.arrayContaining(["बाढ़"]));
  });

  it("a Roman spelling of a glossary word brings in its Hindi form: hadsa → हादसा, baadh → बाढ़", () => {
    expect(word("hadsa").texts).toContain("हादसा");
    expect(word("haadsa").expanded).toEqual(expect.arrayContaining(["हादसा"]));
    expect(word("baadh").expanded).toEqual(expect.arrayContaining(["बाढ़"]));
  });

  it("a district by any name: jaipur / jaypur / जयपुर, banswara ↔ बांसवाड़ा / बांसवाडा", () => {
    for (const q of ["jaipur", "jaypur", "JAIPUR"]) expect(word(q).texts).toContain("जयपुर");
    expect(word("जयपुर").texts).toContain("jaipur");
    expect(word("जयपुर").expanded).toEqual(["Jaipur"]);
    const b = word("banswara");
    // Both Hindi spellings fold to one form, so one text matches either in a story
    expect(b.texts).toContain(fold("बांसवाड़ा"));
    expect(fold("बांसवाड़ा")).toBe(fold("बांसवाडा"));
    expect(word("बांसवाडा").texts).toContain("banswara");
  });

  it("a mixed query: jaipur हादसा is two words, both needed", () => {
    const { words } = expandQuery("jaipur हादसा");
    expect(words.map((w) => w.raw)).toEqual(["jaipur", "हादसा"]);
    expect(words[0]!.texts).toContain("जयपुर");
    expect(words[1]!.texts[0]).toBe("हादसा");
    expect(words[1]!.keys[0]).toBe(phoneticKey("hadsa"));
  });

  it("ignores one-letter words, repeats and punctuation, and stops at 8 words", () => {
    expect(expandQuery("a जयपुर, जयपुर!").words.map((w) => w.raw)).toEqual(["जयपुर"]);
    expect(expandQuery("").words).toEqual([]);
    expect(expandQuery("— !").words).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    expect(expandQuery(many).words).toHaveLength(SEARCH_MAX_WORDS);
  });

  it("nothing expands for a word the glossary and districts do not know", () => {
    expect(word("xyzzy")).toEqual({ raw: "xyzzy", typed: "xyzzy", variants: [], texts: ["xyzzy"], keys: ["xyjy"], expanded: [] });
  });
});

describe("GLOSSARY", () => {
  it("is the vetted list plus our own words it lacks, each with Hindi forms", () => {
    expect(SEARCH_GLOSSARY.length).toBe(604);
    for (const e of SEARCH_GLOSSARY) for (const en of e.en) expect(GLOSSARY[en.toLowerCase()], en).toBe(e.hi);
    for (const k of ["accident", "flood", "rain", "police", "murder", "fire", "election", "minister", "court", "hospital", "school", "farmer", "water", "road", "death", "died", "arrest", "protest", "theft", "government", "cm"]) {
      expect(GLOSSARY[k]?.length, k).toBeGreaterThan(0);
    }
    for (const [k, forms] of Object.entries(GLOSSARY)) for (const f of forms) expect(f, `${k}: ${f}`).toMatch(/[ऀ-ॿ]/);
  });

  it("nukta and plain spellings fold the same (ज़मानत = जमानत)", () => {
    expect(fold("ज़मानत")).toBe(fold("जमानत"));
    expect(word("bail").texts).toContain(fold("जमानत"));
  });

  it("a typed Roman spelling from the glossary brings in its Hindi forms", () => {
    const roman = SEARCH_GLOSSARY.find((e) => e.roman.includes("thana"));
    expect(roman).toBeDefined();
    expect(word("thana").texts).toEqual(expect.arrayContaining(roman!.hi.map(fold)));
  });
});

describe("formMatch / searchPattern / searchField", () => {
  it("typed words: inside a word from 4 characters, else at a word's start", () => {
    expect(searchField("jaipur hads")).toBe(" jaipur hads ");
    expect(searchField("")).toBe("");
    expect(formMatch("hads", true)).toBe("substring");
    expect(searchPattern("hads", true)).toBe("%hads%");
    expect(searchPattern("cm", true)).toBe("% cm%");
    expect(searchPattern("आग", true)).toBe("% आग%");
  });

  it("expanded forms: at a word's start, or a whole word up to 3 characters", () => {
    expect(searchPattern("हादस", false)).toBe("% हादस%");
    expect(searchPattern("पुल", false)).toBe("% पुल %");
    expect(searchPattern("कार", false)).toBe("% कार %");
    expect(searchPattern("cm", false)).toBe("% cm %");
    expect(searchPattern("pul", false)).toBe("% pul %");
  });

  it("escapes LIKE wildcards", () => {
    // 50%_off\  →  %50\%\_off\\%
    expect(searchPattern("50%_off\\", true)).toBe(String.raw`%50\%\_off\\%`);
  });
});

/** Whether the query's words all match a story text, by the same rules as the SQL (searchStories) */
function storyMatches(q: string, story: string): boolean {
  const text = searchField(fold(story));
  const key = searchField(phoneticKey(story));
  return expandQuery(q).words.every((w: SearchWord) =>
    w.texts.some((t, i) => fieldMatches(text, t, i === 0)) || w.keys.some((k, i) => fieldMatches(key, k, i === 0)),
  );
}

describe("no substring noise from short glossary forms", () => {
  it("bridge does not match a story that only mentions पुलिस", () => {
    expect(word("bridge").texts).toContain("पुल");
    expect(storyMatches("bridge", "पुलिस ने आरोपी को गिरफ्तार किया")).toBe(false);
    expect(storyMatches("bridge", "नदी पर बना पुल टूटा")).toBe(true);
  });

  it("car does not match सरकार", () => {
    expect(word("car").texts).toContain("कार");
    expect(storyMatches("car", "राज्य सरकार ने नई योजना शुरू की")).toBe(false);
    expect(storyMatches("car", "कार और ट्रक की भिड़ंत")).toBe(true);
  });

  it("vote does not match मतदान through मत; accident still matches हादसे", () => {
    expect(storyMatches("accident", "सड़क हादसे में दो की मौत")).toBe(true);
    expect(storyMatches("accident", "भीषण दुर्घटना")).toBe(true);
    expect(storyMatches("accident", "राज्य सरकार की बैठक")).toBe(false);
    expect(word("accident").texts).toContain("हादसे");
  });

  it("what was typed matches inside a word from 4 characters (jaipur in jaipurvasi)", () => {
    expect(storyMatches("jaipur", "jaipurvasi")).toBe(true);
    expect(storyMatches("जयपुर", "जयपुरवासियों ने")).toBe(true);
  });
});

describe("searchSnippet", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `शब्द${i}`).join(" ");

  it("is the body's start when nothing matches, and null for no body", () => {
    expect(searchSnippet(null, expandQuery("jaipur").words)).toBeNull();
    expect(searchSnippet("  ", expandQuery("jaipur").words)).toBeNull();
    expect(searchSnippet("छोटी\nखबर", expandQuery("xyz").words)).toBe("छोटी खबर");
    const s = searchSnippet(long(60), expandQuery("xyz").words)!;
    expect(s.startsWith("शब्द0 ")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(SNIPPET_CHARS + 1);
  });

  it("centres on the first word matched by text, key or glossary", () => {
    const body = `${long(30)} कल रात हुए हादसे में दो लोगों की मौत हो गई। ${long(30)}`;
    for (const q of ["hadsa", "accident", "हादसा"]) {
      const s = searchSnippet(body, expandQuery(q).words)!;
      expect(s, q).toContain("हादसे");
      expect(s.startsWith("…")).toBe(true);
      expect(s.endsWith("…")).toBe(true);
      expect(s.length).toBeLessThanOrEqual(SNIPPET_CHARS + 2);
    }
  });
});

describe("inflections and phrases", () => {
  it("only the ा ↔ े ending, never a bare stem (वर्षा rain is not वर्ष year)", () => {
    const rain = word("rain");
    expect(rain.texts).not.toContain("वर्ष");
    expect(rain.texts).toContain("वर्षा");
    expect(word("हादसा").variants).toEqual(["हादसे"]);
    expect(word("जयपुर").variants).toEqual([]);
  });

  it("consecutive words that make a glossary phrase are one word: paper leak", () => {
    const { words } = expandQuery("paper leak jaipur");
    expect(words.map((w) => w.raw)).toEqual(["paper leak", "jaipur"]);
    expect(words[0]!.texts).toContain("पेपर लीक");
  });
});

describe("review fixes", () => {
  it("filler words go, unless the query is only filler; typed Hindi words stay", () => {
    expect(expandQuery("accident in jaipur").words.map((w) => w.raw)).toEqual(["accident", "jaipur"]);
    expect(expandQuery("accident of truck").words.map((w) => w.raw)).toEqual(["accident", "truck"]);
    expect(expandQuery("jaipur me hadsa").words.map((w) => w.raw)).toEqual(["jaipur", "hadsa"]);
    expect(expandQuery("of").words.map((w) => w.raw)).toEqual(["of"]);
    expect(expandQuery("जयपुर में हादसा").words.map((w) => w.raw)).toEqual(["जयपुर", "में", "हादसा"]);
  });

  it("whole-word patterns, whatever the length", () => {
    expect(wholeWordPattern("पुल")).toBe("% पुल %");
    expect(wholeWordPattern("हादसा")).toBe("% हादसा %");
    expect(wholeWordPattern("a_b")).toBe(String.raw`% a\_b %`);
  });

  it("never stores a NUL", () => {
    expect(searchField("a\u0000b")).toBe(" ab ");
    expect(searchField(fold("जयपुर\u0000हादसा"))).toBe(" जयपुर हादसा ");
  });

  it("a two-word key must meet both words: the snippet centres on सड़क हादसे, not an earlier lone सड़क", () => {
    const filler = Array.from({ length: 25 }, (_, i) => `शब्द${i}`).join(" ");
    const body = `सड़क पर जाम लगा। ${filler} सड़क हादसे में दो की मौत हो गई। ${filler}`;
    const s = searchSnippet(body, expandQuery("accident").words)!;
    expect(s).toContain("सड़क हादसे");
    expect(s).not.toContain("जाम");
  });

  it("looks for a match only in the first SNIPPET_SCAN_CHARS of a body", () => {
    const body = `${"क ".repeat(SNIPPET_SCAN_CHARS)}हादसा`;
    expect(searchSnippet(body, expandQuery("हादसा").words)!.startsWith("क क")).toBe(true);
  });
});
