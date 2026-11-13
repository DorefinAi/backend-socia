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
    expect(entry("@officialkharra").verified).toBe(false);
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

// ─── N1, M1–M5 (fix prompt FL/V/N/M/D/C, 13 Nov 2026) ─────────────────────────

const NOTE = "MLA identity confirmed by desk; handle-to-person match not yet confirmed from X profile";
const MLAS = ["@BMacharyaBJP", "@officialkharra"];
type Draft = ReturnType<typeof draft>;
const bare = (h: string) => h.replace(/^@/, "").toLowerCase();
/** Every handle a draft puts on the post, by any route */
const emitted = (d: Draft) => [
  ...lower(d.handles),
  ...d.mentions.map(bare),
  ...d.proposals.filter((p) => p.kind === "handle" && p.layer === "emit").map((p) => bare(p.item)),
];
/** Every handle a draft offers */
const offered = (d: Draft) => [
  ...lower(d.handleSuggestions),
  ...d.proposals.filter((p) => p.kind === "handle" && p.layer === "suggest").map((p) => bare(p.item)),
];
/** One party-handles entry, as the file writes it */
const mlaEntry = (over: Record<string, unknown> = {}) => ({
  handle: "@SomeMlaHandle", name: "Some MLA", party: "bjp", scope: "mla", keywords_hi: ["रामप्रसाद मीणा"], keywords_en: ["Ramprasad Meena"], verified: true, ...over,
});

describe("N1. @BMacharyaBJP: the spellings the desk writes", () => {
  const json = cfg("party-handles.json");
  const e = json.entries.find((x: { handle: string }) => x.handle === "@BMacharyaBJP");

  it("the file carries the desk's spellings and keeps the ones already there", () => {
    expect(e.keywords_hi).toEqual(expect.arrayContaining(["बालमुकुंदाचार्य", "बालमुकुन्दाचार्य", "बालमुकुंद आचार्य", "बाल मुकुंद आचार्य", "बालमुकुन्द आचार्य"]));
    expect(e.keywords_en).toEqual(expect.arrayContaining(["Balmukundachary", "Balmukundacharya", "Balmukund Acharya", "Bal Mukund Acharya"]));
  });

  it.each([
    "विधायक बालमुकुंदाचार्य ने किया निरीक्षण",
    "विधायक बालमुकुन्दाचार्य ने किया निरीक्षण",
    "विधायक बालमुकुंद आचार्य ने किया निरीक्षण",
    "MLA Balmukundachary visits Hawa Mahal ward",
    "MLA Balmukundacharya visits Hawa Mahal ward",
    "MLA Balmukund Acharya visits Hawa Mahal ward",
  ])("%s → offered, never on the post", (head) => {
    expect(pickMlaHandles(head, parties).map((r) => r.handle)).toEqual(["BMacharyaBJP"]);
    const d = draft(head, ["नगर निगम पहुंचे"]);
    expect(offered(d)).toContain("bmacharyabjp");
    expect(emitted(d)).not.toContain("bmacharyabjp");
  });
});

describe("M1. MLA entries in the config: suggest-only whatever the spelling; a bad entry alone is rejected", () => {
  it("both MLA entries load, as suggest-only, and are never among the party's own rules", () => {
    const problems: string[] = [];
    const p = parsePartyHandles(cfg("party-handles.json"), (m) => problems.push(m));
    expect(problems).toEqual([]);
    expect(p.mla!.map((r) => `@${r.handle}`).sort()).toEqual([...MLAS].sort());
    expect(p.mla!.every((r) => r.scope === "mla")).toBe(true);
    expect(p.rules.some((r) => MLAS.includes(`@${r.handle}`))).toBe(false);
  });

  it.each(["MLA", " mla", "Mla ", "  MlA  "])("scope %j is matched as mla: offered, never a party rule, cannot emit", (scope) => {
    const problems: string[] = [];
    const json = cfg("party-handles.json");
    const p = parsePartyHandles({ ...json, entries: [...json.entries, mlaEntry({ scope })] }, (m) => problems.push(m));
    expect(problems).toEqual([]);
    expect(p.mla!.map((r) => r.handle)).toContain("SomeMlaHandle");
    expect(p.rules.map((r) => r.handle)).not.toContain("SomeMlaHandle");
    const head = "भाजपा विधायक रामप्रसाद मीणा ने किया मतदान";
    expect(pickPartyHandles(head, "", p, true).emit?.handle).not.toBe("SomeMlaHandle");
    const d = draft(head, ["गांव में किया मतदान"], { parties: p });
    expect(emitted(d)).not.toContain("somemlahandle");
    expect(offered(d)).toContain("somemlahandle");
  });

  it("an unknown scope rejects that entry loudly, naming it; nothing of it can emit", () => {
    const problems: string[] = [];
    const json = cfg("party-handles.json");
    const p = parsePartyHandles({ ...json, entries: [...json.entries, mlaEntry({ scope: "mla_" })] }, (m) => problems.push(m));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/@SomeMlaHandle/);
    expect(problems[0]).toMatch(/unknown scope "mla_"/);
    expect(problems[0]).toMatch(/rejected/);
    expect([...p.rules, ...p.mla!].map((r) => r.handle)).not.toContain("SomeMlaHandle");
    // Its handle still guards the desk's keywords
    expect(p.handles!.has("somemlahandle")).toBe(true);
  });

  it.each([
    ["scope missing", { scope: undefined }, /"scope" is missing/],
    ["scope not a string", { scope: 7 }, /"scope" is missing/],
    ["party missing", { party: undefined }, /"party" is missing/],
    ["verified not a boolean", { verified: "yes" }, /"verified" must be true or false/],
    ["keywords_hi not a list", { keywords_hi: "रामप्रसाद मीणा" }, /"keywords_hi" must be a list of strings/],
    ["keywords_en with a non-string", { keywords_en: ["Ramprasad Meena", 4] }, /"keywords_en" must be a list of strings/],
    ["no keywords", { keywords_hi: [], keywords_en: [] }, /no keywords/],
    ["name not a string", { name: 5 }, /"name" must be a string/],
    ["handle not a handle", { handle: "not a handle!" }, /is not an X handle/],
  ] as const)("%s: that ONE entry is rejected with a clear error; the rest stay loaded", (_label, over, why) => {
    const problems: string[] = [];
    const json = cfg("party-handles.json");
    const bad: Record<string, unknown> = { ...mlaEntry(), ...over };
    for (const k of Object.keys(bad)) if (bad[k] === undefined) delete bad[k];
    const p = parsePartyHandles({ ...json, entries: [json.entries[0], bad, ...json.entries.slice(1)] }, (m) => problems.push(m));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(why);
    expect(problems[0]).toMatch(/entries\[1\]/);
    expect(problems[0]).toMatch(/rejected/);
    expect([...p.rules, ...p.mla!].map((r) => r.handle)).not.toContain("SomeMlaHandle");
    // Everything else loads as before
    expect(p.rules.map((r) => r.handle)).toEqual(parties.rules.map((r) => r.handle));
    expect(p.mla!.map((r) => r.handle)).toEqual(parties.mla!.map((r) => r.handle));
  });

  it("an MLA can never emit, verified or not, even named in the headline beside its party", () => {
    for (const verified of [true, false]) {
      const json = cfg("party-handles.json");
      const p = parsePartyHandles({ ...json, entries: json.entries.map((e: { scope?: string }) => (e.scope === "mla" ? { ...e, verified } : e)) });
      for (const head of ["भाजपा विधायक झाबर सिंह खर्रा ने किया मतदान", "भाजपा विधायक बालमुकुंदाचार्य ने किया निरीक्षण"]) {
        const picked = pickPartyHandles(head, "", p, true);
        expect(picked.emit?.scope).not.toBe("mla");
        expect(picked.suggest.some((s) => s.scope === "mla")).toBe(false);
        const d = draft(head, ["गांव पहुंचे"], { parties: p });
        for (const h of MLAS) expect(emitted(d), `${head} verified=${verified}`).not.toContain(bare(h));
      }
    }
  });
});

describe("M2. a named MLA is still offered when the story criticises or attacks them", () => {
  it.each([
    ["ग्रामीणों ने विधायक बालमुकुंदाचार्य पर किया हमला", ["गांव में विरोध, पुलिस मौके पर"], "bmacharyabjp"],
    ["कांग्रेस ने विधायक बालमुकुंद आचार्य पर साधा निशाना", ["बयान जारी"], "bmacharyabjp"],
    ["कांग्रेस ने झाबर सिंह खर्रा पर लगाए गंभीर आरोप", ["प्रेस वार्ता में बोले"], "officialkharra"],
    ["झाबर सिंह खर्रा के खिलाफ ग्रामीणों का प्रदर्शन", ["नारेबाजी की"], "officialkharra"],
  ] as const)("%s → the MLA is offered, not emitted", (head, points, h) => {
    const d = draft(head, [...points]);
    expect(offered(d), head).toContain(h);
    expect(emitted(d), head).not.toContain(h);
  });

  it("the MLA as the attacker is offered too", () => {
    const d = draft("विधायक बालमुकुंदाचार्य ने कांग्रेस पर साधा निशाना", ["बयान जारी"]);
    expect(offered(d)).toContain("bmacharyabjp");
    expect(emitted(d)).not.toContain("bmacharyabjp");
  });
});

describe("M3. offered wherever the story is, Rajasthan or not", () => {
  it("खर्रा दिल्ली दौरे पर: a story outside Rajasthan still offers him", () => {
    const d = draft("दिल्ली", ["UDH मंत्री झाबर सिंह खर्रा दिल्ली दौरे पर", "केंद्रीय मंत्री से करेंगे मुलाकात"]);
    // A place line "दिल्ली" (the desk writes the place first): read as outside Rajasthan, the national footer
    expect(d.hashtags).toEqual(["#FirstIndiaNews"]);
    expect(offered(d)).toContain("officialkharra");
    expect(emitted(d)).not.toContain("officialkharra");
  });

  it("a story outside Rajasthan naming Balmukundacharya offers him", () => {
    const d = draft("दिल्ली", ["विधायक बालमुकुंदाचार्य दिल्ली दौरे पर", "केंद्रीय नेताओं से करेंगे मुलाकात"]);
    expect(d.hashtags).toEqual(["#FirstIndiaNews"]);
    expect(offered(d)).toContain("bmacharyabjp");
    expect(emitted(d)).not.toContain("bmacharyabjp");
  });
});

describe("M4. both MLA entries are unverified, and still load and are offered", () => {
  const json = cfg("party-handles.json");
  it.each(MLAS)("%s: verified false, with the desk's note", (h) => {
    const e = json.entries.find((x: { handle: string }) => x.handle === h);
    expect(e.verified).toBe(false);
    expect(e.note).toContain(NOTE);
    expect(parties.mla!.map((r) => `@${r.handle}`)).toContain(h);
  });
});

describe("M5. named → suggested; not named → nothing; never emitted; out of state → suggested", () => {
  it("named → suggested (the suggest layer of the decision log), never emitted", () => {
    for (const [head, h] of [["UDH मंत्री झाबर सिंह खर्रा ने किया मतदान", "officialkharra"], ["विधायक बालमुकुंदाचार्य पहुंचे नगर निगम", "bmacharyabjp"]] as const) {
      const d = draft(head, ["औचक निरीक्षण"]);
      expect(offered(d), head).toContain(h);
      expect(d.proposals.find((p) => bare(p.item) === h)?.layer, head).toBe("suggest");
      expect(emitted(d), head).not.toContain(h);
    }
  });

  it("not named → nothing", () => {
    for (const head of ["नगर निगम में औचक निरीक्षण", "भाजपा ने किया प्रदर्शन", "खर्रा गांव में सड़क हादसा", "आचार्य ने दिया प्रवचन"]) {
      expect(pickMlaHandles(head, parties), head).toEqual([]);
      const d = draft(head, ["पुलिस मौके पर"]);
      for (const h of MLAS) {
        expect(offered(d), head).not.toContain(bare(h));
        expect(emitted(d), head).not.toContain(bare(h));
      }
    }
  });

  it("the out-of-state story → suggested", () => {
    const d = draft("दिल्ली", ["UDH मंत्री झाबर सिंह खर्रा दिल्ली दौरे पर", "केंद्रीय मंत्री से करेंगे मुलाकात"]);
    expect(offered(d)).toContain("officialkharra");
    expect(emitted(d)).not.toContain("officialkharra");
  });
});
