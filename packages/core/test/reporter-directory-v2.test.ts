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
    for (const h of ["RajGovOfficial", "INCRajasthan", "BJP4Rajasthan", "INCIndia", "NSUIRajasthan", "rajeduofficial", "jdajaipur", "RajCMO"]) expect(t(h), h).toBe("institution");
    // Police forces that are not one district's (P3), and the central armed police forces (D2), 15 Nov 2026
    for (const h of ["PoliceRajasthan", "RajPoliceHelp", "AcbRajasthan", "DelhiPolice", "crpfindia", "BSF_India"]) expect(t(h), h).toBe("police");
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
    expect(HANDLE_TYPES).toEqual(["institution", "person", "district", "police"]);
    // P3: police is at least as strict as district, whichever file says what and in which order
    const p = new Map<string, HandleType>([["acb", "police"], ["kp", "district"], ["x", "police"]]);
    const q = new Map<string, HandleType>([["acb", "institution"], ["kp", "police"], ["x", "person"]]);
    expect(Object.fromEntries(mergeHandleTypes(p, q))).toEqual({ acb: "police", kp: "police", x: "police" });
    expect(Object.fromEntries(mergeHandleTypes(q, p))).toEqual({ acb: "police", kp: "police", x: "police" });
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
    // b9: the headline opens with its district, so #Tonk is the tag line's (never "#Tonk: टोंक में …")
    expect(d.bodyText.startsWith("टोंक में चोरी")).toBe(true);
    expect(d.hashtags).toContain("#Tonk");
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

  it("a video post's '| <Place> News' label still only decides the brand: no district comes from it", () => {
    const d = draft(fileFor("RITURAJ"), ["सीकर में किसानों का धरना | Sikar News"]);
    // b9: the city is rituraj's desk rule, in the tag line (a video post takes no leading tag); nothing from the label
    expect(d.hashtags).toEqual(["#RajasthanWithFirstIndia", "#Jaipur"]);
    expect(d.headingPlace).toMatchObject({ source: "reporter_rule", placement: "trailing" });
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
  it("a declared beat may not carry a district handle: left out alone at load (D1), and the prior skips it at compose", () => {
    const file = { sanitation: { keywords: "स्वच्छता", handles: ["@Swachh_Jaipur", "@rajeduofficial"] } };
    // D1 (15 Nov 2026): that one handle is left out with a warning; the rest of the beat and the file load
    const warned: string[] = [];
    const strict = parseBeatHandles(file, directory, { types, problem: (m) => warned.push(m) });
    expect(strict.beats.get("sanitation")!.handles).toEqual(["rajeduofficial"]);
    expect(warned.join(" ")).toMatch(/@Swachh_Jaipur is a district handle.*left out of this beat \(D1\)/);
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

describe("v4 B2: the reporter's byline is allowed on court stories (as the handle fixes P1/P2 narrowed it)", () => {
  it("a court story: a court word in the headline or the first two lines after it, and no crime word in the story", () => {
    for (const w of ["हाईकोर्ट", "हाई कोर्ट", "High Court", "सुप्रीम कोर्ट", "Supreme Court", "सुनवाई", "याचिका", "न्यायाधीश", "जस्टिस", "Justice"]) {
      expect(isCourtStory(`मामले में ${w} का फैसला`, []), w).toBe(true);
      expect(isCourtStory("जयपुर में बैठक", [`आज ${w} में`]), `${w} in line 2`).toBe(true);
    }
    // No longer court words: a court named without its kind, or bail on its own
    for (const w of ["कोर्ट", "अदालत", "न्यायालय", "जमानत"]) expect(isCourtStory(`मामले में ${w} का फैसला`, []), w).toBe(false);
    expect(isCourtStory("जयपुर में बैठक", ["पहली बात", "दूसरी बात", "हाईकोर्ट में सुनवाई होगी"])).toBe(false);
    expect(isCourtStory("हाईकोर्टयार्ड में कार्यक्रम", [])).toBe(false);
    // A crime word anywhere in the story makes it a crime story
    expect(isCourtStory("हाईकोर्ट में सुनवाई", ["पहली बात", "दूसरी बात", "पुलिस ने पूछताछ की"])).toBe(false);
  });
  it("court words are not a class (the owner's rule as written): the class comes from the story's other words", () => {
    expect(classify({ headline: "जस्टिस शर्मा ने आरोपी की अर्जी पर दिए निर्देश", points: [], leaderPost: false }).cls).toBe("incident");
    expect(classify({ headline: "हाईकोर्ट में याचिका पर सुनवाई", points: [], leaderPost: false }).cls).toBe("other");
    expect(classify({ headline: "हाईकोर्ट ने हत्या के मामले में सुनाई सजा", points: [], leaderPost: false }).cls).toBe("incident");
  });
  it("@vyaskamalkant on a court headline: the byline goes on the post, and nothing else", () => {
    const d = draft(fileFor("KAMALKANT", "JPR3"), ["हाईकोर्ट ने भर्ती परीक्षा पर याचिका की सुनवाई की", "अगली सुनवाई 20 नवंबर को"]);
    expect(d.mentions).toEqual(["@vyaskamalkant"]);
  });
  it("an incident whose second line is in court: the district police stay, and the reporter does NOT join them (crime words)", () => {
    // Was: the reporter joined (v4 B2). The owner's rule (P2): "कोर्ट में पेश" is crime procedure, and any crime word
    // (आरोपी, पुलिस, गिरफ्तार...) makes it a crime story, so no reporter tag.
    const lines = ["जयपुर में चोरी का आरोपी गिरफ्तार", "आरोपी को आज कोर्ट में पेश किया जाएगा", "पुलिस कर रही पूछताछ"];
    // Owner, 20 Nov 2026: our reporter is on every story they file, crime included; the court/crime test (P1/P2) now only
    // decides the class (the district police stay on a crime story), no longer whether the byline goes on.
    const d = draft(fileFor("KAMALKANT", "JPR3"), lines);
    expect(d.cls).toBe("incident");
    expect(d.mentions).toEqual(["@jaipur_police", "@vyaskamalkant"]);
    const later = draft(fileFor("KAMALKANT", "JPR3"), [lines[0]!, "पुलिस कर रही पूछताछ", "दूसरे साथी की तलाश जारी", "आरोपी को आज कोर्ट में पेश किया जाएगा"]);
    expect(later.mentions).toEqual(["@jaipur_police", "@vyaskamalkant"]);
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

// ─── Handle fixes P1/P2 (14 Nov): crime stories caught by the court rule ─────────

describe("P1/P2: the owner's five court/crime sentences (filed by @vyaskamalkant from Jaipur)", () => {
  const kamal = (headline: string, points: string[] = []) => draft(fileFor("KAMALKANT", "JPR3"), [headline, ...points]);

  it("P1P2 test 1: 'आरोपी को कोर्ट में पेश किया' → crime: no reporter tag; police tag kept", () => {
    const d = kamal("जयपुर में चोरी के आरोपी को कोर्ट में पेश किया");
    expect(isCourtStory("जयपुर में चोरी के आरोपी को कोर्ट में पेश किया", [])).toBe(false);
    expect(d.mentions).toContain("@jaipur_police");
    expect(d.mentions).toContain("@vyaskamalkant"); // owner, 20 Nov 2026: the reporter rides on crime too
  });
  it("P1P2 test 2: 'जस्टिस … के घर चोरी, पुलिस ने आरोपी गिरफ्तार किया' → crime: police tag kept (P1)", () => {
    const d = kamal("जस्टिस शर्मा के घर चोरी, पुलिस ने आरोपी गिरफ्तार किया");
    expect(d.cls).toBe("incident");
    expect(d.mentions).toContain("@jaipur_police");
    expect(d.mentions).toContain("@vyaskamalkant"); // owner, 20 Nov 2026: the reporter rides on crime too
  });
  it("P1P2 test 3: 'हाईकोर्ट में याचिका पर सुनवाई' → court: reporter tag allowed", () => {
    expect(isCourtStory("हाईकोर्ट में याचिका पर सुनवाई", [])).toBe(true);
    expect(kamal("हाईकोर्ट में याचिका पर सुनवाई").mentions).toContain("@vyaskamalkant");
  });
  it("P1P2 test 4: 'जमानत याचिका पर हाईकोर्ट में सुनवाई' (no crime words) → court", () => {
    expect(isCourtStory("जमानत याचिका पर हाईकोर्ट में सुनवाई", [])).toBe(true);
    expect(kamal("जमानत याचिका पर हाईकोर्ट में सुनवाई").mentions).toContain("@vyaskamalkant");
  });
  it("P1P2 test 5: 'जमानत पर रिहा आरोपी फिर गिरफ्तार' → crime", () => {
    expect(isCourtStory("जमानत पर रिहा आरोपी फिर गिरफ्तार", [])).toBe(false);
    const d = kamal("जमानत पर रिहा आरोपी फिर गिरफ्तार");
    expect(d.cls).toBe("incident");
    expect(d.mentions).toEqual(["@jaipur_police", "@vyaskamalkant"]); // owner, 20 Nov 2026
  });
  it("court story test: a court story whose other words tag the police keeps them AND gets the reporter", () => {
    const d = kamal("हाईकोर्ट जा रहे वकील की कार की टक्कर, दो घायल");
    expect(isCourtStory("हाईकोर्ट जा रहे वकील की कार की टक्कर, दो घायल", [])).toBe(true);
    expect(d.cls).toBe("incident");
    expect(d.mentions).toEqual(["@jaipur_police", "@vyaskamalkant"]);
  });
  it("court story test: a court story whose other words tag the collector keeps the collector AND gets the reporter", () => {
    const d = kamal("हाईकोर्ट के आदेश पर जिला कलेक्टर ने किया निरीक्षण");
    expect(d.cls).toBe("administration");
    expect(d.mentions).toEqual(["@DcDmJaipur", "@vyaskamalkant"]);
  });
  it("court story test: a court story naming a leader keeps the leader AND gets the reporter", () => {
    const d = kamal("हाईकोर्ट के फैसले पर मुख्यमंत्री भजनलाल शर्मा ने दी प्रतिक्रिया");
    expect(d.mentions[0]).toBe("@BhajanlalBjp");
    expect(d.mentions.at(-1)).toBe("@vyaskamalkant");
  });
  it("a crime word anywhere in the story (not only the first lines) makes it crime: police kept, no court reporter", () => {
    const d = kamal("हाईकोर्ट परिसर के बाहर वकीलों में मारपीट", ["दोनों पक्षों में कहासुनी", "मौके पर भीड़ जुटी", "पुलिस ने दो लोगों को हिरासत में लिया"]);
    expect(d.cls).toBe("incident");
    expect(d.mentions).toEqual(["@jaipur_police", "@vyaskamalkant"]); // owner, 20 Nov 2026
  });
});
});

// ─── Review decisions P3 and P6 (owner, 15 Nov 2026) ─────────────────────────

describe("P3: the police accounts are typed police — the prior never suggests police, collector, admin or district", () => {
  const POLICE = ["PoliceRajasthan", "RajPoliceHelp", "AcbRajasthan", "DelhiPolice", "crpfindia", "BSF_India"];
  const nirmal = reporters.profiles!.get("nirmaltiwaribki")!;
  const seeded = (handles: Record<string, number>) => ({ ...nirmal, prior: { n: 100, handles, hashtags: {}, source: null } });
  const offer = (profile: ReturnType<typeof seeded>, t: ReadonlyMap<string, HandleType> = types) =>
    reporterPrior({ profile, text: "", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types: t }, reporters).handles.map((h) => h.handle);

  it("a reporter given @AcbRajasthan in their seed prior: it is never suggested", () => {
    // At load: dropped from the prior, reported as a police handle; the reporter and the rest of the prior load
    const problems: string[] = [];
    const r = parseReporterHandles({
      version: 1,
      entries: [{ handle: "@a_rep", handle_type: "person", names_en: ["A_REP"], verified: true, prior: { n: 60, handles: { AcbRajasthan: 0.9, RajGovOfficial: 0.5 } } }],
    }, (m) => problems.push(m), { directory, types });
    expect(Object.keys(r.profiles!.get("a_rep")!.prior!.handles)).toEqual(["RajGovOfficial"]);
    expect(problems.join(" ")).toMatch(/@AcbRajasthan is a police handle, not an institution — dropped/);

    // At compose, even from a roster loaded with no type check (the seed still holds it) and with no police guard
    const unchecked = parseReporterHandles({
      version: 1,
      entries: [{ handle: "@a_rep", handle_type: "person", names_en: ["A_REP"], verified: true, prior: { n: 60, handles: { AcbRajasthan: 0.9 } } }],
    });
    expect(Object.keys(unchecked.profiles!.get("a_rep")!.prior!.handles)).toEqual(["AcbRajasthan"]);
    const profile = unchecked.profiles!.get("a_rep")!;
    expect(reporterPrior({ profile, text: "", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types }, unchecked).handles).toEqual([]);
    const arep = parseReporterHandles({
      version: 1,
      entries: [{ handle: "@a_rep", handle_type: "person", names_en: ["AREP"], verified: true, prior: { n: 60, handles: { AcbRajasthan: 0.9 } } }],
    });
    // ...and on a whole draft about an ACB raid filed by that reporter
    const d = draft(fileFor("AREP"), ["एसीबी ने पटवारी को रिश्वत लेते रंगे हाथों पकड़ा", "आरोपी से पूछताछ जारी"], arep);
    // The file name names the seeded reporter (so the prior ran), and still no @AcbRajasthan from it
    expect(d.unmatchedReporter ?? null).toBeNull();
    expect(d.proposals.some((p) => p.source === "reporter_prior")).toBe(false);
    expect(d.handleSuggestions.filter((h) => h.reason === "prior")).toEqual([]);
    // Control: the same reporter with an institution in the seed IS offered it on the same draft
    const control = draft(fileFor("AREP"), ["एसीबी ने पटवारी को रिश्वत लेते रंगे हाथों पकड़ा", "आरोपी से पूछताछ जारी"], parseReporterHandles({
      version: 1,
      entries: [{ handle: "@a_rep", handle_type: "person", names_en: ["AREP"], verified: true, prior: { n: 60, handles: { AcbRajasthan: 0.9, INCRajasthan: 0.9 } } }],
    }));
    expect(control.handleSuggestions.filter((h) => h.reason === "prior").map((h) => h.handle)).toEqual(["INCRajasthan"]);
  });

  it("none of the five police accounts comes from the prior, whatever its rate; before P3 (typed institution) they would have", () => {
    const all: Record<string, number> = { RajGovOfficial: 0.6 };
    for (const h of POLICE) all[h] = 0.95;
    expect(offer(seeded(all))).toEqual(["RajGovOfficial"]);
    // The old typing, to show what P3 closes: the same seed with the five typed "institution" offers all of them
    const before = new Map(types);
    for (const h of POLICE) before.set(h.toLowerCase(), "institution");
    expect(offer(seeded(all), before).sort()).toEqual([...POLICE, "RajGovOfficial"].sort());
  });

  it("the prior offers institutions only: never police, a district account (Settings police / collector / admin) or a person", () => {
    const one = (h: string) => offer(seeded({ [h]: 0.95 }));
    for (const h of POLICE) expect(one(h), h).toEqual([]);
    // A Settings police, collector or admin handle is "district" in the directory (settingsHandleType)
    for (const h of ["jaipur_police", "DcDmJaipur", "Swachh_Jaipur"]) expect(one(h), h).toEqual([]);
    for (const h of ["BhajanlalBjp", "KumariDiya"]) expect(one(h), h).toEqual([]);
    expect(one("INCRajasthan")).toEqual(["INCRajasthan"]);
  });

  it("nothing else moves: the desk's ranking puts a police account where an institution sat (the other text rules)", () => {
    for (const h of POLICE) {
      const pickOf: HandlePick = { handle: h, reason: "subject", title: h };
      expect(suggestionTier(pickOf, types), h).toBe("text_other");
      const asInstitution = new Map(types);
      asInstitution.set(h.toLowerCase(), "institution");
      expect(suggestionTier(pickOf, asInstitution), h).toBe("text_other");
    }
    // The state police's tagging role comes from `role`, not the type: still the state police rule and a guard
    expect(rules.state.police).toContain("PoliceRajasthan");
    expect(rules.bound!.has("policerajasthan")).toBe(true);
  });

  it("D1: a police account in the beats file leaves out THAT ONE handle with a warning; the rest of the file loads", () => {
    const file = {
      crime: { keywords: "एसीबी|सीमा", handles: ["@AcbRajasthan", "@BSF_India", "@rajeduofficial"] },
      tourism: { keywords: "पर्यटन", handles: ["@KumariDiya"] },
    };
    const warned: string[] = [];
    const b = parseBeatHandles(file, directory, { types, problem: (m) => warned.push(m) });
    expect(b.beats.get("crime")!.handles).toEqual(["rajeduofficial"]);
    expect(b.beats.get("tourism")!.handles).toEqual(["KumariDiya"]);
    expect(warned.join(" ")).toMatch(/"crime": @AcbRajasthan is a police handle.*left out of this beat \(D1\)/);
    expect(warned.join(" ")).toMatch(/"crime": @BSF_India is a police handle.*left out of this beat \(D1\)/);
    // A handle in no directory file still refuses the whole file (never invented), as does a CM / state handle
    expect(() => parseBeatHandles({ crime: { keywords: "एसीबी", handles: ["@AcbRajasthan", "@NoSuchX"] } }, directory, { types })).toThrow(DataFileRejected);
  });

  it("D2: every central armed police force in the directory is typed police — never a prior or beat handle", () => {
    expect(types.get("bsf_india")).toBe("police");
    expect(types.get("crpfindia")).toBe("police");
    expect(offer(seeded({ BSF_India: 0.95, crpfindia: 0.95, RajGovOfficial: 0.6 }))).toEqual(["RajGovOfficial"]);
    // Normal tagging is unchanged: the subject entry still matches its own names (kind "institution")
    expect(subjects.gazetteer.find("सीमा सुरक्षा बल के जवानों ने घुसपैठिए को पकड़ा").some((m) => m.entry.data.handle === "BSF_India")).toBe(true);
  });

  it("R8: a beat handle skipped at compose for its type says so in the warnings", () => {
    const loose = parseBeatHandles({ sanitation: { keywords: "स्वच्छता", handles: ["@AcbRajasthan", "@rajeduofficial"] } }, directory);
    const p = { ...nirmal, prior: null, beats: ["sanitation"], beatsSource: "desk" as const };
    const out = reporterPrior({ profile: p, text: "स्वच्छता अभियान", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory, types }, reporters, loose);
    expect(out.handles.map((h) => h.handle)).toEqual(["rajeduofficial"]);
    expect(out.warnings).toEqual(["declared beat sanitation: @AcbRajasthan is skipped — its handle_type is \"police\", and a beat offers only an institution or a person"]);
  });
});

describe("P6: a declared beat offers institution or person handles only — exact, lower-case", () => {
  // A subject entry typed "District" (capital D): its loader rejects it, so the handle is in the directory with NO type
  const problems: string[] = [];
  const subjectsX = parseSubjectHandles({
    version: 2,
    entries: [
      { handle: "@SwachhTestX", handle_type: "District", kind: "department", title: "Swachh X", names_hi: ["स्वच्छता मिशन एक्स"], verified: true },
      { handle: "@EduTestX", handle_type: "institution", kind: "department", title: "Edu X", names_hi: ["शिक्षा विभाग एक्स"], verified: true },
    ],
  }, (m) => problems.push(m));
  const dirX = new Set([...directory, ...(subjectsX.handles ?? [])]);
  const typesX = mergeHandleTypes(rules.types, subjects.types, subjectsX.types, parties.types, reporters.types);
  const file = { sanitation: { keywords: "स्वच्छता", handles: ["@SwachhTestX", "@EduTestX", "@KumariDiya"] } };
  const rituraj = reporters.profiles!.get("rituraj9999")!;
  const onBeat = { ...rituraj, prior: null, beats: ["sanitation"], beatsSource: "desk" as const };
  const offered = (b: ReturnType<typeof parseBeatHandles>, t: ReadonlyMap<string, HandleType> | null = typesX) =>
    reporterPrior({ profile: onBeat, text: "स्वच्छता अभियान की समीक्षा", taken: new Set(), takenTags: new Set(), districtBound: new Set(), directory: dirX, types: t }, reporters, b);

  it("an entry typed \"District\" is not offered by a beat: left out at load with a warning, the rest of the beat loads", () => {
    expect(problems.join(" ")).toMatch(/@SwachhTestX\): "handle_type" "District" is not one of institution, person, district, police, entry rejected/);
    expect(dirX.has("swachhtestx")).toBe(true);
    expect(typesX.has("swachhtestx")).toBe(false);
    const warned: string[] = [];
    const b = parseBeatHandles(file, dirX, { types: typesX, problem: (m) => warned.push(m) });
    expect(b.beats.get("sanitation")!.handles).toEqual(["EduTestX", "KumariDiya"]);
    expect(warned.join(" ")).toMatch(/"sanitation": @SwachhTestX has no valid handle_type in any directory file — a beat offers only "institution" or "person", so it is left out of this beat \(P6\)/);
    expect(offered(b).handles.map((h) => h.handle)).toEqual(["EduTestX", "KumariDiya"]);
  });

  it("and at compose, from a beats file loaded without types: still never offered", () => {
    const loose = parseBeatHandles(file, dirX);
    expect(loose.beats.get("sanitation")!.handles).toEqual(["SwachhTestX", "EduTestX", "KumariDiya"]);
    const out = offered(loose);
    expect(out.handles.map((h) => h.handle)).toEqual(["EduTestX", "KumariDiya"]);
    expect(out.handles.every((h) => h.reason === "beat")).toBe(true);
  });

  it("any other type is left out at compose too (district, police); no types at all: no beat handle, and it says why", () => {
    const loose = parseBeatHandles(file, dirX);
    for (const t of ["district", "police"] as const) {
      const odd = new Map(typesX);
      odd.set("edutestx", t);
      expect(offered(loose, odd).handles.map((h) => h.handle), t).toEqual(["KumariDiya"]);
    }
    for (const t of [null, new Map<string, HandleType>()]) {
      const out = offered(loose, t);
      expect(out.handles).toEqual([]);
      expect(out.warnings.join(" ")).toMatch(/declared beats offer no handles \(fail closed\)/);
    }
  });

  it("the shipped beats load whole with the directory's types: every handle is an institution or a person", () => {
    const warned: string[] = [];
    const shipped = parseBeatHandles(cfg("beat-handles.json"), directory, { types, problem: (m) => warned.push(m) });
    expect(warned).toEqual([]);
    for (const b of shipped.beats.values()) for (const h of b.handles) expect(["institution", "person"], h).toContain(types.get(h.toLowerCase()));
    expect([...shipped.beats.keys()].sort()).toEqual([...beats.beats.keys()].sort());
  });
});
