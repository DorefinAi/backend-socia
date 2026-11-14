// Reporter directory changes v2 (13 Nov 2026, from the 12 Nov data): R1, R2, R4, R6 and the R8 tests.
//   R1  @svoruganti1466 is the Chief Secretary, not a reporter: its file-name token is an unknown token
//   R2  every directory entry has a handle_type; the prior offers institution handles only
//   R4  a person or office the copy names is shown above the prior
//   R6  observed court beats (display only: no court-story rule reads them)
// R3's table is test 5 in reporter-prior.test.ts; R5's recency weights are tested in packages/db.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DataFileRejected, HANDLE_TYPES, PlaceBook, classify, isCourtStory, SUGGESTION_TIERS, composeBreaking, fileTags, handleTypeProblem, mergeHandleTypes, parseBeatHandles, parseBreaking,
  parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, pickReporter, rankHandleSuggestions,
  reporterPrior, resolveReporterStatus, slotFromTags, suggestionTier, type BreakingDraft, type HandlePick, type HandleType, type ReporterRules,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
const types = mergeHandleTypes(rules.types, subjects.types, parties.types, reporters.types);
const AT = new Date("2026-11-13T08:00:00Z");

const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;
function draft(name: string, lines: string[], roster: ReporterRules = reporters): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters: roster, parties, beats, at: AT },
  );
}
const handlesOf = (d: BreakingDraft) => [...d.handles, ...d.handleSuggestions].map((h) => h.handle.toLowerCase());
const fromPrior = (d: BreakingDraft) => d.handleSuggestions.filter((h) => h.reason === "prior").map((h) => h.handle);

// ─── R2: handle_type on every directory entry ────────────────────────────────

describe("R2: every directory entry carries a valid handle_type", () => {
  const files: [string, (j: Record<string, unknown>) => { handle: string; handle_type?: unknown }[]][] = [
    ["district-handles.json", (j) => [...(j.state as never[]), ...Object.entries(j.districts as Record<string, never[]>).filter(([k]) => !k.startsWith("_")).flatMap(([, v]) => v)]],
    ["subject-handles.json", (j) => j.entries as never[]],
    ["party-handles.json", (j) => j.entries as never[]],
    ["reporter-handles.json", (j) => j.entries as never[]],
  ];
  it.each(files)("%s: every entry", (file, entries) => {
    const list = entries(cfg(file));
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) expect(handleTypeProblem(e.handle_type), `${file} ${e.handle}`).toBeNull();
  });

  it("is derived from what the files already say", () => {
    const t = (h: string) => types.get(h.toLowerCase());
    // Institutions: the state government, the parties, departments
    for (const h of ["RajGovOfficial", "INCRajasthan", "BJP4Rajasthan", "INCIndia", "NSUIRajasthan", "rajeduofficial", "jdajaipur", "RajCMO", "PoliceRajasthan"]) expect(t(h), h).toBe("institution");
    // People: the CM, the Chief Secretary, ministers, MLAs, reporters
    for (const h of ["BhajanlalBjp", "svoruganti1466", "KumariDiya", "officialkharra", "BMacharyaBJP", "rituraj9999", "satyatv99_news", "bhanwar_83"]) expect(t(h), h).toBe("person");
    // District accounts: every district police and collector, and the commissionerates in subject-handles.json
    for (const h of ["jaipur_police", "KotaPolice", "DcDmJaipur", "CP_Jodhpur"]) expect(t(h), h).toBe("district");
    for (const d of Object.values(rules.districts)) for (const h of [...d.police, ...d.collector]) expect(t(h), h).toBe("district");
    // Every handle the directory carries has a type
    for (const h of directory) expect(types.has(h), h).toBe(true);
  });

  it("two files disagreeing: the more restrictive type wins (it can only take a handle OUT of the prior)", () => {
    const a = new Map<string, HandleType>([["x", "institution"], ["y", "person"], ["z", "institution"]]);
    const b = new Map<string, HandleType>([["X", "district"], ["y", "institution"], ["@w", "institution"]]);
    expect(Object.fromEntries(mergeHandleTypes(a, b, null, undefined))).toEqual({ x: "district", y: "person", z: "institution", w: "institution" });
    expect(HANDLE_TYPES).toEqual(["institution", "person", "district"]);
  });
});

describe("R2: the loader check — a bad handle_type rejects that one entry, with a clear error, and the rest load", () => {
  const BAD: [string, unknown][] = [["missing", undefined], ["unknown value", "organisation"], ["wrong case", "Institution"], ["not a string", 1]];

  it.each(BAD)("district-handles.json, handle_type %s", (_name, bad) => {
    const problems: string[] = [];
    const r = parseHandleRules({
      version: 1,
      state: [{ handle: "@StateGovX", handle_type: bad, role: "govt", verified: true }, { handle: "@StateCmX", handle_type: "person", role: "cm", verified: true }],
      districts: { Kota: [{ handle: "@KotaPolX", handle_type: bad, role: "police", verified: true }, { handle: "@KotaDmX", handle_type: "district", role: "collector", verified: true }] },
    }, (m) => problems.push(m));
    expect(r.state.government).toEqual([]);
    expect(r.state.cm).toEqual(["StateCmX"]);
    expect(r.districts.kota).toEqual({ police: [], collector: ["KotaDmX"] });
    // Rejected, yet still guarded: a reporter's suggestions never bring it
    expect(r.bound!.has("kotapolx")).toBe(true);
    expect(r.all!.has("stategovx")).toBe(true);
    expect(r.types!.has("kotapolx")).toBe(false);
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toMatch(/state\[0\] \(@StateGovX\): "handle_type" .*entry rejected/);
    expect(problems.join(" ")).toMatch(/districts\.Kota\[0\] \(@KotaPolX\): "handle_type"/);
  });

  it.each(BAD)("subject-handles.json, handle_type %s", (_name, bad) => {
    const problems: string[] = [];
    const s = parseSubjectHandles({
      version: 1,
      entries: [
        { handle: "@BadTypeX", handle_type: bad, kind: "person", names_hi: ["फलां सिंह"], verified: true },
        { handle: "@GoodTypeX", handle_type: "person", kind: "person", names_hi: ["अमुक सिंह"], verified: true },
      ],
    }, (m) => problems.push(m));
    expect(s.count).toBe(1);
    expect(s.gazetteer.find("अमुक सिंह ने कहा").map((m) => m.entry.data.handle)).toEqual(["GoodTypeX"]);
    expect(s.gazetteer.find("फलां सिंह ने कहा")).toEqual([]);
    expect(s.handles!.has("badtypex")).toBe(true);
    expect(problems.join(" ")).toMatch(/entries\[0\] \(@BadTypeX\): "handle_type" .*entry rejected/);
  });

  it.each(BAD)("party-handles.json, handle_type %s", (_name, bad) => {
    const problems: string[] = [];
    const p = parsePartyHandles({
      version: 1,
      entries: [
        { handle: "@BadPartyX", handle_type: bad, party: "bjp", scope: "state", keywords_en: ["BJPX"], verified: true },
        { handle: "@GoodPartyX", handle_type: "institution", party: "congress", scope: "state", keywords_en: ["CONGX"], verified: true },
      ],
    }, (m) => problems.push(m));
    expect(p.rules.map((r) => r.handle)).toEqual(["GoodPartyX"]);
    expect(problems.join(" ")).toMatch(/entries\[0\] \(@BadPartyX\): "handle_type" .*entry rejected/);
  });

  it.each(BAD)("reporter-handles.json, handle_type %s", (_name, bad) => {
    const problems: string[] = [];
    const r = parseReporterHandles({
      version: 1,
      entries: [
        { handle: "@bad_rep", handle_type: bad, names_en: ["BAD_REP"], verified: true },
        { handle: "@good_rep", handle_type: "person", names_en: ["GOOD_REP"], verified: true },
      ],
    }, (m) => problems.push(m));
    expect(r.byToken.has("BAD_REP")).toBe(false);
    expect(r.byToken.get("GOOD_REP")?.handle).toBe("good_rep");
    expect(r.verifiedHandles!.has("bad_rep")).toBe(false);
    expect(problems.join(" ")).toMatch(/entries\[0\] \(@bad_rep\): "handle_type" .*entry REJECTED/);
  });

  it("the shipped config loads with no handle_type problem", () => {
    const problems: string[] = [];
    parseHandleRules(cfg("district-handles.json"), (m) => problems.push(m));
    parseSubjectHandles(cfg("subject-handles.json"), (m) => problems.push(m));
    parsePartyHandles(cfg("party-handles.json"), (m) => problems.push(m));
    parseReporterHandles(cfg("reporter-handles.json"), (m) => problems.push(m), { directory, bound: rules.bound!, types });
    expect(problems.filter((m) => /handle_type|not an institution/.test(m))).toEqual([]);
  });
});

describe("R2: the prior offers institution handles only", () => {
  const rituraj = reporters.profiles!.get("rituraj9999")!;
  const withPrior = (handles: Record<string, number>) => ({ ...rituraj, prior: { n: 100, handles, hashtags: {}, source: null } });
  const run = (handles: Record<string, number>, over: Partial<Parameters<typeof reporterPrior>[0]> = {}) =>
    reporterPrior({ profile: withPrior(handles), text: "", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types, ...over }, reporters);

  it("a person or district handle never comes from the measured prior, whatever its rate — even with no police guard", () => {
    // districtBound is empty here: it is the handle_type that keeps @jaipur_police and the CM out
    const out = run({ BhajanlalBjp: 0.95, svoruganti1466: 0.9, jaipur_police: 0.9, KotaPolice: 0.9, DcDmJaipur: 0.9, RajGovOfficial: 0.6 });
    expect(out.handles.map((h) => h.handle)).toEqual(["RajGovOfficial"]);
  });

  it("no handle types: no measured handle at all (fail closed), and it says why", () => {
    for (const t of [undefined, null, new Map<string, HandleType>()]) {
      const out = run({ RajGovOfficial: 0.9 }, { types: t });
      expect(out.handles).toEqual([]);
      expect(out.warnings.join(" ")).toMatch(/handle types are missing.*fail closed/);
    }
  });

  it("a seed naming a person or district handle: dropped from the prior at load and reported; the reporter still loads", () => {
    const problems: string[] = [];
    const r = parseReporterHandles({
      version: 1,
      prior_base_rates: { RajGovOfficial: 0.096 },
      entries: [{ handle: "@a_rep", handle_type: "person", names_en: ["A_REP"], verified: true, prior: { n: 60, handles: { RajGovOfficial: 0.5, BhajanlalBjp: 0.7, KotaPolice: 0.4 } } }],
    }, (m) => problems.push(m), { directory, types });
    expect(r.byToken.get("A_REP")?.handle).toBe("a_rep");
    expect(Object.keys(r.profiles!.get("a_rep")!.prior!.handles)).toEqual(["RajGovOfficial"]);
    expect(problems.join(" ")).toMatch(/@BhajanlalBjp is a person handle, not an institution — dropped/);
    expect(problems.join(" ")).toMatch(/@KotaPolice is a district handle, not an institution — dropped/);
  });

  it("R8: Satya on a story tagged #Tonk — no @jaipur_police from the prior", () => {
    // Satya is not a verified roster entry, so in the shipped config nothing is offered for SATYA at all
    const shipped = draft(fileFor("SATYA"), ["#Tonk: टोंक में चोरी की वारदात का खुलासा", "पुलिस ने दो आरोपियों को किया गिरफ्तार"]);
    expect(fromPrior(shipped)).toEqual([]);
    expect(handlesOf(shipped)).not.toContain("jaipur_police");
    // And with Satya verified and his measured district-police rate (0.74 smoothed) in the seed, the prior still
    // offers no Jaipur police on the Tonk story: a reporter's usual district is not the story's
    const satya = parseReporterHandles({
      version: 1,
      prior_base_rates: { jaipur_police: 0.05 },
      entries: [{ handle: "@satyatv99_news", handle_type: "person", name: "Satya", names_en: ["satya"], districts: ["Jaipur"], verified: true, prior: { n: 70, handles: { jaipur_police: 0.9 } } }],
    });
    const d = draft(fileFor("SATYA"), ["#Tonk: टोंक में चोरी की वारदात का खुलासा", "पुलिस ने दो आरोपियों को किया गिरफ्तार"], satya);
    expect(d.bodyText.startsWith("#Tonk")).toBe(true);
    expect(fromPrior(d)).toEqual([]);
    expect(handlesOf(d)).not.toContain("jaipur_police");
    // Directly too, with the police guard switched off: the handle_type alone keeps it out
    const profile = satya.profiles!.get("satyatv99_news")!;
    expect(reporterPrior({ profile, text: "", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types }, satya).handles).toEqual([]);
  });
});

// ─── R4: a subject named in the text ranks above the prior ────────────────────

describe("R4: the display order of handle suggestions", () => {
  it("R8: rituraj, headline naming the Chief Secretary → @svoruganti1466 from the text, ranked above @RajGovOfficial from the prior", () => {
    const d = draft(fileFor("RITURAJ", "JPR3"), ["मुख्य सचिव ने ली अधिकारियों की बैठक", "विभागीय योजनाओं की प्रगति की समीक्षा की"]);
    const order = d.handleSuggestions.map((h) => h.handle);
    const cs = order.indexOf("svoruganti1466");
    const gov = order.indexOf("RajGovOfficial");
    expect(cs).toBeGreaterThanOrEqual(0);
    expect(gov).toBeGreaterThanOrEqual(0);
    expect(cs).toBeLessThan(gov);
    expect(d.handleSuggestions[cs]).toMatchObject({ reason: "office", source: "office_alias.rajasthan_cs" });
    // The prior's institution suggestion stays in the list (the desk adds @RajGovOfficial to 28% of CS stories)
    expect(d.handleSuggestions[gov]).toMatchObject({ reason: "prior", source: "reporter_prior" });
    // Neither is on the post; the proposals keep the same order
    expect(d.mentions).not.toContain("@svoruganti1466");
    expect(d.mentions).not.toContain("@RajGovOfficial");
    const items = d.proposals.filter((p) => p.layer === "suggest" && p.kind === "handle").map((p) => p.item);
    expect(items.indexOf("@svoruganti1466")).toBeLessThan(items.indexOf("@RajGovOfficial"));
  });

  it("orders: person/office the copy names, other text rules, (video slot: empty), declared beat, measured prior — stable within a tier", () => {
    const pick = (handle: string, reason: HandlePick["reason"]): HandlePick =>
      reason === "prior" ? { handle, reason, source: "reporter_prior", score: 0.5, n: 50 } : { handle, reason };
    const list: HandlePick[] = [
      pick("jdajaipur", "beat"), pick("RajGovOfficial", "prior"), pick("jaipur_police", "police"), pick("INCRajasthan", "party"),
      pick("officialkharra", "party"), pick("RajCMO", "office"), pick("BJP4Rajasthan", "prior"), pick("KumariDiya", "subject"), pick("CeoRajasthan", "subject"),
    ];
    expect(rankHandleSuggestions(list, types).map((h) => h.handle)).toEqual([
      "officialkharra", "RajCMO", "KumariDiya", // 1. a person (an MLA, a minister) or an office the copy names, in their own order
      "jaipur_police", "INCRajasthan", "CeoRajasthan", // 2. the other text rules, in their own order
      "jdajaipur", // 4. declared beats (owner, 14 Nov: above the measured prior)
      "RajGovOfficial", "BJP4Rajasthan", // 5. the measured reporter prior
    ]);
    expect(SUGGESTION_TIERS).toEqual(["text_person_office", "text_other", "video_headline_district", "declared_beat", "reporter_prior"]);
    // Slot 3 (headline-suffix district of a video post) does not exist as a rule: nothing is ever put in it
    expect(list.map((h) => suggestionTier(h, types))).not.toContain("video_headline_district");
  });

  it("a video post's '| <Place> News' label still only decides the brand: no district suggestion comes from it", () => {
    const d = draft(fileFor("RITURAJ"), ["सीकर में किसानों का धरना | Sikar News"]);
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    expect(d.handleSuggestions.filter((h) => h.reason === "police" || h.reason === "collector")).toEqual([]);
  });
});

// ─── R1 / R8: VORUGANTI is not a reporter ─────────────────────────────────────

describe("R1 / R8: the file-name token VORUGANTI is an unknown token, never a reporter", () => {
  const name = fileFor("VORUGANTI", "JPR3");
  it("resolves as unknown_token, tags nobody", () => {
    expect(pickReporter("VORUGANTI", reporters)).toEqual({ match: null, unmatchedToken: "VORUGANTI" });
    expect(resolveReporterStatus(name, fileTags(name, book.codes), reporters)).toMatchObject({ status: "unknown_token", reporterToken: "VORUGANTI", reporterHandle: null });
  });
  it("a draft filed as VORUGANTI: no byline, no prior, and the token surfaces as unmatched", () => {
    const d = draft(name, ["मुख्य सचिव ने ली अधिकारियों की बैठक", "विभागीय योजनाओं की प्रगति की समीक्षा की"]);
    expect(d.mentions).not.toContain("@svoruganti1466");
    expect(d.handles.filter((h) => h.reason === "reporter")).toEqual([]);
    expect(fromPrior(d)).toEqual([]);
    expect(d.unmatchedReporter).toBe("VORUGANTI");
  });
  it("@svoruganti1466 is in no reporter entry and no seed", () => {
    expect(reporters.handles!.has("svoruganti1466")).toBe(false);
    for (const p of reporters.profiles!.values()) expect(Object.keys(p.prior?.handles ?? {}).map((h) => h.toLowerCase())).not.toContain("svoruganti1466");
    expect(types.get("svoruganti1466")).toBe("person");
  });
});

// ─── R6: court reporters ─────────────────────────────────────────────────────

describe("R6: @vyaskamalkant and @omsharma8888 cover court, observed", () => {
  it("carries beats ['court'] with beats_source 'observed'", () => {
    for (const h of ["vyaskamalkant", "omsharma8888"]) {
      expect(reporters.profiles!.get(h), h).toMatchObject({ beats: ["court"], beatsSource: "observed" });
    }
  });
  it("display only: an observed beat offers nothing and adds no court-story rule", () => {
    const d = draft(fileFor("KAMALKANT"), ["हाईकोर्ट ने याचिका पर सुनवाई के बाद दिए आदेश", "अगली सुनवाई 20 नवंबर को"]);
    expect(d.handleSuggestions.filter((h) => h.reason === "beat" || h.reason === "prior")).toEqual([]);
    expect(beats.beats.has("court")).toBe(false);
  });
});

// ─── Changes #2 (owner decisions, 14 Nov) ────────────────────────────────────

describe("Decision 1: @Swachh_Jaipur is a district handle — never from the prior or a reporter's desk rule", () => {
  const rituraj = reporters.profiles!.get("rituraj9999")!;
  it("is typed district; @RajCMO and @jdajaipur are institutions (organisations)", () => {
    expect(types.get("swachh_jaipur")).toBe("district");
    expect(types.get("rajcmo")).toBe("institution");
    expect(types.get("jdajaipur")).toBe("institution");
  });
  it("rituraj's prior never produces @Swachh_Jaipur, even at a 0.95 rate and with no police guard", () => {
    const fake = { ...rituraj, prior: { n: 121, handles: { Swachh_Jaipur: 0.95, RajGovOfficial: 0.52 }, hashtags: {}, source: null } };
    const out = reporterPrior({ profile: fake, text: "नगर निगम जयपुर की स्वच्छता", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types }, reporters, beats);
    expect(out.handles.map((h) => h.handle)).toEqual(["RajGovOfficial"]);
    // The shipped seed carries no such handle, and rituraj's drafts never offer it from the prior, a beat or the desk rule
    expect(Object.keys(rituraj.prior!.handles).map((h) => h.toLowerCase())).not.toContain("swachh_jaipur");
    for (const lines of [["नगर निगम की स्वच्छता समीक्षा बैठक", "सफाई व्यवस्था पर निर्देश"], ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"]]) {
      const d = draft(fileFor("RITURAJ"), lines);
      expect(d.handleSuggestions.filter((h) => h.reason === "prior" || h.reason === "beat").map((h) => h.handle.toLowerCase())).not.toContain("swachh_jaipur");
      expect(d.mentions.map((m) => m.toLowerCase())).not.toContain("@swachh_jaipur");
    }
  });
  it("a declared beat may not carry a district handle: the beats file fails at load, and the prior skips it at compose", () => {
    const file = { sanitation: { keywords: "स्वच्छता", handles: ["@Swachh_Jaipur"] } };
    expect(() => parseBeatHandles(file, directory, { types })).toThrow(DataFileRejected);
    expect(() => parseBeatHandles(file, directory, { types })).toThrow(/district handle/);
    // A beats file checked without types still never offers it
    const loose = parseBeatHandles(file, directory);
    const p = { ...rituraj, beats: ["sanitation"], beatsSource: "desk" as const };
    const out = reporterPrior({ profile: p, text: "स्वच्छता अभियान", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types }, reporters, loose);
    expect(out.handles.map((h) => h.handle)).not.toContain("Swachh_Jaipur");
  });
});

describe("Decision 2: a declared beat may offer a person, only when its keywords match; it ranks above the measured prior", () => {
  it("Nirmal with 'पर्यटन' gives @KumariDiya labelled 'declared beat', above the measured @RajGovOfficial", () => {
    const d = draft(fileFor("NIRMAL", "JPR3"), ["पर्यटन विभाग की नई योजना पर बैठक", "प्रदेश में पर्यटकों की संख्या बढ़ाने पर चर्चा"]);
    const diya = d.handleSuggestions.find((h) => h.handle === "KumariDiya");
    expect(diya).toMatchObject({ reason: "beat", source: "beat.tourism" });
    expect(diya!.detail).toMatch(/declared beat/);
    expect(types.get("kumaridiya")).toBe("person");
    const order = d.handleSuggestions.map((h) => h.handle);
    expect(order.indexOf("KumariDiya")).toBeLessThan(order.indexOf("RajGovOfficial"));
    expect(d.handleSuggestions[order.indexOf("RajGovOfficial")]).toMatchObject({ reason: "prior" });
    expect(d.mentions).not.toContain("@KumariDiya");
  });
  it("Nirmal with no tourism word gives nothing from that beat", () => {
    const d = draft(fileFor("NIRMAL", "JPR3"), ["खनन माफिया पर कार्रवाई की तैयारी", "विभाग ने जारी की सूची"]);
    expect(d.handleSuggestions.filter((h) => h.reason === "beat")).toEqual([]);
    expect(handlesOf(d)).not.toContain("kumaridiya");
  });
  it("the measured prior stays institution-only (no person, district, police or collector)", () => {
    for (const p of reporters.profiles!.values()) {
      const out = reporterPrior({ profile: p, text: "", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types }, reporters, beats);
      for (const h of out.handles.filter((x) => x.reason === "prior")) expect(types.get(h.handle.toLowerCase()), `${p.handle} → ${h.handle}`).toBe("institution");
    }
  });
});

// ─── Logic Update v4 B2: the reporter tag on court stories ────────────────────

describe("v4 B2: the reporter's byline is allowed on court stories", () => {
  it("a court story: one of the nine words in the headline or the first two lines after it", () => {
    for (const w of ["हाईकोर्ट", "हाई कोर्ट", "न्यायालय", "अदालत", "कोर्ट", "जस्टिस", "याचिका", "सुनवाई", "जमानत"]) {
      expect(isCourtStory(`मामले में ${w} का फैसला`, []), w).toBe(true);
      expect(isCourtStory("जयपुर में बैठक", [`आज ${w} में`]), `${w} in line 2`).toBe(true);
    }
    expect(isCourtStory("जयपुर में बैठक", ["पहली बात", "दूसरी बात", "कोर्ट में पेशी होगी"])).toBe(false);
    expect(isCourtStory("कोर्टयार्ड में कार्यक्रम", [])).toBe(false);
  });
  it("the judicial class carries every B2 word: 'जस्टिस' now classes a headline as judicial", () => {
    expect(classify({ headline: "जस्टिस शर्मा ने आरोपी की अर्जी पर दिए निर्देश", points: [], leaderPost: false }).cls).toBe("judicial");
  });
  it("@vyaskamalkant on a court headline: the byline goes on the post, and nothing else", () => {
    const d = draft(fileFor("KAMALKANT", "JPR3"), ["हाईकोर्ट ने भर्ती परीक्षा पर याचिका की सुनवाई की", "अगली सुनवाई 20 नवंबर को"]);
    expect(d.mentions).toEqual(["@vyaskamalkant"]);
  });
  it("an incident whose second line is in court: the district police stay, and the reporter joins them", () => {
    const lines = ["जयपुर में चोरी का आरोपी गिरफ्तार", "आरोपी को आज कोर्ट में पेश किया जाएगा", "पुलिस कर रही पूछताछ"];
    const d = draft(fileFor("KAMALKANT", "JPR3"), lines);
    expect(d.cls).toBe("incident");
    expect(d.mentions[0]).toBe("@jaipur_police");
    expect(d.mentions.at(-1)).toBe("@vyaskamalkant");
    // With the court word only in the third line it is not a court story: the police alone, as before
    const later = draft(fileFor("KAMALKANT", "JPR3"), [lines[0]!, "पुलिस कर रही पूछताछ", "दूसरे साथी की तलाश जारी", "आरोपी को आज कोर्ट में पेश किया जाएगा"]);
    expect(later.mentions).toEqual(["@jaipur_police"]);
  });
  it("the reporter still comes from the file name only: no token, or the handle only in the copy, carries no byline", () => {
    const court = ["हाईकोर्ट ने याचिका पर सुनवाई की", "अगली सुनवाई 20 नवंबर को"];
    expect(draft(fileFor(null, "JPR3"), court).mentions).toEqual([]);
    expect(draft(fileFor(null, "JPR3"), [court[0]!, `${court[1]} @vyaskamalkant`]).mentions).not.toContain("@vyaskamalkant");
    expect(draft(fileFor("VORUGANTI", "JPR3"), court).mentions).toEqual([]);
  });
  it("@vyaskamalkant and @omsharma8888 carry the court beat (display only)", () => {
    for (const h of ["vyaskamalkant", "omsharma8888"]) expect(reporters.profiles!.get(h)).toMatchObject({ beats: ["court"], beatsSource: "observed" });
  });
});
