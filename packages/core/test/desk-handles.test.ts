// Handles the desk adds from a post's tag line: the keywords found inside a new handle, and suggesting it later.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_HANDLE_RULES, PlaceBook, composeBreaking, deskHandleKeywords, deskHandleRules, districtKeywordCandidates, editDistance, fileLookalike,
  handleMarkers, handlePieces, jaroWinkler, keywordsForHandle, matchHandleKeywords, parseHandleRules, parsePlacesData, parseSubjectHandles,
  pickHandles, subjectKeywordCandidates,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const subjectsFile = json("../../../apps/worker/config/subject-handles.json");
const candidates = [...districtKeywordCandidates(), ...subjectKeywordCandidates(subjectsFile)];
const kw = (handle: string) => keywordsForHandle(handle, candidates);
const districtFile = json("../../../apps/worker/config/district-handles.json");
/** Every handle of both files, verified or not */
const fileHandles = [...parseHandleRules(districtFile).all!, ...parseSubjectHandles(subjectsFile).handles!];
const safe = (handle: string) => deskHandleKeywords(handle, { candidates, fileHandles });

describe("which desk-added handles get no keywords (never auto-suggested)", () => {
  it("knows every handle of both files, verified or not, any kind", () => {
    expect(fileHandles).toContain("dmsalumbar"); // verified: false in district-handles.json
    expect(fileHandles).toContain("acbrajasthan"); // unverified subject
    expect(fileHandles).toContain("bjp4rajasthan"); // a party entry
    expect(fileHandles).toContain("jhalawarpolice");
  });

  it("gives party handles none", () => {
    for (const h of ["@BJP4Jhalawar", "@KotaCongress", "@INCJaipur", "@bjpjaipur", "@Jaipur_AAP", "@RLP_Nagaur", "@NSUIKota"]) {
      expect(safe(h).keywords, h).toEqual([]);
      expect(["party", "lookalike"], h).toContain(safe(h).withheld); // a lookalike of a file handle is checked first
      expect(handleMarkers(h, ["jhalawar", "kota", "jaipur", "nagaur"]).party, h).toBe(true);
    }
    expect(safe("@BJP4Jhalawar").withheld).toBe("party");
  });

  it("gives officials' handles none: police and administration are the files' job", () => {
    for (const h of ["@SPJhalawarCity", "@spjhalawarcity", "@SikarPoliceHQ", "@DcDmKotaNew", "@CollectorTonkOffice", "@IGRangeKota", "@ThanaBundiCity", "@SHO_Nagaur"]) {
      expect(safe(h).keywords, h).toEqual([]);
      expect(["official", "lookalike"], h).toContain(safe(h).withheld);
      expect(handleMarkers(h, ["jhalawar", "kota", "tonk", "bundi", "nagaur", "sikar"]).official, h).toBe(true);
    }
    expect(safe("@CollectorTonkOffice").withheld).toBe("official");
    expect(handleMarkers("spjhalawarcity", ["jhalawar"])).toEqual({ party: false, official: true }); // what is left: "sp", "city"
    expect(handleMarkers("@JhalawarUpdates", ["jhalawar"])).toEqual({ party: false, official: false });
  });

  it("gives the files' own handles, verified or not, and their lookalikes none", () => {
    expect(safe("@DMSalumbar").withheld).toBe("file_handle");
    expect(safe("@AcbRajasthan").withheld).toBe("file_handle");
    expect(safe("@iitjodhpur").withheld).toBe("file_handle");
    expect(safe("@RuhsJaipur").withheld).toBe("file_handle");
    expect(safe("@jdajaipur").withheld).toBe("file_handle");
    expect(safe("@JHALAWARPOLICE").withheld).toBe("file_handle");
    expect(safe("@JhalawarPolic").withheld).toBe("lookalike"); // one letter off
    expect(safe("@SPJhalawar").withheld).toBe("lookalike"); // two letters from @DmJhalawar
    expect(fileLookalike("@CP_Jodhpurr", fileHandles)).toBe("cp_jodhpur");
    expect(fileLookalike("@JhalawarUpdates", fileHandles)).toBeNull();
    expect(editDistance("cp_jodhpur", "cp_jodhpru")).toBe(1); // a swap is one edit
  });

  it("takes only verified, non-party subjects as names", () => {
    const latin = subjectKeywordCandidates(subjectsFile).map((c) => c.latin);
    expect(latin).toContain("RPSC");
    expect(latin).not.toContain("ACB Rajasthan"); // unverified
    expect(latin).not.toContain("IIT Jodhpur"); // unverified
    expect(latin).not.toContain("BJP Rajasthan"); // party
  });

  it("gives a subject's or institution's handle its name, not also the district in it", () => {
    expect(safe("@RPSC_Ajmer")).toEqual({ keywords: ["RPSC", "आरपीएससी", "राजस्थान लोक सेवा आयोग"], withheld: null });
    expect(kw("@RPSC_Ajmer")).toContain("Ajmer"); // the raw matcher still sees it
  });

  it("still gives an ordinary local handle its place", () => {
    expect(safe("@JhalawarUpdates")).toEqual({ keywords: ["Jhalawar", "झालावाड़", "झालावाड"], withheld: null });
    expect(safe("@KotaNewsDesk").keywords).toEqual(["Kota", "कोटा"]);
    expect(safe("@SawaiMadhopurNews").keywords).toEqual(["Sawai Madhopur", "सवाई माधोपुर"]);
    expect(safe("@RandomGuy123")).toEqual({ keywords: [], withheld: null });
  });

  it("catches impostors of file handles, not ordinary local news handles (real files)", () => {
    // Local news handles that only resemble "<District>Police": their district, not "lookalike"
    expect(safe("@TonkLive")).toEqual({ keywords: ["Tonk", "टोंक"], withheld: null });
    expect(safe("@Bundi_Live").keywords[0]).toBe("Bundi");
    expect(safe("@UdaipurPost")).toEqual({ keywords: ["Udaipur", "उदयपुर"], withheld: null });
    expect(safe("@JhalawarUpdates").keywords[0]).toBe("Jhalawar");
    expect(safe("@KotaNewsDesk").keywords[0]).toBe("Kota");
    for (const h of ["@TonkLive", "@Bundi_Live", "@UdaipurPost", "@JhalawarUpdates", "@KotaNewsDesk"]) expect(safe(h).withheld, h).toBeNull();
    // Withheld, by one guard or another
    for (const h of ["@SPJhalawar", "@spjhalawar", "@JhalawarPolic", "@DmJhalawr", "@BJP4Jhalawar", "@DMSalumbar", "@AAPRajasthan"]) {
      expect(safe(h).keywords, h).toEqual([]);
      expect(safe(h).withheld, h).not.toBeNull();
    }
    expect(safe("@DmJhalawr").withheld).toBe("lookalike"); // one letter from @DmJhalawar
    expect(safe("@JhalawarPolic").withheld).toBe("lookalike");
  });
});

describe("keywords inside a new handle", () => {
  it("splits a handle on digits and joins case changes and underscores", () => {
    const pieces = (h: string) => handlePieces(h).map((p) => ({ text: p.text, edges: [...p.edges] }));
    expect(pieces("@CP_Jodhpur")).toEqual([{ text: "cpjodhpur", edges: [0, 2, 9] }]);
    expect(pieces("@Jaipur1stIndia")).toEqual([{ text: "jaipur", edges: [0, 6] }, { text: "stindia", edges: [0, 2, 7] }]);
    expect(pieces("SPJhalawarCity")).toEqual([{ text: "spjhalawarcity", edges: [0, 2, 10, 14] }]);
  });

  it("finds a district in the handle and stores its English and Hindi names", () => {
    expect(kw("@JhalawarPolice")).toEqual(["Jhalawar", "झालावाड़", "झालावाड"]);
    expect(kw("@CP_Jodhpur").slice(0, 2)).toEqual(["Jodhpur", "जोधपुर"]);
    expect(kw("@SawaiMadhopurPolice")).toEqual(["Sawai Madhopur", "सवाई माधोपुर"]);
    expect(kw("@sp_kota")).toEqual(["Kota", "कोटा"]);
    expect(kw("@Collectorjhalawar")[0]).toBe("Jhalawar");
  });

  it("gives a handle with no known name no keywords", () => {
    expect(kw("@RandomGuy123")).toEqual([]);
    expect(kw("@x")).toEqual([]);
    expect(kw("@_")).toEqual([]);
  });

  it("forgives one letter in a long name, never in a short one", () => {
    expect(kw("@SawaiMadhopr")[0]).toBe("Sawai Madhopur"); // a letter missing
    expect(kw("@SawaiMadhupurPolice")[0]).toBe("Sawai Madhopur"); // a letter wrong
    expect(kw("@ChittorgadhSP")[0]).toBe("Chittorgarh");
    expect(kw("@HanumangarhhPolice")[0]).toBe("Hanumangarh"); // a letter extra
    expect(kw("@KotxPolice")).toEqual([]); // Kota: 4 letters, exact only
    expect(kw("@JodhpurrCity")[0]).toBe("Jodhpur"); // the exact name is inside, the extra letter is outside it
    expect(kw("@JodhparCity")).toEqual([]); // Jodhpur with a wrong letter: too short to forgive
    expect(kw("@JaipurCity")[0]).toBe("Jaipur");
    expect(kw("@JaipirCity")).toEqual([]);
  });

  it("needs a short name (under 6 letters) to touch a word edge; never takes a long one's near miss from mid-word", () => {
    expect(kw("@OnlineKanhaiya")).toEqual([]); // not NHAI
    expect(kw("@spalika")).toEqual([]); // not Pali
    expect(kw("@uniofkota")).toEqual(["Kota", "कोटा"]); // the handle's end is an edge
    expect(kw("@thejaipurtimes")[0]).toBe("Jaipur"); // 6 letters: anywhere
    expect(kw("@PoliceRajasthan")).toEqual([]); // not "CEO Rajasthan" (cerajasthan)
    expect(kw("@SawaiMadhopurPolice")).not.toContain("Dholpur"); // not "dhopur"
  });

  it("ignores names shorter than 4 letters (PMO, MHA, JDA) and short noise", () => {
    expect(kw("@PMOfficial")).toEqual([]);
    expect(kw("@JDAupdates")).toEqual([]);
    expect(kw("@MHAnews")).toEqual([]);
    expect(kw("@Kot")).toEqual([]);
    expect(kw("@Pal")).toEqual([]);
  });

  it("finds subjects' English names and brings their Hindi spellings; never a party", () => {
    const rpsc = kw("@RPSC_Ajmer");
    expect(rpsc).toContain("RPSC");
    expect(rpsc).toContain("Ajmer");
    expect(rpsc).toContain("अजमेर");
    expect(kw("@BJPRajasthanTeam")).not.toContain("BJP Rajasthan");
  });

  it("puts the best, longest match first and lists each keyword once", () => {
    const m = matchHandleKeywords("@ChittorgarhPolice", candidates);
    expect(m[0]!.latin).toBe("Chittorgarh");
    const k = kw("@ChittorgarhPolice");
    expect(k[0]).toBe("Chittorgarh");
    expect(new Set(k.map((x) => x.toLowerCase())).size).toBe(k.length);
  });

  it("scores with Jaro-Winkler", () => {
    expect(jaroWinkler("kota", "kota")).toBe(1);
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });
});

describe("suggesting desk-added handles", () => {
  const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
  const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
  const subjects = parseSubjectHandles(subjectsFile);
  const desk = deskHandleRules([
    { handle: "@JhalawarUpdates", entityName: "Jhalawar", aliases: ["Jhalawar", "झालावाड़", "झालावाड"] },
    { handle: "RandomGuy123", entityName: "RandomGuy123", aliases: [] },
    { handle: "@KotaNewsDesk", entityName: "Kota", aliases: ["Kota", "कोटा"] },
    // Rows that should never have got keywords (set some other way): officials' and parties' handles are left out
    { handle: "@CP_Jodhpur", entityName: "Jodhpur", aliases: ["Jodhpur", "जोधपुर"] },
    { handle: "@jhalawarpolice", entityName: "Jhalawar", aliases: ["Jhalawar", "झालावाड़"] },
    { handle: "@BJP4Kota", entityName: "Kota", aliases: ["Kota", "कोटा"] },
    // The files' own handles (an unverified subject) and lookalikes of them: kept here, skipped by pickHandles
    { handle: "@iitjodhpur", entityName: "Jodhpur", aliases: ["Jodhpur", "जोधपुर"] },
    { handle: "@JhalawarPolic", entityName: "Jhalawar", aliases: ["Jhalawar", "झालावाड़"] },
  ]);
  const story = (headline: string, points: string[] = [], district: string | null = null) => ({ headline, points, district, rajasthan: true, leaderPost: false });
  const handles = (headline: string, points: string[] = [], district: string | null = null) =>
    pickHandles(story(headline, points, district), rules, { subjects, desk }).map((h) => h.handle);

  it("leaves out rows with no keywords and officials' and parties' rows", () => {
    expect(desk.count).toBe(4);
  });

  it("suggests a Jhalawar desk handle on a Jhalawar story, not on a Kota story", () => {
    expect(handles("झालावाड़ में तेज बारिश से नदी उफान पर")).toEqual(["JhalawarUpdates"]);
    expect(handles("तेज बारिश", ["झालावाड में स्कूल बंद"])).toEqual(["JhalawarUpdates"]);
    expect(handles("Heavy rain in Jhalawar")).toEqual(["JhalawarUpdates"]);
    expect(handles("कोटा में तेज बारिश से नदी उफान पर")).toEqual(["KotaNewsDesk"]);
    expect(handles("जयपुर में तेज बारिश")).toEqual([]);
    // Not an incident headline: on those the district police stand alone and no desk handle joins them
    const pick = pickHandles(story("झालावाड़ में तेज बारिश"), rules, { subjects, desk })[0];
    expect(pick).toEqual({ handle: "JhalawarUpdates", reason: "desk", title: "Jhalawar" });
  });

  it("never suggests a desk copy of a handle the files govern", () => {
    expect(handles("जोधपुर में तेज बारिश")).toEqual([]); // not @CP_Jodhpur, not @iitjodhpur
    expect(handles("झालावाड़ में तेज बारिश")).toEqual(["JhalawarUpdates"]); // not @jhalawarpolice, not @JhalawarPolic
    expect(handles("कोटा में तेज बारिश")).toEqual(["KotaNewsDesk"]); // not @BJP4Kota
    expect(handles("झालावाड़ पुलिस ने चोर पकड़ा", [], "Jhalawar")).toEqual(["JhalawarPolice", "JhalawarUpdates"]); // the file's rule, then the desk's
  });

  it("puts desk handles after the file rules, within the cap of 3, each once", () => {
    // Political copy: the leader, then the desk's own handle. No state-government pick — on political
    // copy the state government is not a party to the story
    expect(handles("मुख्यमंत्री भजनलाल शर्मा ने झालावाड़ में किया लोकार्पण, राज्य सरकार का बड़ा फैसला")).toEqual(["BhajanlalBjp", "JhalawarUpdates"]);
    // An incident is exclusive: the district police stand alone, and no desk handle joins them
    expect(handles("झालावाड़ में चोरी", ["पुलिस ने आरोपी को पकड़ा"], "Jaipur")).toEqual(["jaipur_police"]);
    // Two desk handles, headline first
    expect(handles("झालावाड़ और कोटा में बारिश")).toEqual(["JhalawarUpdates", "KotaNewsDesk"]);
    expect(handles("कोटा में बारिश", ["झालावाड़ में भी"])).toEqual(["KotaNewsDesk", "JhalawarUpdates"]);
    expect(handles("झालावाड़ झालावाड़ कोटा कोटा")).toEqual(["JhalawarUpdates", "KotaNewsDesk"]);
  });

  it("keeps the gates: a leader's own post and news outside Rajasthan tag nobody", () => {
    // Campaign copy is no longer a blanket gate — it is political, so the desk's own local handle rides
    // along. What stays barred there is a police handle or a collector beside a party.
    expect(handles("झालावाड़ में भाजपा प्रत्याशी की रैली")).toEqual(["JhalawarUpdates"]);
    expect(pickHandles({ ...story("झालावाड़ में बारिश"), leaderPost: true }, rules, { subjects, desk })).toEqual([]);
    expect(pickHandles({ ...story("झालावाड़ में बारिश"), rajasthan: false }, rules, { subjects, desk })).toEqual([]);
  });

  it("reaches the composed post's mentions", () => {
    const d = composeBreaking({ ...story("झालावाड़ में तेज बारिश से नदी उफान पर", ["स्कूलों में छुट्टी"], "Jhalawar"), town: null }, EMPTY_HANDLE_RULES, book, { desk });
    expect(d.mentions).toEqual(["@JhalawarUpdates"]);
    expect(d.handles[0]?.reason).toBe("desk");
    const none = composeBreaking({ ...story("झालावाड़ में तेज बारिश"), town: null }, EMPTY_HANDLE_RULES, book);
    expect(none.mentions).toEqual([]);
  });
});
