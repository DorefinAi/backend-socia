// Place, heading and card fixes of 25 Nov 2026 (owner-approved): national detection (P3), merged districts' desk tags
// (P5), one place rule for the caption and the card (P6/P10), two-line files and desk instructions (P8), file codes (P9)
// and statewide list stories (P11). Cases from the desk's posts of 15–24 Nov (minimal snippets, no full files).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_RAJASTHAN, PlaceBook, composeBreaking, isRajasthanStory, parseBreaking, pickReporter, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData,
  parseReporterHandles, parseSubjectHandles, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const opts = {
  subjects: parseSubjectHandles(cfg("subject-handles.json")), reporters, parties: parsePartyHandles(cfg("party-handles.json")),
  normaliser: parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag)),
};
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_24NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;
function draft(name: string, lines: string[]): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, opts);
}
const line1 = (d: BreakingDraft) => d.bodyText.split("\n")[0]!;
const police = (d: BreakingDraft) => d.handles.filter((h) => h.reason === "police");
const POINTS = ["पुलिस मौके पर पहुंची", "मामले की जांच शुरू"];

describe("P5: a merged district's desk tag", () => {
  it("Khairthal-Tijara: '#Khairthal: …', never '#KhairthalTijara #खैरथल:' (the desk's own line 1)", () => {
    const d = draft(fileFor(null, "ALW15"), ["खैरथल से खबर", "कोटकासिम में पंचायत समिति सदस्य के अपहरण का मामला गर्माया", ...POINTS]);
    expect(line1(d)).toBe("#Khairthal: कोटकासिम में पंचायत समिति सदस्य के अपहरण का मामला गर्माया");
    expect(d.headingPlace).toMatchObject({ tags: ["#Khairthal"], district: "Khairthal-Tijara", town: null, placement: "lead" });
    // The handle lookup still keys on the district's own tag: its police are picked as before
    expect(police(d).length).toBeGreaterThan(0);
    expect(d.proposals.find((p) => p.item === "#Khairthal")).toMatchObject({ layer: "emit", source: "district.place_line" });
    expect(d.proposals.some((p) => p.item === "#खैरथल" || p.item === "#KhairthalTijara")).toBe(false);
  });

  it("Didwana-Kuchaman: '#Didwana: मकराना शहर के…' (desk)", () => {
    const d = draft(fileFor(null, "NGR11"), ["डीडवाना से खबर", "मकराना शहर के बाइपास आरओबी पर बाइक-बस की आमने-सामने हुई भिड़ंत", ...POINTS]);
    expect(line1(d)).toBe("#Didwana: मकराना शहर के बाइपास आरओबी पर बाइक-बस की आमने-सामने हुई भिड़ंत");
  });

  it("Kotputli-Behror: the owner's '#Kotputli-Behror', and either town it names takes no tag of its own", () => {
    for (const town of ["कोटपूतली", "बहरोड़"]) {
      const d = draft(fileFor(null), [`${town} से खबर`, "नीमराना में फैक्ट्री में लगी आग", ...POINTS]);
      expect(line1(d)).toBe("#Kotputli-Behror: नीमराना में फैक्ट्री में लगी आग");
      expect(d.headingPlace.tags).toEqual(["#Kotputli-Behror"]);
    }
  });

  it("any other town of the district keeps its own tag ('#Khairthal #तिजारा:')", () => {
    const d = draft(fileFor(null), ["तिजारा से खबर", "पंचायत समिति की बैठक में हंगामा", ...POINTS]);
    expect(line1(d)).toBe("#Khairthal #तिजारा: पंचायत समिति की बैठक में हंगामा");
  });

  it("a district's own tag elsewhere is unchanged ('#Jodhpur')", () => {
    const d = draft(fileFor(null), ["जोधपुर से खबर", "बासनी में फर्जी कॉल सेंटर पकड़ा", ...POINTS]);
    expect(line1(d)).toBe("#Jodhpur: बासनी में फर्जी कॉल सेंटर पकड़ा");
  });

  it("the desk tag reads back as its district ('#Khairthal', '#Kotputli-Behror')", () => {
    expect(book.hashtag("Khairthal")?.districts[0]?.name).toBe("Khairthal-Tijara");
    expect(book.hashtag("#Kotputli-Behror")?.districts[0]?.name).toBe("Kotputli-Behror");
    expect(book.hashtag("KhairthalTijara")?.districts[0]?.name).toBe("Khairthal-Tijara");
    expect(book.district("Khairthal-Tijara")).toMatchObject({ tag: "KhairthalTijara", deskTag: "Khairthal" });
  });

  it("a malformed desk tag is reported and ignored; the district stays", () => {
    const problems: string[] = [];
    const data = parsePlacesData({ version: 1, districts: [{ tag: "KhairthalTijara", desk_tag: "खैरथल", hi: ["खैरथल-तिजारा"], codes: [], towns: [] }] }, (m) => problems.push(m));
    expect(data.districts[0]).toMatchObject({ tag: "KhairthalTijara" });
    expect(data.districts[0]!.desk_tag).toBeUndefined();
    expect(problems.join(" ")).toMatch(/desk_tag/);
  });

  it(`still a Rajasthan story (${BRAND_RAJASTHAN})`, () => {
    const d = draft(fileFor(null), ["खैरथल से खबर", "कोटकासिम में बैठक", ...POINTS]);
    expect(d.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });
});

/** As the worker composes it: the brand from isRajasthanStory (stored district, else the text and the file's rules) */
function worker(name: string, lines: string[]): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  const rajasthan = isRajasthanStory(book, p.district, p.tags, [p.headline, p.points.join("\n")].join(" । "), pickReporter(slot.reporterToken, reporters).match?.districts);
  return composeBreaking({ ...p, rajasthan, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, opts);
}
const tagsOf = (d: BreakingDraft) => [...`${d.bodyText} ${d.hashtags.join(" ")}`.matchAll(/#([\p{L}\p{M}\p{N}_-]+)/gu)].map((m) => m[1]!);
const FLASH = (n: number) => `NAT_FLASH_RAJ_JPR_BREAKING_${n}_23NOV_US_CONTROL_tv_big.txt`;

describe("P3: national detection on every file; a file code never beats a named outside place", () => {
  it.each([
    ["Bhopal", ["भोपाल के ऐशबाग में बुलडोजर एक्शन जारी", "जनता क्वार्टर ध्वस्तीकरण की कार्रवाई जारी"], "#Bhopal"],
    ["Hyderabad", ["हैदराबाद में बम धमाके की धमकी से हड़कंप", "पुलिस ने बढ़ाई सुरक्षा, बम निरोधक दस्ते तैनात"], "#Hyderabad"],
    ["Delhi-NCR", ["दिल्ली-NCR में हवा की गुणवत्ता ‘बहुत खराब’ श्रेणी में दर्ज", "दिल्ली के कई इलाकों में AQI-400 के पार दर्ज"], "#Delhi"],
    ["Ayodhya", ["अयोध्या-जनकपुर के बीच सीधी ट्रेन सेवा शुरु", "PM मोदी और नेपाल के PM करेंगे वर्चुअल शुभारंभ"], "#Ayodhya"],
    ["Nepal", ["नेपाल पीएम बालेन शाह भारत दौरे पर", "पीएम मोदी और बालेन शाह के बीच महत्वपूर्ण बैठक", "हैदराबाद हाउस में चल रही महत्वपूर्ण बैठक"], null],
    ["Jamnagar (गुजरातः)", ["गुजरातः जामनगर में पुलिस टीम पर हमला", "नशे के खिलाफ कार्रवाई करने गई थी पुलिस टीम"], null],
    ["Red Fort (no place, the flash's own rule)", ["लाल किला ब्लास्ट मामला", "सुप्रीम कोर्ट ने खारिज की डिफ़ॉल्ट ज़मानत याचिका"], null],
  ])("NAT_FLASH_RAJ_JPR %s: #FirstIndiaNews, never #Jaipur, no Jaipur police", (_label, lines, city) => {
    const d = worker(FLASH(6030), lines as string[]);
    expect(d.hashtags[0]).toBe("#FirstIndiaNews");
    expect(tagsOf(d)).not.toContain("Jaipur");
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
    expect(d.mentions).not.toContain("@jaipur_police");
    if (city) expect(d.hashtags).toContain(city);
    else expect(d.cityFlag).toBe("national_story");
  });

  it("a state named (गुजरातः) is offered first, not carried; nothing Rajasthan is offered", () => {
    const jam = worker(FLASH(6007), ["गुजरातः जामनगर में पुलिस टीम पर हमला", "नशे के खिलाफ कार्रवाई करने गई थी पुलिस टीम"]);
    expect(jam.hashtagSuggestions[0]).toBe("#Gujarat");
    expect(jam.hashtags).toEqual(["#FirstIndiaNews"]);
  });

  it("the UP story from the TV desk: national, flagged 'national story', #UttarPradesh offered, no Jaipur/Delhi city pick", () => {
    const d = worker("btn_rj_breaking_24Nov_vks_1517_control_tv_big_breaking_full.txt", ["यूपी चुनाव को लेकर बड़ी खबर", "समाजवादी पार्टी ने 5 उम्मीदवारों का किया ऐलान"]);
    expect(d.hashtags).toEqual(["#FirstIndiaNews"]);
    expect(d.cityFlag).toBe("national_story");
    expect(d.hashtagSuggestions[0]).toBe("#UttarPradesh");
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
    expect(d.warnings.join(" ")).toMatch(/national story/);
    expect(d.warnings.join(" ")).not.toMatch(/pick one of the offered places/);
  });

  it("a reporter's JPR file naming only Delhi is national; one naming Delhi and राजस्थान stays Rajasthan", () => {
    const delhi = worker(fileFor("DINESH", "JPR"), ["दिल्ली में सोनिया गांधी की पुस्तक का लॉन्चिंग समारोह", "कई नेता रहे मौजूद"]);
    expect(delhi.hashtags).toEqual(["#FirstIndiaNews", "#Delhi"]);
    expect(tagsOf(delhi)).not.toContain("Jaipur");
    const raj = worker(fileFor("DINESH", "JPR"), ["दिल्ली में राजस्थान के सांसदों की बैठक", "कई नेता रहे मौजूद"]);
    expect(raj.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
    // Rajasthan's own house in Delhi is the state's news
    expect(worker(fileFor(null, "JPR"), ["दिल्ली के बीकानेर हाउस में बैठक", "कई नेता रहे मौजूद"]).hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });

  it("a Rajasthan story keeps its file code (JPR), and a flash naming a Rajasthan place keeps it", () => {
    expect(line1(worker(fileFor(null, "JPR"), ["सचिवालय में अहम बैठक", "कई अफसर रहे मौजूद"])).startsWith("#Jaipur: ")).toBe(true);
    const flash = worker(FLASH(6040), ["जयपुर में तेज बारिश से जलभराव", "कई इलाकों में पानी भरा"]);
    expect(flash.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });

  it("a route name never offers or tags its place: no #Delhi on the Kota story ('दिल्ली-मुंबई एक्सप्रेसवे')", () => {
    const d = worker(fileFor("GUL"), ["कोटा से खबर", "कोटा ग्रामीण की मंडाना थाना पुलिस ने दिल्ली-मुंबई एक्सप्रेसवे पर नाकाबंदी की", "नारकोटिक्स कंट्रोल ब्यूरो के तीन वांछित आरोपियों को दबोचा"]);
    expect(d.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
    expect(tagsOf(d)).not.toContain("Delhi");
    expect(d.hashtagSuggestions).not.toContain("#Delhi");
  });
});
