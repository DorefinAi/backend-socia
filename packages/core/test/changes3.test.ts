// Changes #3 (13 Nov) and its final answers (15 Nov): the hashtag and handle logic, and the Extracted sheet.
//   Step 1  config: Kamalkant and Kasana's districts, the Baran and Pratapgarh alternates, Kharra's seat, Shubham Jain
//   Step 2  §2.1 party_of_leader: a Congress leader on the draft offers @INCRajasthan (never tags it)
//   Step 3  §2.2 district_when_missing for Shivendra, Kamalkant, Yogesh (Jaipur) and Bhanwar (Kota): Part 3's examples
//   Step 4  the 13 sheet handles the desk used on 2+ posts; pending-handles.json, which nothing loads
// Step 5 (the hashtags) is in changes3-hashtags.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, districtKey, parseBeatHandles, parseBreaking, parseHandleRules, parseHashtagNormalise, parsePartyHandles,
  parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules, partyOfLeader, pickReporter, slotFromTags, type BreakingDraft,
} from "../src";

const cfgText = (f: string) => readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8");
const cfg = (f: string) => JSON.parse(cfgText(f));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
const AT = new Date("2026-11-13T08:00:00Z");

const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;

function draft(name: string, lines: string[], opts: { reporterPrior?: boolean } = {}): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, normaliser, suggestRules, beats, at: AT, ...opts },
  );
}

const lc = (h: string) => h.replace(/^@/, "").toLowerCase();
const emitted = (d: BreakingDraft) => d.handles.map((h) => lc(h.handle));
const offered = (d: BreakingDraft) => d.handleSuggestions.map((h) => lc(h.handle));
const everywhere = (d: BreakingDraft) => [...emitted(d), ...offered(d)];
const jaipur = rules.districts[districtKey("Jaipur")]!;

// ─── Step 1: config ──────────────────────────────────────────────────────────

describe("Changes #3 step 1: config", () => {
  const entry = (h: string) => (cfg("reporter-handles.json").entries as { handle: string }[]).find((e) => e.handle === h) as Record<string, unknown>;

  it("§1.3 Kamalkant's district is Jaipur only", () => {
    expect(entry("@vyaskamalkant").districts).toEqual(["Jaipur"]);
    expect(pickReporter("KAMALKANT", reporters).match?.districts).toEqual(["Jaipur"]);
  });

  it("Q2 Kasana: districts Jaipur, no policy, and a bureau reporter", () => {
    expect(entry("@DineshKasana15")).toMatchObject({ districts: ["Jaipur"], bureau: true });
    expect(entry("@DineshKasana15").policy).toBeUndefined();
    expect(String(entry("@DineshKasana15").note)).toMatch(/special correspondent/i);
    expect(pickReporter("DINESH_KASANA", reporters).match).toMatchObject({ handle: "DineshKasana15", districts: ["Jaipur"], bureau: true });
  });

  it("Q2 Kasana: no #Jaipur: is ever added, not even when his file carries the Jaipur code", () => {
    for (const code of ["", "JPR3"]) {
      const d = draft(fileFor("DINESH_KASANA", code), ["जेडीए ने जारी किए नए आदेश", "सभी जोन में लागू होंगे नियम"]);
      expect(d.bodyText.startsWith("#")).toBe(false);
      expect(d.districtSource).toBeNull();
      expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
      // Nor is Jaipur offered on his behalf: his file code and his district say where he sits, not where the story is
      expect(d.hashtagSuggestionItems.some((t) => t.source.startsWith("district.") && t.tag === "#Jaipur")).toBe(false);
    }
  });

  it("Q2 a bureau reporter: a district_when_missing policy beside it rejects the entry; a non-boolean bureau too", () => {
    const base = { handle: "@x_reporter", handle_type: "person", names_en: ["XREP"], districts: ["Jaipur"], verified: true };
    for (const bad of [{ ...base, bureau: true, policy: { district_when_missing: "Jaipur" } }, { ...base, bureau: "yes" }]) {
      const problems: string[] = [];
      const r = parseReporterHandles({ version: 1, entries: [bad] }, (m) => problems.push(m));
      expect(r.count).toBe(0);
      expect(problems.join(" ")).toMatch(/bureau/);
    }
  });

  it("Q1 Baran: @DcDmBaran is the only collector Socia picks; @DcDmBaran_ is a recognised alternate", () => {
    const baran = rules.districts[districtKey("Baran")]!;
    expect(baran.collector).toEqual(["DcDmBaran"]);
    expect(rules.all!.has("dcdmbaran_")).toBe(true);
    expect(rules.bound!.has("dcdmbaran_")).toBe(true);
    // Part 3: "Baran story → @DcDmBaran available under Baran"
    const d = draft(fileFor(null), ["#Baran: जिला कलेक्टर ने ली अधिकारियों की बैठक", "जिला प्रशासन ने दिए निर्देश, कलेक्टर ने किया निरीक्षण"]);
    expect(d.cls).toBe("administration");
    expect(emitted(d)).toEqual(["dcdmbaran"]);
    expect(everywhere(d)).not.toContain("dcdmbaran_");
  });

  it("Q4 Pratapgarh: @PratapgrhPolice stays the only force; @pratapgarhpol is recognised, never picked, and adds no 'two police handles' warning", () => {
    const p = rules.districts[districtKey("Pratapgarh")]!;
    expect(p.police).toEqual(["PratapgrhPolice"]);
    expect(rules.all!.has("pratapgarhpol")).toBe(true);
    expect(rules.bound!.has("pratapgarhpol")).toBe(true);
    const d = draft(fileFor(null), ["#Pratapgarh: दीपावली की रात फायरिंग कर जानलेवा हमला करने वाले 4 आरोपी गिरफ्तार", "नीमच नाके पर युवक पर की थी फायरिंग"]);
    expect(emitted(d)).toEqual(["pratapgrhpolice"]);
    expect(everywhere(d)).not.toContain("pratapgarhpol");
    expect(d.warnings.join(" ")).not.toMatch(/police handles/);
  });

  it("Q1/Q4 an alternate that is not true or false rejects the file (never a silent pick)", () => {
    const bad = { version: 2, state: [], districts: { Baran: [{ handle: "@DcDmBaran_", handle_type: "district", role: "collector", verified: true, alternate: "yes" }] } };
    expect(() => parseHandleRules(bad)).toThrow(/alternate/);
  });

  it("§1.5 Kharra's seat is Srimadhopur in Sikar district, and he stays suggest-only", () => {
    const k = (cfg("party-handles.json").entries as Record<string, unknown>[]).find((e) => e.handle === "@officialkharra")!;
    expect(String(k.note)).toMatch(/Srimadhopur, Sikar district/);
    expect(k.scope).toBe("mla");
    const d = draft(fileFor(null), ["#Jaipur: यूडीएच मंत्री झाबर सिंह खर्रा ने किया निरीक्षण", "अधिकारियों को दिए निर्देश"]);
    expect(emitted(d)).not.toContain("officialkharra");
  });

  it("Q8 Shubham Jain: in the file, unverified, Ajmer, no policy, never a bare SHUBHAM; not tagged until confirmed", () => {
    expect(entry("@shubhamjain8824")).toMatchObject({ verified: false, districts: ["Ajmer"], names_en: ["shubham_jain", "SHUBHAM_JAIN"] });
    expect(entry("@shubhamjain8824").policy).toBeUndefined();
    expect(reporters.handles!.has("shubhamjain8824")).toBe(true);
    expect(pickReporter("SHUBHAM_JAIN", reporters).match).toBeNull();
    expect(pickReporter("SHUBHAM", reporters).match).toBeNull();
  });

  it("Part 3: a file-name token 'dinesh' alone tags no reporter (contested)", () => {
    const r = pickReporter("DINESH", reporters);
    expect(r.match).toBeNull();
    expect(r.collision).toBe("DINESH");
  });
});

// ─── Step 2: §2.1 party_of_leader ────────────────────────────────────────────

describe("Changes #3 step 2: a Congress leader on the draft offers @INCRajasthan", () => {
  // Changes #3 §2.1's 13 Nov post (Dinesh Dangi): no "कांग्रेस" / "Congress" anywhere in the copy
  const RAHUL = ["#Jaipur: लोकसभा में नेता प्रतिपक्ष राहुल गांधी का बड़ा दावा", "वोट चोरी के आरोपों पर फिर साधा निशाना, चुनाव आयोग से मांगा जवाब"];
  const inc = (d: BreakingDraft) => d.handleSuggestions.filter((h) => lc(h.handle) === "incrajasthan");

  it("the leaders are config (party-handles.json @INCRajasthan.leaders), each a verified directory handle", () => {
    const e = (cfg("party-handles.json").entries as Record<string, unknown>[]).find((x) => x.handle === "@INCRajasthan")!;
    expect(e.leaders).toEqual(["@RahulGandhi", "@ashokgehlot51", "@SachinPilot", "@GovindDotasra", "@TikaRamJullyINC", "@kharge"]);
    expect(e.leader_names).toEqual(["सोनिया गांधी", "Sonia Gandhi"]);
    expect(e.leader_first_for_reporters).toEqual(["@dineshdangi84", "@naresh_jsharma"]);
    for (const h of e.leaders as string[]) expect(subjects.handles!.has(lc(h))).toBe(true);
    expect(parties.leaderRules).toHaveLength(1);
  });

  it("the 13 Nov post: emit @RahulGandhi @dineshdangi84; @INCRajasthan offered FIRST with 'Congress leader tagged'; nothing new emitted", () => {
    const d = draft(fileFor("DINESH_DANGI"), RAHUL);
    const off = draft(fileFor("DINESH_DANGI"), RAHUL);
    expect(emitted(d)).toEqual(["rahulgandhi", "dineshdangi84"]);
    expect(d.handleSuggestions[0]).toMatchObject({ handle: "INCRajasthan", reason: "party", source: "party_of_leader", detail: "Congress leader tagged" });
    expect(d.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ item: "@INCRajasthan", layer: "suggest", source: "party_of_leader", reason: "Congress leader tagged" })]));
    expect(d.proposals.some((p) => p.layer === "emit" && p.item === "@INCRajasthan")).toBe(false);
    expect(off.bodyText).toBe(d.bodyText);
  });

  it("Naresh's 13 Nov #Delhi post (former CM Gehlot): INC offered once, first; no Rajasthan CM suggestion", () => {
    const d = draft(fileFor("NARESH"), ["#Delhi: राजीव गांधी स्टडी सर्किल का कार्यक्रम", "दिल्ली में नेहरू मेमोरियल यूथ फेस्टिवल का शुभारंभ, पूर्व सीएम अशोक गहलोत ने किया संबोधित"]);
    expect(everywhere(d).filter((h) => h === "incrajasthan")).toHaveLength(1);
    if (!emitted(d).includes("incrajasthan")) expect(d.handleSuggestions[0]).toMatchObject({ handle: "INCRajasthan", source: "party_of_leader" });
    for (const cm of ["bhajanlalbjp", "rajcmo"]) expect(everywhere(d)).not.toContain(cm);
  });

  it("INC already on the draft: no duplicate INC suggestion (and @INCIndia counts as present too)", () => {
    const d = draft(fileFor("NARESH"), ["#Jaipur: कांग्रेस नेता अशोक गहलोत ने साधा निशाना", "प्रदेश कांग्रेस मुख्यालय में हुई बैठक"]);
    expect(everywhere(d).filter((h) => h === "incrajasthan").length).toBeLessThanOrEqual(1);
    expect(d.handleSuggestions.some((h) => h.source === "party_of_leader")).toBe(false);
    expect(partyOfLeader("राहुल गांधी", [{ handle: "RahulGandhi" }, { handle: "@INCIndia" }], parties)).toEqual([]);
    expect(partyOfLeader("राहुल गांधी", [{ handle: "RahulGandhi" }], parties)).toEqual([{ handle: "INCRajasthan", name: "Congress Rajasthan", reason: "Congress leader tagged", first: false }]);
    expect(partyOfLeader("राहुल गांधी", [{ handle: "RahulGandhi" }], parties, "@naresh_jsharma")[0]!.first).toBe(true);
  });

  it("any other reporter: offered after the other text suggestions, not first; Dangi or Naresh: first", () => {
    const lines = ["#Jaipur: सचिन पायलट ने यूडीएच मंत्री झाबर सिंह खर्रा पर साधा निशाना", "शहर की सड़कों की हालत पर उठाए सवाल"];
    const other = draft(fileFor(null), lines);
    const dangi = draft(fileFor("DINESH_DANGI"), lines);
    expect(offered(other)).toContain("incrajasthan");
    expect(offered(other)[0]).not.toBe("incrajasthan");
    expect(offered(dangi)[0]).toBe("incrajasthan");
    // Nothing else moved: the other suggestions keep their order behind it
    expect(offered(dangi).filter((h) => h !== "incrajasthan")).toEqual(offered(other).filter((h) => h !== "incrajasthan"));
    expect(dangi.handles.map((h) => h.handle).filter((h) => h !== "dineshdangi84")).toEqual(other.handles.map((h) => h.handle));
  });

  it("Sonia Gandhi named (by name) offers it too", () => {
    const d = draft(fileFor(null), ["#Delhi: सोनिया गांधी अस्पताल में भर्ती", "स्वास्थ्य जांच के लिए भर्ती कराया गया"]);
    expect(everywhere(d)).toContain("incrajasthan");
  });

  it("no Congress leader, nothing offered; a BJP leader never offers INC", () => {
    const d = draft(fileFor("DINESH_DANGI"), ["#Jaipur: मुख्यमंत्री भजनलाल शर्मा ने किया लोकार्पण", "विकास कार्यों की दी सौगात"]);
    expect(d.handleSuggestions.some((h) => h.source === "party_of_leader")).toBe(false);
  });

  it("independent of the reporter prior (L7): the same offer, in the same place, with the prior on or off", () => {
    for (const token of ["DINESH_DANGI", "NARESH", null]) {
      const on = draft(fileFor(token), RAHUL);
      const off = draft(fileFor(token), RAHUL, { reporterPrior: false });
      expect(on.handleSuggestions.slice(0, off.handleSuggestions.length)).toEqual(off.handleSuggestions);
      expect(inc(on)).toHaveLength(1);
    }
  });

  it("parser: a malformed leaders block is ignored and reported, the entry still loads; an MLA cannot carry one", () => {
    const e = { handle: "@INCRajasthan", handle_type: "institution", party: "congress", scope: "state", keywords_hi: ["कांग्रेस"], verified: true };
    for (const bad of [{ ...e, leaders: "@RahulGandhi" }, { ...e, leaders: [] }, { ...e, leaders: ["not a handle"] }, { ...e, leaders: ["@RahulGandhi"], leader_reason: "" }]) {
      const problems: string[] = [];
      const r = parsePartyHandles({ version: 1, entries: [bad] }, (m) => problems.push(m));
      expect(r.count).toBe(1);
      expect(r.leaderRules).toEqual([]);
      expect(problems.join(" ")).toMatch(/leaders block is ignored/);
    }
    const problems: string[] = [];
    const mla = parsePartyHandles({ version: 1, entries: [{ ...e, handle: "@someMLA", scope: "mla", verified: false, leaders: ["@RahulGandhi"] }] }, (m) => problems.push(m));
    expect(mla.leaderRules).toEqual([]);
    expect(problems.join(" ")).toMatch(/only read on a "state" or "national" entry/);
  });
});

// ─── Step 3: §2.2 district_when_missing (Part 3's examples) ──────────────────

describe("Changes #3 step 3: the district-when-missing policy for four more reporters", () => {
  const NONE = ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"];

  it.each([["YOGESH", "Jaipur"], ["SHIVENDRA", "Jaipur"], ["KAMALKANT", "Jaipur"], ["BHANWAR", "Kota"]])("%s, standard post, no district: #%s: emitted as the desk rule", (token, district) => {
    const d = draft(fileFor(token), NONE);
    expect(d.bodyText.startsWith(`#${district}: `)).toBe(true);
    expect(d.districtSource).toBe("reporter_policy");
  });

  it("Yogesh, standard post, no district: #Jaipur: and no @jaipur_police / @DcDmJaipur (V7)", () => {
    // A police story naming no place: the desk rule writes #Jaipur:, and it chooses no force or collector
    const d = draft(fileFor("YOGESH"), ["पुलिस ने निकाला फ्लैग मार्च, थाना प्रभारी ने दिए निर्देश", "कानून-व्यवस्था बनाए रखने की अपील"]);
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
    for (const h of [...jaipur.police, ...jaipur.collector, "jaipur_police", "DcDmJaipur"]) expect(everywhere(d)).not.toContain(lc(h));
  });

  it("Bhanwar, video post, no district: #Kota offered in the trailing run, no leading tag", () => {
    const d = draft(fileFor("BHANWAR"), ["कोचिंग छात्रों के लिए नई गाइडलाइन जारी | Rajasthan News", "सभी संस्थानों को भेजे गए निर्देश"]);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.hashtagSuggestionItems[0]).toMatchObject({ tag: "#Kota", source: "reporter_policy" });
  });

  it("Bhanwar, '#Bundi: …': unchanged, the policy does not fire", () => {
    const d = draft(fileFor("BHANWAR"), ["#Bundi: जिला अस्पताल में नई सुविधा शुरू", "मरीजों को मिलेगा लाभ"]);
    expect(d.bodyText.startsWith("#Bundi")).toBe(true);
    expect(d.bodyText).not.toContain("#Kota");
    expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
  });

  it("Kamalkant, '#Delhi: …': unchanged", () => {
    const d = draft(fileFor("KAMALKANT"), ["#Delhi: सुप्रीम कोर्ट ने सुनाया अहम फैसला", "याचिका पर हुई सुनवाई"]);
    expect(d.bodyText.startsWith("#Delhi")).toBe(true);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
  });

  it("#XNews and an out-of-state tag block it (R2); a place the desk wrote stays (R3)", () => {
    for (const lines of [["सरकार ने जारी किए नए आदेश #JodhpurNews", "सभी विभागों को भेजे गए आदेश"], ["#Bihar: चुनावी सभा में उमड़ी भीड़", "नेताओं ने किया संबोधन"], ["आकोला: पंचायत समिति की बैठक", "विकास कार्यों पर चर्चा"]]) {
      const d = draft(fileFor("YOGESH"), lines);
      expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
    }
  });

  it("R2: '#Ladakh: …' (Kamalkant, oct20) is out of state: no #Jaipur in front, and the national footer", () => {
    const d = draft(fileFor("KAMALKANT"), ["#Ladakh: हिमालय की दुर्गम वादियों में न्यायिक व्यवस्था का नया अध्याय", "लेह में हुई सुनवाई"]);
    expect(d.bodyText.startsWith("#Ladakh")).toBe(true);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
    expect(d.hashtags).toEqual(["#FirstIndiaNews"]);
  });
});
