// Reporter routing prior + decision-log contract (reporter-prior brief, 13 Nov 2026).
//   Step 1  the eleven invariants V1–V11 the prior is built on, pinned with the brief's own fixtures
//   Step 3  the measured prior: the exact firing table of §3.4, declared beats, L1 and L7
//   Step 4  rituraj's "#Jaipur:" desk rule and its isolation (§4.2, L4)
//   Step 5  ambiguous tokens (DINESH)
//   Step 6  an office named without its holder ("CM ने ...")
// The decision log's database half (rows, item_outcomes, rework_ratio, the nightly features, L5) is tested in
// packages/db and apps/api.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_NATIONAL, BRAND_RAJASTHAN, DataFileRejected, PlaceBook, REPORTER_STATUSES, composeBreaking, composePostTags, districtKey, fileTags,
  inferHeadlineDistrict, isVideoHeadline, namesOffice, normaliseTag, parseBeatHandles, parseBreaking, parseDistricts, parseHandleRules,
  parseHashtagNormalise, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, parseSuggestRules, pickReporter,
  reporterPrior, reporterProfile, resolveReporterStatus, segmentPost, slotFromTags, smoothedRate, type BreakingDraft, type HandlePick,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const places = parseDistricts(cfg("districts.json"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const normaliser = parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const directory = new Set([...(rules.all ?? []), ...(subjects.handles ?? []), ...(parties.handles ?? []), ...(reporters.handles ?? [])]);
const beats = parseBeatHandles(cfg("beat-handles.json"), directory);
const ctx = { places, normaliser };
const AT = new Date("2026-11-13T08:00:00Z");

const jaipur = rules.districts[districtKey("Jaipur")]!;
const jodhpur = rules.districts[districtKey("Jodhpur")]!;
const districtBound = new Set([...rules.state.police, ...Object.values(rules.districts).flatMap((d) => [...d.police, ...d.collector])].map((h) => h.toLowerCase()));

/** A breaking file as the desk saves it: the name on line 1, then the headline and the points */
const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;

function draft(name: string, lines: string[], opts: { reporterPrior?: boolean } = {}): { d: BreakingDraft; p: ReturnType<typeof parseBreaking> } {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  const d = composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, normaliser, suggestRules, beats, at: AT, ...opts },
  );
  return { d, p };
}

const all = (d: BreakingDraft) => [...d.handles, ...d.handleSuggestions].map((h) => h.handle.toLowerCase());
const suggested = (d: BreakingDraft, reason?: HandlePick["reason"]) => d.handleSuggestions.filter((h) => !reason || h.reason === reason).map((h) => h.handle);

// ─── Step 1: the invariants ──────────────────────────────────────────────────

describe("Step 1: V1–V11 hold before the prior is added", () => {
  it("V1 URLs are stripped before segmentation", () => {
    expect(segmentPost("सड़क हादसा\n\n#Pali #RajasthanWithFirstIndia https://t.co/x").trail).toEqual(["Pali", "RajasthanWithFirstIndia"]);
  });
  it("V2 a danda attached to the word before it still separates", () => {
    expect(isVideoHeadline("उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News")).toBe(true);
  });
  it("V3 'Breaking News:' / 'Rajasthan News Live:' headlines are not video posts", () => {
    expect(composePostTags("Breaking News: चमोली में भूस्खलन\n\n#FirstIndiaNews", ctx).trail).not.toContain("FINVideo");
    expect(composePostTags("Rajasthan News Live: जयपुर में बारिश\n\n#RajasthanWithFirstIndia", ctx).trail).not.toContain("FINVideo");
  });
  it("V4 a France story with no Rajasthan district is #FirstIndiaNews", () => {
    expect(composePostTags("फ्रांस में सरकार के खिलाफ प्रदर्शन\n\nपेरिस में हजारों लोग सड़कों पर उतरे", ctx).trail).toEqual([BRAND_NATIONAL]);
    const { d } = draft(fileFor(null), ["फ्रांस में सरकार के खिलाफ प्रदर्शन", "पेरिस में हजारों लोग सड़कों पर उतरे"]);
    // The breaking composer: a story the worker marks as not Rajasthan gets the national brand
    const n = composeBreaking({ headline: "फ्रांस में सरकार के खिलाफ प्रदर्शन", points: ["पेरिस में हजारों लोग"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, { subjects, reporters, parties });
    expect(n.hashtags).toEqual([`#${BRAND_NATIONAL}`]);
    expect(d.bodyText.startsWith("#")).toBe(false);
  });
  it("V5 trailing-format posts emit out-of-state places, district before brand", () => {
    expect(composePostTags("बिहार में चुनावी सभा\n\nनेताओं ने किया संबोधन\n\n#Bihar #FirstIndiaNews", ctx).trail).toEqual(["Bihar", BRAND_NATIONAL]);
  });
  it("V6 normalisation runs first; a typo is flagged, not silently fixed", () => {
    expect(normaliseTag("FINVido", normaliser)).toEqual({ tag: "FINVideo", flag: "#FINVido → #FINVideo" });
    expect(composePostTags("Diwali Mela 2026: रोशनी से जगमगाया शहर\n\n#FINVido #RajasthanWithFirstIndia", ctx).flags).toContain("#FINVido → #FINVideo");
  });
  it("V7 the Dungarpur ACB post filed by navinsharmabki: nothing emitted from inference, no Jaipur police", () => {
    const { d } = draft("BTN_RJ_BREAKING_6043_12NOV_US_NAVIN_JPR_BIG_FULL.txt", ["डूंगरपुर में ACB  कार्रवाई", "ACB ने झोतरी CHC के प्रभारी को किया ट्रैप", "प्रभारी डॉ.अमित को एक हजार रुपए की रिश्वत लेते दबोचा"]);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    // User decision (12 Nov): nothing from Navin — #Jaipur is not even suggested (the brief allows "may")
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
    for (const h of [...jaipur.police, ...jaipur.collector]) expect(all(d)).not.toContain(h.toLowerCase());
  });
  it("V8 a route is not a place: 'अजमेर-जयपुर हाईवे पर हादसा' gives no #Ajmer from the headline", () => {
    expect(inferHeadlineDistrict(book, "अजमेर-जयपुर हाईवे पर हादसा")).toBeNull();
    const { d } = draft(fileFor("NARESH"), ["अजमेर-जयपुर हाईवे पर हादसा", "दो लोग घायल"]);
    expect(d.bodyText.startsWith("#Ajmer")).toBe(false);
    expect(d.hashtagSuggestions).not.toContain("#Ajmer");
  });
  it("V9 'पंचायत' only in the points: no @CeoRajasthan", () => {
    const { d } = draft(fileFor(null, "JPR3"), ["मतदाता सूची में नाम जुड़वाने का अभियान शुरू", "ग्राम पंचायत स्तर पर लगेंगे शिविर"]);
    expect(all(d)).not.toContain("ceorajasthan");
  });
  it("V9 positive control: the same voter-list story without 'पंचायत' does reach @CeoRajasthan", () => {
    const { d } = draft(fileFor(null, "JPR3"), ["मतदाता सूची में नाम जुड़वाने का अभियान शुरू", "सभी मतदान केंद्रों पर लगेंगे शिविर"]);
    expect(all(d)).toContain("ceorajasthan");
  });
  it("V2 negative: a danda that ends the headline (nothing after it) is not a video headline; through segmentPost", () => {
    expect(isVideoHeadline("उज्जैन में नई योजना का शुभारंभ।")).toBe(false);
    expect(isVideoHeadline(segmentPost("उज्जैन में नई योजना का शुभारंभ।\n\nमुख्यमंत्री ने किया लोकार्पण\n\n#FirstIndiaNews").headline)).toBe(false);
    const s = segmentPost("उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News\n\n#FINVideo #FirstIndiaNews");
    expect(s.headline).toBe("उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News");
    expect(isVideoHeadline(s.headline)).toBe(true);
    expect(s.trail).toEqual(["FINVideo", "FirstIndiaNews"]);
  });
  it("V10 'कांग्रेस' only in the points: @INCRajasthan offered, not tagged", () => {
    const { d } = draft(fileFor(null, "JPR3"), ["जयपुर में पूर्व मंत्री का धरना प्रदर्शन", "कांग्रेस कार्यकर्ताओं ने की नारेबाजी"]);
    expect(d.mentions).not.toContain("@INCRajasthan");
    expect(suggested(d)).toContain("INCRajasthan");
  });
  it("V11 every handle the picker returns is in a directory file (the @UniRajOfficial conflict is left as it is, by the user)", () => {
    const { d } = draft("BTN_RJ_BREAKING_2113_12NOV_mh_CONTROL_Dinesh_Dangi_karari_big.txt", [
      "9 माह से कांग्रेस के छात्र संगठन NSUI का नहीं कोई धणी धोरी", "दोनों नेता राजस्थान यूनिवर्सिटी छात्रसंघ अध्यक्ष का हार चुके चुनाव",
    ]);
    for (const h of all(d)) expect(directory.has(h)).toBe(true);
  });
});

// ─── the decision log's reporter status (Step 2.2) ───────────────────────────

describe("Step 2.2: reporter_status from the file name only", () => {
  const status = (name: string | null) => resolveReporterStatus(name, name ? fileTags(name, book.codes) : null, reporters);
  it("covers all seven statuses", () => {
    expect(status(fileFor("RITURAJ"))).toMatchObject({ status: "matched", reporterHandle: "rituraj9999", reporterToken: "RITURAJ" });
    expect(status(fileFor("ZORAWAR"))).toMatchObject({ status: "unknown_token", reporterHandle: null, reporterToken: "ZORAWAR" });
    expect(status(fileFor("DINESH"))).toMatchObject({ status: "collision", reporterHandle: null, reporterToken: "DINESH" });
    expect(status(fileFor(null, "AJM3"))).toMatchObject({ status: "bureau_code", bureauCode: "AJM", bureauDistrict: "Ajmer", slotRaw: "AJM" });
    expect(status(fileFor(null, "XYZ9"))).toMatchObject({ status: "unknown_bureau_code", bureauCode: "XYZ", bureauDistrict: null });
    expect(status("BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_BIG.txt")).toMatchObject({ status: "no_slot", slotRaw: null });
    expect(status(null)).toMatchObject({ status: "no_filename" });
    expect(new Set([fileFor("RITURAJ"), fileFor("ZORAWAR"), fileFor("DINESH"), fileFor(null, "AJM3"), fileFor(null, "XYZ9"), "BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_BIG.txt", null].map((n) => status(n).status))).toEqual(new Set(REPORTER_STATUSES));
  });
  it("keeps the bureau code beside a matched reporter", () => {
    expect(status(fileFor("RITURAJ", "JPR3"))).toMatchObject({ status: "matched", bureauCode: "JPR", bureauDistrict: "Jaipur" });
  });
});

// ─── Step 5: roster ──────────────────────────────────────────────────────────

describe("Step 5.1: DINESH names two reporters and tags nobody", () => {
  it("bare DINESH is a collision; DINESH_KASANA is Kasana; DINESH_DANGI is Dangi", () => {
    expect(pickReporter("DINESH", reporters)).toEqual({ match: null, unmatchedToken: null, collision: "DINESH" });
    expect(pickReporter("DINESH_KASANA", reporters).match?.handle).toBe("DineshKasana15");
    expect(pickReporter("KASANA", reporters).match?.handle).toBe("DineshKasana15");
    expect(pickReporter("DINESH_DANGI", reporters).match?.handle).toBe("dineshdangi84");
  });
  it("a political story filed as DINESH carries no byline and says why", () => {
    const { d } = draft(fileFor("DINESH"), ["भाजपा प्रदेशाध्यक्ष ने की बैठक", "कार्यकर्ताओं को दिए निर्देश"]);
    expect(all(d)).not.toContain("dineshdangi84");
    expect(all(d)).not.toContain("dineshkasana15");
    expect(d.unmatchedReporter).toBeNull();
    expect(d.warnings.join(" ")).toMatch(/DINESH.*more than one reporter/);
  });
  it("an entry listing an ambiguous token does not claim it", () => {
    const problems: string[] = [];
    const r = parseReporterHandles({ version: 1, ambiguous_tokens: ["DINESH"], entries: [{ handle: "@a", names_en: ["dinesh", "a_one"], verified: true }] }, (m) => problems.push(m));
    expect(pickReporter("DINESH", r).collision).toBe("DINESH");
    expect(problems.join(" ")).toMatch(/ambiguous_tokens/);
  });
});

// ─── Step 3: the measured prior (§3.4) ───────────────────────────────────────

const profileOf = (handle: string) => {
  const p = reporters.profiles?.get(handle.toLowerCase()) ?? null;
  return p;
};
const priorOf = (handle: string, text = "", taken: string[] = []) =>
  reporterPrior({ profile: profileOf(handle), text, taken: new Set(taken.map((t) => t.toLowerCase())), takenTags: new Set(), districtBound, directory }, reporters, beats);

describe("Step 3.4: exactly the firing table, on the seed data", () => {
  const TABLE: [string, [string, number, "trunc"?][]][] = [
    ["rituraj9999", [["RajGovOfficial", 0.53]]],
    ["ml_vikas", [["RajGovOfficial", 0.48]]],
    ["DineshKasana15", [["RajGovOfficial", 0.43]]],
    ["Nirmaltiwaribki", [["RajGovOfficial", 0.43]]],
    // The one row the brief truncates rather than rounds (0.2751 printed 0.27)
    ["parmarshivendra", [["RajGovOfficial", 0.27, "trunc"]]],
    ["aishwaryam99", [["BhajanlalBjp", 0.54], ["BJP4Rajasthan", 0.35]]],
    ["yogesh2727sh1", [["BJP4Rajasthan", 0.39]]],
  ];
  for (const [who, fires] of TABLE) {
    it(`${who} → ${fires.map(([h, s]) => `@${h} ${s}`).join(", ")}`, () => {
      const out = priorOf(who).handles;
      expect(out.map((h) => h.handle)).toEqual(fires.map(([h]) => h));
      const p = profileOf(who)!.prior!;
      const s = reporters.prior!;
      out.forEach((h, i) => {
        // The unrounded smoothed rate, printed to 2 places as the brief's table prints it
        const raw = smoothedRate(p.handles[h.handle]!, p.n, s.base.get(h.handle.toLowerCase()) ?? 0, s.m);
        const shown = (fires[i]![2] === "trunc" ? Math.trunc(raw * 100) : Math.round(raw * 100)) / 100;
        expect(Math.abs(shown - fires[i]![1])).toBeLessThan(0.005);
        expect(h.score).toBe(Math.round(raw * 100) / 100);
        expect(h).toMatchObject({ reason: "prior", source: "reporter_prior" });
        expect(h.n).toBe(p.n);
        expect(h.detail).toMatch(/upper bound/);
      });
    });
  }
  // svoruganti1466 left the table on 13 Nov: it is the Chief Secretary's account, not a reporter
  for (const who of ["naresh_jsharma", "satyatv99_news", "dineshdangi84", "ashvinigokul", "kunwarraghav", "bhanwar_83", "vyaskamalkant"]) {
    it(`${who} is silent`, () => expect(priorOf(who).handles).toEqual([]));
  }
  it("what does NOT fire although the raw rate looks high", () => {
    const s = reporters.prior!;
    expect(smoothedRate(0.26, 58, s.base.get("rajgovofficial")!, s.m)).toBeCloseTo(0.22, 2); // Aishwarya → RajGov
    expect(smoothedRate(0.18, 102, s.base.get("rajcmo")!, s.m)).toBeCloseTo(0.15, 2); // rituraj → RajCMO
    expect(smoothedRate(0.12, 52, s.base.get("kumaridiya")!, s.m)).toBeCloseTo(0.09, 2); // Nirmal → KumariDiya
    expect(smoothedRate(0.17, 36, s.base.get("jdajaipur")!, s.m)).toBeCloseTo(0.11, 2); // Kasana → jdajaipur
    expect(priorOf("aishwaryam99").handles.map((h) => h.handle)).not.toContain("RajGovOfficial");
    expect(priorOf("rituraj9999").handles.map((h) => h.handle)).not.toContain("RajCMO");
    expect(priorOf("Nirmaltiwaribki").handles.map((h) => h.handle)).not.toContain("KumariDiya");
    expect(priorOf("DineshKasana15").handles.map((h) => h.handle)).not.toContain("jdajaipur");
  });
  it("the worked examples: rituraj 0.53, Dimple 0.08", () => {
    expect(smoothedRate(63 / 102, 102, 0.097, 20)).toBeCloseTo(0.53, 2);
    expect(smoothedRate(2 / 5, 5, 0.001, 20)).toBeCloseTo(0.08, 2);
  });
  it("a handle already emitted or offered is not offered again", () => {
    expect(priorOf("rituraj9999", "", ["RajGovOfficial"]).handles).toEqual([]);
  });
});

describe("Step 3.3: declared beats need the copy to match", () => {
  it("6. Dimple (n=5): no measured suggestion; @rajeduofficial on an education story only, labelled declared", () => {
    expect(priorOf("i_dimplesharma").handles).toEqual([]);
    const edu = priorOf("i_dimplesharma", "RPSC ने जारी किया परीक्षा का कार्यक्रम").handles;
    expect(edu).toEqual([expect.objectContaining({ handle: "rajeduofficial", reason: "beat", source: "beat.education" })]);
    expect(edu[0]!.detail).toMatch(/declared beat/);
    expect(edu[0]!.score).toBeUndefined();
    expect(priorOf("i_dimplesharma", "सड़क हादसे में दो की मौत").handles).toEqual([]);
  });
  it("6a. Nirmal: no tourism keyword, no @KumariDiya; 'पर्यटन' offers it as declared", () => {
    expect(priorOf("Nirmaltiwaribki", "खनन माफिया पर कार्रवाई").handles.map((h) => h.handle)).not.toContain("KumariDiya");
    expect(priorOf("Nirmaltiwaribki", "पर्यटन विभाग की नई योजना").handles).toEqual(expect.arrayContaining([expect.objectContaining({ handle: "KumariDiya", source: "beat.tourism" })]));
  });
  it("Kasana: a JDA story offers @jdajaipur through the declared beat", () => {
    expect(priorOf("DineshKasana15", "JDA ने हटाए अतिक्रमण").handles.map((h) => h.handle)).toEqual(["RajGovOfficial", "jdajaipur"]);
  });
  it("6b. a 'cm' beat fails the file and points to the office alias", () => {
    expect(() => parseBeatHandles({ cm: { keywords: "मुख्यमंत्री", handles: ["@BhajanlalBjp"] } }, directory)).toThrow(DataFileRejected);
    expect(() => parseBeatHandles({ cm: { keywords: "मुख्यमंत्री", handles: ["@BhajanlalBjp"] } }, directory)).toThrow(/office alias/);
    expect(() => parseBeatHandles({ "state-government": { keywords: "सरकार", handles: ["@RajGovOfficial"] } }, directory)).toThrow(DataFileRejected);
  });
  it("20. a beat handle in no directory fails the file", () => {
    expect(() => parseBeatHandles({ education: { keywords: "स्कूल", handles: ["@UniRajInvented"] } }, directory)).toThrow(/in no directory file/);
  });
  it("L8: every handle the config can offer is in a directory file", () => {
    for (const p of reporters.profiles!.values()) for (const h of Object.keys(p.prior?.handles ?? {})) expect(directory.has(h.toLowerCase()), h).toBe(true);
    for (const b of beats.beats.values()) for (const h of b.handles) expect(directory.has(h.toLowerCase()), h).toBe(true);
    for (const o of subjects.offices ?? []) for (const h of o.handles) expect(directory.has(h.toLowerCase()), h).toBe(true);
  });
  it("the prior never offers a police, collector or administration handle", () => {
    const fake = { ...profileOf("rituraj9999")!, prior: { n: 100, handles: { [jaipur.police[0]!]: 0.9 }, hashtags: {}, source: null } };
    expect(reporterPrior({ profile: fake, text: "", taken: new Set(), takenTags: new Set(), districtBound, directory }, reporters, beats).handles).toEqual([]);
  });
});

describe("Step 3.5: the prior in the composer", () => {
  const GOVT = ["सचिवालय में अधिकारियों की बैठक", "विभागीय योजनाओं की समीक्षा की गई"];
  it("rituraj: @RajGovOfficial offered below the other suggestions, never on the post", () => {
    const { d } = draft(fileFor("RITURAJ", "JPR3"), GOVT);
    expect(d.mentions).not.toContain("@RajGovOfficial");
    const i = d.handleSuggestions.findIndex((h) => h.reason === "prior");
    expect(d.handleSuggestions[i]).toMatchObject({ handle: "RajGovOfficial", source: "reporter_prior" });
    // Below every suggestion from the other rules
    expect(d.handleSuggestions.slice(i).every((h) => h.reason === "prior" || h.reason === "beat")).toBe(true);
    expect(d.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ item: "@RajGovOfficial", layer: "suggest", source: "reporter_prior", n: 102 })]));
  });
  it("8 (L1). the copy's handles never select the reporter: stripping them changes nothing", () => {
    const withHandles = draft(fileFor("RITURAJ", "JPR3"), [GOVT[0]!, `${GOVT[1]} @aishwaryam99 @RajGovOfficial @BhajanlalBjp`]).d;
    const without = draft(fileFor("RITURAJ", "JPR3"), GOVT).d;
    const prior = (d: BreakingDraft) => d.handleSuggestions.filter((h) => h.reason === "prior" || h.reason === "beat");
    expect(prior(withHandles)).toEqual(prior(without));
    // And with no reporter in the file name there is no prior, whatever handles the copy carries
    expect(draft(fileFor(null, "JPR3"), [GOVT[0]!, `${GOVT[1]} @rituraj9999`]).d.handleSuggestions.filter((h) => h.reason === "prior")).toEqual([]);
  });
});

// ─── L7: the emitted post is byte-identical with the prior on and off ────────

describe("L7: emit layer identical with the prior on and off", () => {
  const sample = JSON.parse(readFileSync(new URL("./fixtures/published-posts-sample.json", import.meta.url), "utf8")) as { posts: { text: string }[] };
  const posts = sample.posts.map((p) => p.text).filter(Boolean);
  const exportPath = process.env.REPLAY_EXPORTS_DIR ?? `${process.env.USERPROFILE ?? process.env.HOME}/Downloads`;
  let extra: string[] = [];
  try {
    extra = (JSON.parse(readFileSync(`${exportPath}/1stIndiaNews_tweets_2026-10-30.json`, "utf8")) as { tweets: { text: string }[] }).tweets.map((t) => t.text);
  } catch {
    /* not on this machine: the fixture sample still runs */
  }
  const corpus = [...posts, ...extra];
  const TOKENS = ["RITURAJ", "AISHWARYA", "NIRMAL", "DIMPLE", "DINESH_KASANA", "YOGESH", "NARESH", null];
  // The no-district case, and (F2) a resolved district, a story outside Rajasthan, and a leader's post
  const VARIANTS = [
    { name: "no district", district: null, rajasthan: true, leaderPost: false },
    { name: "a resolved district (Kota, stated)", district: "Kota", districtFrom: "place_line" as const, rajasthan: true, leaderPost: false },
    { name: "rajasthan false", district: null, rajasthan: false, leaderPost: false },
    { name: "leaderPost true", district: null, rajasthan: true, leaderPost: true },
  ];
  it.each(VARIANTS)(`over ${posts.length} fixture posts${extra.length ? ` + ${extra.length} from oct30` : ""}, for ${TOKENS.length} file-name reporters: $name`, (variant) => {
    expect(corpus.length).toBeGreaterThan(0);
    let compared = 0;
    for (const text of corpus) {
      const s = segmentPost(text);
      if (!s.headline) continue;
      for (const token of TOKENS) {
        const { name: _name, ...v } = variant;
        const input = { headline: s.headline, points: s.points, town: null, ...v, reporterToken: token };
        const opts = { subjects, reporters, parties, normaliser, suggestRules, beats, at: AT };
        const on = composeBreaking(input, rules, book, opts);
        const off = composeBreaking(input, rules, book, { ...opts, reporterPrior: false });
        expect([on.bodyText, on.hashtags, on.mentions, on.handles]).toEqual([off.bodyText, off.hashtags, off.mentions, off.handles]);
        expect(on.proposals.filter((p) => p.layer === "emit")).toEqual(off.proposals.filter((p) => p.layer === "emit"));
        // Everything the other rules offered is still there, first and in order
        expect(on.handleSuggestions.slice(0, off.handleSuggestions.length)).toEqual(off.handleSuggestions);
        expect(on.hashtagSuggestions.slice(0, off.hashtagSuggestions.length)).toEqual(off.hashtagSuggestions);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
  it("V11 (F3): over the corpus × every reporter token, every handle tagged or offered is in a directory file", () => {
    const opts = { subjects, reporters, parties, normaliser, suggestRules, beats, at: AT };
    let checked = 0;
    for (const text of corpus) {
      const s = segmentPost(text);
      if (!s.headline) continue;
      for (const token of TOKENS) {
        const d = composeBreaking({ headline: s.headline, points: s.points, district: null, town: null, rajasthan: true, leaderPost: false, reporterToken: token }, rules, book, opts);
        for (const h of all(d)) expect(directory.has(h), `${h} on "${s.headline}" (${token})`).toBe(true);
        // A reporter's suggestions never bring a police or collector handle, verified or not
        for (const h of d.handleSuggestions.filter((x) => x.reason === "prior" || x.reason === "beat")) expect(rules.bound!.has(h.handle.toLowerCase()), h.handle).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ─── Step 4: reporter policy ─────────────────────────────────────────────────

describe("Step 4: rituraj's '#Jaipur:' when the post names no district", () => {
  const NONE = ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"];
  it("9. a standard post with no district gets a leading #Jaipur:, marked reporter_policy", () => {
    const { d } = draft(fileFor("RITURAJ"), NONE);
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
    expect(d.districtSource).toBe("reporter_policy");
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(d.proposals).toEqual(expect.arrayContaining([expect.objectContaining({ item: "#Jaipur", layer: "emit", source: "reporter_policy" })]));
    // Not offered a second time beside the leading tag
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
  });
  it("10. a video post: no leading tag, #Jaipur offered in the trailing run", () => {
    const t = composePostTags("नए दिशा-निर्देश जारी | Rajasthan News\n\n#FINVideo #RajasthanWithFirstIndia", { ...ctx, reporterPolicy: "Jaipur" });
    expect(t.lead).toEqual([]);
    expect(t.suggest).toContain("Jaipur");
    expect(t.policy).toBe("suggest");
    const s = composePostTags("नए दिशा-निर्देश जारी\n\nसभी विभागों को आदेश\n\n#RajasthanWithFirstIndia", { ...ctx, reporterPolicy: "Jaipur" });
    expect([s.lead, s.policy]).toEqual([["Jaipur"], "emit"]);
  });
  it("11 (L4). a Jodhpur story with no district tag: #Jaipur:, and no Jaipur or Jodhpur police or collector", () => {
    // The corpus case: ग्राम पंचायत भावी is in Jodhpur district; the places file does not know the village
    const { d } = draft(fileFor("RITURAJ"), ["ग्राम पंचायत भावी में 2 नवंबर को होगा पुनर्मतदान", "मतपत्र चोरी और कानून-व्यवस्था बिगड़ने के चलते फैसला", "पुलिस ने मौके पर पहुंचकर लोगों को समझाया"]);
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
    for (const h of [...jaipur.police, ...jaipur.collector, ...jodhpur.police, ...jodhpur.collector]) expect(all(d)).not.toContain(h.toLowerCase());
  });
  it("A5: a place the gazetteer finds in the text (पंचायत समिति बिलाड़ा → Jodhpur) does NOT block it; Jodhpur stays offered, no Jodhpur handle", () => {
    // User decision (13 Nov): only a district the DESK wrote (a tag, the place line, the file code) blocks the rule
    const { d } = draft(fileFor("RITURAJ"), ["पंचायत समिति बिलाड़ा की ग्राम पंचायत भावी में पुनर्मतदान", "मतपत्र चोरी के चलते फैसला", "पुलिस ने मौके पर पहुंचकर लोगों को समझाया"]);
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
    expect(d.districtSource).toBe("reporter_policy");
    expect(d.hashtagSuggestions).toContain("#Jodhpur");
    for (const h of [...jaipur.police, ...jaipur.collector, ...jodhpur.police, ...jodhpur.collector]) expect(all(d)).not.toContain(h.toLowerCase());
    // …and as a video, the same story offers #Jaipur in the trailing run instead
    const v = draft(fileFor("RITURAJ"), ["पंचायत समिति बिलाड़ा में पुनर्मतदान | Rajasthan News", "मतपत्र चोरी के चलते फैसला"]).d;
    expect(v.bodyText.startsWith("#")).toBe(false);
    expect(v.hashtagSuggestions).toContain("#Jaipur");
  });
  it("12. a post that already names Kota keeps Kota; no #Jaipur", () => {
    const { d } = draft(fileFor("RITURAJ", "KTA4"), NONE);
    expect(d.bodyText.startsWith("#Kota: ")).toBe(true);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
  });
  it("A5: a district only the headline's text names (डूंगरपुर) does not block it either; Dungarpur is offered", () => {
    const { d } = draft(fileFor("RITURAJ"), ["डूंगरपुर में ACB कार्रवाई", "प्रभारी को रिश्वत लेते दबोचा"]);
    expect(d.bodyText.startsWith("#Jaipur: ")).toBe(true);
    expect(d.hashtagSuggestions).toContain("#Dungarpur");
  });
  it("A1: a place TAG outside Rajasthan blocks it (#Delhi in the copy, #Bhopal: before the headline); the footer is never changed", () => {
    for (const lines of [["केंद्रीय मंत्रियों की बैठक", "राज्यों के मंत्री शामिल हुए #Delhi"], ["#Bhopal: मुख्यमंत्रियों की बैठक", "राज्यों के मंत्री शामिल हुए"]]) {
      const { d } = draft(fileFor("RITURAJ"), lines);
      expect(d.bodyText.startsWith("#Jaipur"), lines[0]).toBe(false);
      expect(d.districtSource, lines[0]).not.toBe("reporter_policy");
    }
    // A place only NAMED (दिल्ली, MP) does not block: the real corpus post
    const mp = draft(fileFor("RITURAJ"), ["ACS अभय कुमार के ससुर MP के पूर्व CS का निधन", "प्रशासनिक अधिकारियों ने जताया शोक"]).d;
    expect(mp.bodyText.startsWith("#Jaipur: ")).toBe(true);
    // The rule never moves the footer: an NWS story (rajasthan false) keeps the national brand with or without it
    const input = { headline: "दिल्ली में केंद्रीय मंत्रियों की बैठक", points: ["राज्यों के मंत्री शामिल हुए"], district: null, town: null, rajasthan: false, leaderPost: false };
    const withRule = composeBreaking({ ...input, reporterToken: "RITURAJ" }, rules, book, { subjects, reporters, parties, beats });
    const without = composeBreaking({ ...input, reporterToken: "NARESH" }, rules, book, { subjects, reporters, parties, beats });
    expect(withRule.hashtags).toEqual([`#${BRAND_NATIONAL}`]);
    expect(withRule.hashtags).toEqual(without.hashtags);
  });
  it("A2: the desk's own tag run ('#BJP: ...') is left as written: no #Jaipur, no reporter_policy, footer by the story", () => {
    const { d } = draft(fileFor("RITURAJ"), ["#BJP: प्रदेश कार्यकारिणी की बैठक", "नेताओं ने भाग लिया"]);
    expect(d.bodyText.startsWith("#BJP: ")).toBe(true);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(d.districtSource).toBeNull();
    expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
    const nws = composeBreaking({ headline: "#BJP: दिल्ली में बैठक", points: ["नेताओं ने भाग लिया"], district: null, town: null, rajasthan: false, leaderPost: false, reporterToken: "RITURAJ" }, rules, book, { subjects, reporters, parties, beats });
    expect(nws.hashtags).toEqual([`#${BRAND_NATIONAL}`]);
    expect(nws.districtSource).toBeNull();
  });
  it("A3: a video-format breaking headline takes no leading tag; #Jaipur is offered, marked reporter_policy", () => {
    const { d } = draft(fileFor("RITURAJ"), ["नए दिशा-निर्देश जारी | Rajasthan News", "सभी विभागों को आदेश"]);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.hashtagSuggestions[0]).toBe("#Jaipur");
    expect(d.hashtagSuggestionItems[0]).toMatchObject({ tag: "#Jaipur", source: "reporter_policy" });
    expect(d.districtSource).toBeNull();
    expect(d.proposals.filter((p) => p.source === "reporter_policy")).toEqual([expect.objectContaining({ item: "#Jaipur", layer: "suggest" })]);
  });
  it("A4: a place the desk wrote before the colon that Socia does not know ('आकोला: ...') stays as written: no #Jaipur", () => {
    const lines = ["आकोला: पंचायत समिति की बैठक", "विकास कार्यों पर चर्चा"];
    const { d } = draft(fileFor("RITURAJ"), lines);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(d.bodyText).toContain("आकोला");
    // The desk's place stands: nothing from the reporter's rule anywhere, and the footer is the story's own
    expect(d.districtSource).toBeNull();
    expect(d.proposals.some((p) => p.source === "reporter_policy")).toBe(false);
    expect(d.hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(d.hashtags).toEqual(draft(fileFor("NARESH"), lines).d.hashtags);
  });
  it("a policy district the places file does not know is not applied, and the draft says why", () => {
    const r = parseReporterHandles({ version: 1, entries: [{ handle: "@rituraj9999", names_en: ["RITURAJ"], verified: true, policy: { district_when_missing: "Jaipurr" } }] });
    const d = composeBreaking({ headline: "सरकार ने जारी किए नए दिशा-निर्देश", points: ["सभी विभागों को भेजे गए आदेश"], district: null, town: null, rajasthan: true, leaderPost: false, reporterToken: "RITURAJ" }, rules, book, { reporters: r });
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.warnings.join(" ")).toMatch(/Jaipurr.*not a district/);
  });
  it("13. a reporter without a policy block, no district: nothing in line 1 (V7 unchanged)", () => {
    const { d } = draft(fileFor("NARESH"), NONE);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.districtSource).toBeNull();
  });
  it("the policy is opt-in per reporter: rituraj alone carries one", () => {
    expect([...reporters.profiles!.values()].filter((p) => p.districtWhenMissing).map((p) => p.handle)).toEqual(["rituraj9999"]);
    expect(reporterProfile(reporters, reporters.byToken.get("RITURAJ"))?.districtWhenMissing).toBe("Jaipur");
  });
});

// ─── Step 6: CM without a name ───────────────────────────────────────────────

describe("Step 6: an office named without its holder", () => {
  const cm = subjects.offices!.find((o) => o.key === "rajasthan_cm")!;
  it("15. the State Hangar post offers @BhajanlalBjp and @RajCMO, tags neither", () => {
    const { d } = draft(fileFor(null, "JPR3"), [
      "State Hanger पर नए भवन के भूमि पूजन कार्यक्रम की झलकी", "संभवतया पहली बार हुआ, Airport पर हुआ हवन का भी, CM ने भी स्वयं दी आहुतियां",
    ]);
    expect(d.mentions).not.toContain("@BhajanlalBjp");
    expect(d.mentions).not.toContain("@RajCMO");
    expect(suggested(d, "office")).toEqual(["BhajanlalBjp", "RajCMO"]);
    expect(d.handleSuggestions.find((h) => h.reason === "office")).toMatchObject({ source: "office_alias.rajasthan_cm", detail: "CM mentioned without a name" });
    // RajGov comes from the reporter prior only: this file names no reporter
    expect(all(d)).not.toContain("rajgovofficial");
  });
  it("16–18. a former CM, another state's CM, the CMHO: no CM", () => {
    expect(namesOffice(cm, "पूर्व मुख्यमंत्री अशोक गहलोत ने साधा निशाना")).toBe(false);
    expect(namesOffice(cm, "दिल्ली की मुख्यमंत्री रेखा गुप्ता पहुंचीं जयपुर")).toBe(false);
    expect(namesOffice(cm, "CMHO ने जांच के आदेश दिए")).toBe(false);
    expect(namesOffice(cm, "CMO से आया फोन")).toBe(false);
    expect(namesOffice(cm, "उपमुख्यमंत्री दिया कुमारी ने किया दौरा")).toBe(false);
    expect(namesOffice(cm, "डिप्टी सीएम ने किया दौरा")).toBe(false);
    expect(namesOffice(cm, "CM ने भी स्वयं दी आहुतियां")).toBe(true);
    expect(namesOffice(cm, "सीएम ने की समीक्षा बैठक")).toBe(true);
    for (const h of ["पूर्व मुख्यमंत्री अशोक गहलोत ने साधा निशाना", "दिल्ली की मुख्यमंत्री रेखा गुप्ता पहुंचीं जयपुर", "CMHO ने जांच के आदेश दिए"]) {
      const { d } = draft(fileFor(null, "JPR3"), [h, "मामले में आगे की कार्रवाई जारी"]);
      expect(suggested(d, "office"), h).toEqual([]);
    }
  });
  it("an exclusion in ANOTHER sentence does not stop it", () => {
    expect(namesOffice(cm, "पूर्व सरपंच ने की शिकायत। CM ने दिए जांच के निर्देश")).toBe(true);
  });
  it("19. 'मुख्यमंत्री भजनलाल शर्मा': exactly one @BhajanlalBjp, from the name match", () => {
    const { d } = draft(fileFor(null, "JPR3"), ["मुख्यमंत्री भजनलाल शर्मा ने किया शिलान्यास", "विकास कार्यों की दी सौगात"]);
    expect(all(d).filter((h) => h === "bhajanlalbjp")).toHaveLength(1);
    expect(suggested(d, "office")).toEqual([]);
  });
  it("outside Rajasthan: nothing", () => {
    const d = composeBreaking({ headline: "CM ने किया दौरा", points: ["बाढ़ प्रभावित इलाकों का जायजा"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, { subjects, reporters, parties });
    expect(suggested(d, "office")).toEqual([]);
  });
  it("an office handle not in the file fails it", () => {
    const json = cfg("subject-handles.json");
    expect(() => parseSubjectHandles({ ...json, offices: { rajasthan_cm: { aliases_en: ["CM"], handles: ["@NotAnEntry"] } } })).toThrow(DataFileRejected);
  });
});

// ─── review fixes (13 Nov): CM alias exclusions ──────────────────────────────

describe("B1–B3: the CM alias and its exclusions", () => {
  const cm = subjects.offices!.find((o) => o.key === "rajasthan_cm")!;
  it("B1: an abbreviation's dot does not end the sentence, so the exclusion still applies", () => {
    expect(namesOffice(cm, "मुख्यमंत्री डॉ. मोहन यादव ने किया दौरा")).toBe(false);
    expect(namesOffice(cm, "CM Dr. Mohan Yadav reached Ujjain")).toBe(false);
    expect(namesOffice(cm, "पूर्व विधायक श्री. रामलाल ने CM से की मुलाकात")).toBe(false);
    // A real full stop still ends a sentence
    expect(namesOffice(cm, "Former sarpanch complained. CM ordered a probe")).toBe(true);
  });
  it("B2: English exclusions, without case", () => {
    for (const t of ["UP CM Yogi inaugurated the expressway", "Delhi CM Rekha Gupta reached Jaipur", "Former CM Gehlot attacked the government", "FORMER CM spoke", "Deputy CM visited", "Bihar CM Nitish met the PM"]) {
      expect(namesOffice(cm, t), t).toBe(false);
    }
    expect(namesOffice(cm, "CM inaugurated the new hospital")).toBe(true);
  });
  it("B3: the other states, in Hindi and English", () => {
    for (const t of ["गोवा के मुख्यमंत्री ने", "मप्र के सीएम ने की घोषणा", "छत्तीसगढ़ के मुख्यमंत्री पहुंचे", "Karnataka CM met the delegation", "असम के CM ने कहा"]) {
      expect(namesOffice(cm, t), t).toBe(false);
    }
  });
  it("B3: 'MP' blocks only beside the CM word — 'MP CM', 'MP के मुख्यमंत्री'; an MP (सांसद) meeting the CM still offers the CM", () => {
    for (const t of ["MP CM ने किया शुभारंभ", "MP के मुख्यमंत्री ने कहा", "MP के CM पहुंचे", "UP के सीएम ने कहा"]) expect(namesOffice(cm, t), t).toBe(false);
    for (const t of ["MP ने CM से मुलाकात की", "सांसद/MP ने CM से मुलाकात की"]) expect(namesOffice(cm, t), t).toBe(true);
    const { d } = draft(fileFor(null, "JPR3"), ["MP ने CM से मुलाकात की", "क्षेत्र की समस्याओं से अवगत कराया"]);
    expect(suggested(d, "office")).toEqual(["BhajanlalBjp", "RajCMO"]);
  });
  it("the alias itself stays case-sensitive: 'cm' (centimetres) is not the CM", () => {
    expect(namesOffice(cm, "बारिश 5 cm दर्ज की गई")).toBe(false);
  });
});

// ─── review fixes (13 Nov): beats and reporter config ────────────────────────

describe("C1–C6: what a reporter's suggestions may carry", () => {
  const nirmal = profileOf("Nirmaltiwaribki")!;
  it("C1: declared beats only when beats_source is 'desk' ('observed' or missing: no beat suggestion)", () => {
    const text = "पर्यटन विभाग की नई योजना";
    expect(reporterPrior({ profile: nirmal, text, taken: new Set(), takenTags: new Set(), districtBound, directory }, reporters, beats).handles.map((h) => h.handle)).toContain("KumariDiya");
    for (const beatsSource of ["observed", null] as const) {
      const p = { ...nirmal, beatsSource };
      expect(reporterPrior({ profile: p, text, taken: new Set(), takenTags: new Set(), districtBound, directory }, reporters, beats).handles.filter((h) => h.reason === "beat"), String(beatsSource)).toEqual([]);
    }
  });
  it("C2: a forbidden beat under another spelling, or any beat listing a CM or state-government handle, fails the file", () => {
    for (const key of ["state_government", "State Government", "chief_minister", "CMO", "Chief-Minister"]) {
      expect(() => parseBeatHandles({ [key]: { keywords: "सरकार", handles: ["@rajeduofficial"] } }, directory), key).toThrow(DataFileRejected);
    }
    for (const h of ["@BhajanlalBjp", "@RajCMO", "@RajGovOfficial"]) {
      expect(() => parseBeatHandles({ politics: { keywords: "राजनीति", handles: [h] } }, directory), h).toThrow(/CM or state-government/);
    }
  });
  it("C2: beat keys are compared without case; two spellings of one key fail the file", () => {
    const b = parseBeatHandles({ Education: { keywords: "स्कूल", handles: ["@rajeduofficial"] } }, directory);
    expect([...b.beats.keys()]).toEqual(["education"]);
    expect(() => parseBeatHandles({ Education: { keywords: "स्कूल", handles: ["@rajeduofficial"] }, education: { keywords: "स्कूल", handles: ["@rajeduofficial"] } }, directory)).toThrow(/listed twice/);
  });
  it("C3: a police or collector handle, verified or not, fails a beat file and never comes from the measured prior", () => {
    const unverified = parseHandleRules({ version: 1, districts: { Salumbar: [{ handle: "@DMSalumbar", role: "collector", verified: false }] } });
    expect(unverified.bound!.has("dmsalumbar")).toBe(true);
    const dir = new Set([...directory, "dmsalumbar"]);
    expect(() => parseBeatHandles({ admin: { keywords: "प्रशासन", handles: ["@DMSalumbar"] } }, dir, { bound: unverified.bound! })).toThrow(/police, collector/);
    // At load: a prior naming one fails the reporters file
    const entry = { handle: "@a_rep", names_en: ["A_REP"], verified: true, prior: { n: 50, handles: { DMSalumbar: 0.9 } } };
    expect(() => parseReporterHandles({ version: 1, entries: [entry] }, undefined, { bound: unverified.bound! })).toThrow(DataFileRejected);
    // At compose: filtered even when the file was never checked
    const fake = { ...profileOf("rituraj9999")!, prior: { n: 100, handles: { DMSalumbar: 0.9 }, hashtags: {}, source: null } };
    expect(reporterPrior({ profile: fake, text: "", taken: new Set(), takenTags: new Set(), districtBound: unverified.bound!, directory: dir }, reporters, beats).handles).toEqual([]);
  });
  it("C4: a keyword pattern that matches empty text fails the file", () => {
    expect(() => parseBeatHandles({ education: { keywords: "स्कूल|", handles: ["@rajeduofficial"] } }, directory)).toThrow(/matches empty text/);
  });
  it("C5: a bad prior or prior settings fail the reporters file loudly", () => {
    const base = { handle: "@a_rep", names_en: ["A_REP"], verified: true };
    for (const prior of [{ n: 50, handles: { RajGovOfficial: 1.5 } }, { n: Number.NaN }, { n: "50" }, { n: 50, handles: { NotAHandleAnywhere: 0.5 } }]) {
      expect(() => parseReporterHandles({ version: 1, entries: [{ ...base, prior }] }, undefined, { directory }), JSON.stringify(prior)).toThrow(DataFileRejected);
    }
    expect(() => parseReporterHandles({ version: 1, prior_settings: "m=20", entries: [base] })).toThrow(DataFileRejected);
    expect(() => parseReporterHandles({ version: 1, prior_settings: { min_score: 2 }, entries: [base] })).toThrow(DataFileRejected);
    expect(() => parseReporterHandles({ version: 1, ambiguous_tokens: "DINESH", entries: [base] })).toThrow(DataFileRejected);
    const problems: string[] = [];
    parseReporterHandles({ version: 1, entries: [{ ...base, beats: ["education"], beats_source: "desk-ish" }] }, (m) => problems.push(m));
    expect(problems.join(" ")).toMatch(/beats_source "desk-ish"/);
    // The prior's records cannot be polluted through their keys
    const r = parseReporterHandles({ version: 1, entries: [{ ...base, prior: { n: 50, handles: JSON.parse('{"__proto__": 0.5}') } }] });
    expect(Object.getPrototypeOf(r.profiles!.get("a_rep")!.prior!.handles)).toBeNull();
  });
  it("C5: a desk-declared beat with no key in beat-handles.json is a warning, not a rejection", () => {
    const problems: string[] = [];
    parseBeatHandles(cfg("beat-handles.json"), directory, { reporters, problem: (m) => problems.push(m) });
    expect(problems.join(" ")).toMatch(/"mining", which beat-handles.json has no key for/);
  });
  it("C6: an empty or missing directory allows NOTHING, and says so", () => {
    for (const dir of [new Set<string>(), undefined, null]) {
      const out = reporterPrior({ profile: profileOf("DineshKasana15"), text: "JDA ने हटाए अतिक्रमण", taken: new Set(), takenTags: new Set(), districtBound, directory: dir }, reporters, beats);
      expect(out.handles).toEqual([]);
      expect(out.warnings.join(" ")).toMatch(/fail closed/);
    }
  });
  it("equal scores are ordered by handle name, whatever the file's key order", () => {
    const p = (handles: Record<string, number>) => ({ ...profileOf("rituraj9999")!, prior: { n: 100, handles, hashtags: {}, source: null } });
    const run = (handles: Record<string, number>) => reporterPrior({ profile: p(handles), text: "", taken: new Set(), takenTags: new Set(), districtBound, directory }, reporters, beats).handles.map((h) => h.handle);
    expect(run({ BJP4Rajasthan: 0.6, BhajanlalBjp: 0.6 })).toEqual(run({ BhajanlalBjp: 0.6, BJP4Rajasthan: 0.6 }));
    expect(run({ BJP4Rajasthan: 0.6, BhajanlalBjp: 0.6 })).toHaveLength(2);
  });
  it("tags are offered once, compared without case", () => {
    const { d } = draft(fileFor("RITURAJ"), ["सरकार ने जारी किए नए दिशा-निर्देश", "सभी विभागों को भेजे गए आदेश"]);
    const lower = d.hashtagSuggestions.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });
});
