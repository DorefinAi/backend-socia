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
  const TABLE: [string, [string, number][]][] = [
    ["rituraj9999", [["RajGovOfficial", 0.53]]],
    ["ml_vikas", [["RajGovOfficial", 0.48]]],
    ["DineshKasana15", [["RajGovOfficial", 0.43]]],
    ["Nirmaltiwaribki", [["RajGovOfficial", 0.43]]],
    ["parmarshivendra", [["RajGovOfficial", 0.27]]],
    ["aishwaryam99", [["BhajanlalBjp", 0.54], ["BJP4Rajasthan", 0.35]]],
    ["yogesh2727sh1", [["BJP4Rajasthan", 0.39]]],
  ];
  for (const [who, fires] of TABLE) {
    it(`${who} → ${fires.map(([h, s]) => `@${h} ${s}`).join(", ")}`, () => {
      const out = priorOf(who).handles;
      expect(out.map((h) => h.handle)).toEqual(fires.map(([h]) => h));
      out.forEach((h, i) => {
        // The brief's table truncates (parmarshivendra 0.2751 is printed 0.27)
        expect(Math.abs(h.score! - fires[i]![1])).toBeLessThan(0.011);
        expect(h).toMatchObject({ reason: "prior", source: "reporter_prior" });
        expect(h.n).toBe(profileOf(who)!.prior!.n);
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
  it(`over ${posts.length} fixture posts${extra.length ? ` + ${extra.length} from oct30` : ""}, for ${TOKENS.length} file-name reporters`, () => {
    expect(corpus.length).toBeGreaterThan(0);
    let compared = 0;
    for (const text of corpus) {
      const s = segmentPost(text);
      if (!s.headline) continue;
      for (const token of TOKENS) {
        const input = { headline: s.headline, points: s.points, district: null, town: null, rajasthan: true, leaderPost: false, reporterToken: token };
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
  it("…but when the places file DOES place it (पंचायत समिति बिलाड़ा → Jodhpur) the post resolves, and the policy stays out", () => {
    // "It must never override a district that resolves from the post itself" (§4.2): the gazetteer's Jodhpur is
    // offered, as any inferred district is, and line 1 carries nothing
    const { d } = draft(fileFor("RITURAJ"), ["पंचायत समिति बिलाड़ा की ग्राम पंचायत भावी में पुनर्मतदान", "मतपत्र चोरी के चलते फैसला"]);
    expect(d.bodyText.startsWith("#")).toBe(false);
    expect(d.hashtagSuggestions[0]).toBe("#Jodhpur");
  });
  it("12. a post that already names Kota keeps Kota; no #Jaipur", () => {
    const { d } = draft(fileFor("RITURAJ", "KTA4"), NONE);
    expect(d.bodyText.startsWith("#Kota: ")).toBe(true);
    expect(d.bodyText).not.toContain("#Jaipur");
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
  });
  it("a district the headline infers resolves the post too: no policy over it", () => {
    const { d } = draft(fileFor("RITURAJ"), ["डूंगरपुर में ACB कार्रवाई", "प्रभारी को रिश्वत लेते दबोचा"]);
    expect(d.bodyText.startsWith("#Jaipur")).toBe(false);
    expect(d.districtSource).toBeNull();
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
