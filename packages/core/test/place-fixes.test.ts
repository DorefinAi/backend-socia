// Place, heading and card fixes of 25 Nov 2026 (owner-approved): national detection (P3), merged districts' desk tags
// (P5), one place rule for the caption and the card (P6/P10), two-line files and desk instructions (P8), file codes (P9)
// and statewide list stories (P11). Cases from the desk's posts of 15–24 Nov (minimal snippets, no full files).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_RAJASTHAN, PlaceBook, assemblePostText, xLen, cardHeadlineOf, composeBreaking, isDeskNote, isRajasthanStory, parseBreaking, pickReporter, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData,
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

describe("P9: file codes; the copy's opening district beats any reporter's code", () => {
  it("BAR is Barmer (the Barmer mortar story), BRN is Baran, RAJ is Rajsamand", () => {
    expect(book.codes).toMatchObject({ BAR: "Barmer", BRN: "Baran", RAJ: "Rajsamand" });
    const mortar = worker("BTN_RJ_BREAKING_24NOV_2740_AM_CONTROL_ASHOK_BAR_BIG_FULL_.txt", ["खेत में जिंदा मोर्टार बम मिलने से इलाके में फैली सनसनी", "पुलिस मौके पर पहुंची"]);
    expect(line1(mortar).startsWith("#Barmer: ")).toBe(true);
    expect(tagsOf(mortar)).not.toContain("Baran");
    expect(line1(worker("BTN_RJ_BREAKING_20NOV_2724_AM_CONTROL_RAJ3_BIG_.txt", ["पंचायत समिति चुनाव परिणाम", "भाजपा को बढ़त"])).startsWith("#Rajsamand: ")).toBe(true);
  });

  it("the Balotra fire in a BAR file: Balotra (the split district), @BalotraPolice, never #Baran/@BaranPolice", () => {
    const d = worker("btn_rj_breaking_6079_24nov_us_control_BAR2_big_full.txt", ["बालोतरा शहर के रामदेव टांका क्षेत्र में लगी आग", "तस्वीर बनाने के गोदाम में लगी आग", "आग से गोदाम जलकर हुआ राख"]);
    expect(d.headingPlace.district).toBe("Balotra");
    expect(tagsOf(d)).toContain("Balotra");
    expect(tagsOf(d)).not.toContain("Baran");
    expect(d.mentions).not.toContain("@BaranPolice");
    expect(d.mentions).toContain("@BalotraPolice");
  });

  it("ALW21, 'खैरथल के किशनगढ़बास में…': Khairthal-Tijara, not Alwar", () => {
    const d = worker("BTN_RJ_BREAKING_2003_24NOV_mh_CONTROL_ALW21_big.txt", ["खैरथल के किशनगढ़बास में अतिक्रमण कार्रवाई को लेकर बवाल!", "बासड़ा रोड पर कार्रवाई के विरोध में लामबंद हुए दुकानदार"]);
    expect(d.headingPlace.district).toBe("Khairthal-Tijara");
    expect(tagsOf(d)).not.toContain("Alwar");
    expect(d.mentions).not.toContain("@AlwarPolice");
  });

  it("the headline opening with a split district beats its parent's code (AJM file, Beawar story); a list's first does not", () => {
    expect(worker(fileFor(null, "AJM3"), ["ब्यावर में ट्रक और कार की टक्कर", "दो की मौत"]).headingPlace.district).toBe("Beawar");
    const list = parseBreaking("x\r\nकोटा, बारां, करौली और श्रीगंगानगर में मतगणना जारी\r\nपहला बिंदु\r\n", fileFor(null, "JPR"), book);
    expect(list.district).toBe("Jaipur");
  });

  it("never an origin, destination, route or compound: 'उदयपुर से लौट रहे…', 'अजमेर-जयपुर हाईवे' keep the JPR code", () => {
    for (const h of ["उदयपुर से लौट रहे जयपुर के परिवार की कार पलटी", "अजमेर-जयपुर हाईवे पर बड़ा हादसा"]) {
      const p = parseBreaking(`x\r\n${h}\r\nपहला बिंदु\r\n`, fileFor(null, "JPR"), book);
      expect(p.district, h).toBe("Jaipur");
    }
  });

  it("the code and the copy disagree otherwise (KTA file, 'भारी बारिश के बाद बारां में जलभराव'): both offered, neither emitted, no police", () => {
    const d = worker(fileFor(null, "KTA4"), ["भारी बारिश के बाद बारां में जलभराव", "कई घरों में पानी भरा"]);
    expect(tagsOf(d).filter((t) => t === "Kota" || t === "Baran")).toEqual([]);
    expect(d.hashtagSuggestions.slice(0, 2)).toEqual(["#Baran", "#Kota"]);
    expect(d.cityFlag).toBe("no_city");
    expect(police(d)).toEqual([]);
    expect(d.warnings.join(" ")).toMatch(/file code says Kota but the copy names Baran/);
  });

  it("a code the copy agrees with stands as before", () => {
    const d = worker(fileFor(null, "KTA4"), ["कोटा में चोरी की वारदात", "बदमाश नकदी और जेवर ले गए"]);
    expect(d.headingPlace.district).toBe("Kota");
    expect(police(d).length).toBeGreaterThan(0);
  });
});

describe("P11: a statewide list story infers no district", () => {
  const ranking = ["अक्टूबर की स्कूल शिक्षा Ranking में जिलों के प्रदर्शन में बड़ा उतार-चढ़ाव !", "सीकर ने 90 अंकों के साथ प्रदेश में पहला स्थान हासिल किया", "झुंझुनूं 86 अंकों के साथ दूसरे और कोटपूतली-बहरोड़ तीसरे स्थान पर"];

  it("the school ranking (Sikar first of three): no #Sikar, no city tag, flagged no_city, #Jaipur offered first", () => {
    const d = worker("btn_rj_breaking_6034_24nov_us_control_Dimple_karari_big.txt", ranking);
    expect(tagsOf(d)).not.toContain("Sikar");
    expect(d.headingPlace).toMatchObject({ placement: "none", district: null });
    expect(d.cityFlag).toBe("no_city");
    expect(d.hashtagSuggestions[0]).toBe("#Jaipur");
    expect(d.hashtagSuggestions).not.toContain("#Sikar");
    expect(d.warnings.join(" ")).toMatch(/statewide list/);
    expect(parseBreaking(`x\r\n${ranking.join("\r\n")}\r\n`, "btn_rj_breaking_6034_24nov_us_control_Dimple_karari_big.txt", book).district).toBeNull();
  });

  it("two districts named are no list: the text's district is still the post's city", () => {
    const d = worker(fileFor("KARARI"), ["सीकर में तेज बारिश", "झुंझुनूं में भी गिरे ओले"]);
    expect(tagsOf(d)).toContain("Sikar");
  });

  it("a stated district stands on a list story (the place line)", () => {
    const d = worker(fileFor(null), ["कोटा से खबर", "कोटा, बूंदी और बारां में पंचायत चुनाव की मतगणना", "तीनों जिलों में भाजपा आगे"]);
    expect(d.headingPlace.district).toBe("Kota");
  });
});

describe("P8: two-line files keep their line 2; desk orders never reach the post", () => {
  it("'सतीश पूनिया ने की अमित शाह से मुलाकात' / 'भाजपा मुख्यालय में आज की मुलाकात': line 2 kept, as the desk posted it", () => {
    const d = worker("btn_rj_breaking_6038_24nov_us_control_Ashvini_DL_BIG.txt", ["सतीश पूनिया ने की अमित शाह से मुलाकात", "भाजपा मुख्यालय में आज की मुलाकात"]);
    expect(d.bodyText).toBe("#Delhi: सतीश पूनिया ने की अमित शाह से मुलाकात\n\nभाजपा मुख्यालय में आज की मुलाकात");
  });

  it("a long line 2 is still cut the desk's way, and a cut never leaves a stub", () => {
    const d = worker(fileFor(null, "JPR"), ["सचिवालय में अहम बैठक", "मुख्य सचिव ने सभी विभागों के अधिकारियों के साथ बजट घोषणाओं की प्रगति की समीक्षा की और लंबित कार्यों को जल्द पूरा करने के निर्देश दिए", "कई जिलों के कलेक्टर भी वीसी से जुड़े"]);
    const line2 = d.bodyText.split("\n\n")[1]!;
    expect(line2.length).toBeGreaterThan(40);
    expect(line2).toMatch(/\.\.\.\.?$/);
  });

  it("the ED order line ('…की फोटो के साथ फुल स्क्रीन कराए') is taken out; the headline is the news", () => {
    const name = "BTN_RAJ_BREAKING_1301_23NOV_NDR_JNS_BIG_FULL.txt";
    const p = parseBreaking(`BTN_RAJ_BREAKING_1301_23NOV_NDR_JNS_BIG_FULL\r\n\r\nED के दफ्तर की फोटो के साथ फुल स्क्रीन कराए\r\n\r\nशिखर अग्रवाल ACB प्रकरण !\r\nसूत्रों के अनुसार अब किसी भी वक्त हो सकती ED की एंट्री\r\n`, name, book);
    expect(p.headline).toBe("शिखर अग्रवाल ACB प्रकरण !");
    expect(p.deskNote).toBe("ED के दफ्तर की फोटो के साथ फुल स्क्रीन कराए");
    expect(p.needsCheck).not.toContain("text_changed");
    const d = worker(name, ["ED के दफ्तर की फोटो के साथ फुल स्क्रीन कराए", "शिखर अग्रवाल ACB प्रकरण !", "सूत्रों के अनुसार अब किसी भी वक्त हो सकती ED की एंट्री"]);
    expect(d.bodyText).not.toMatch(/फुल स्क्रीन/);
  });

  it.each([["विजुअल के साथ खबर चलाएं"], ["सीएम की फोटो लगाएं"], ["ग्राफिक्स के साथ फुलस्क्रीन चलावें"]])("an order is a desk note: %s", (line) => {
    expect(isDeskNote(line)).toBe(true);
  });

  it.each([
    ["पुलिस ने वायरल वीडियो के आधार पर आरोपी को पकड़ा"],
    ["फोटो खिंचवाने के दौरान हादसा"],
    ["मंत्री ने अधिकारियों से कहा, जल्द काम पूरा कराएं"],
  ])("a news line is never one: %s", (line) => {
    expect(isDeskNote(line)).toBe(false);
  });
});

/** The card the desk's X cards show for a line 1 (independent of the composer): a lead run's last place, then the text, "#" off */
function deskCard(line: string): string {
  const run = /^((?:#[\p{L}\p{M}\p{N}_-]+\s*)+)[:：]\s*/u.exec(line);
  const off = (t: string) => t.replace(/#/g, "").trim();
  if (run) {
    const tags = run[1]!.trim().split(/\s+/).map((t) => t.slice(1));
    const last = [...tags].reverse().find((t) => book.hashtag(t) !== null || /[ऀ-ॿ]/u.test(t));
    if (last) {
      const p = book.hashtag(last);
      const name = !p || p.kind === "town" || /[ऀ-ॿ]/u.test(last) ? last : p.districts[0]!.deskTag === last ? last : p.districts[0]!.name;
      return `${name}: ${off(line.slice(run[0].length))}`;
    }
  }
  const inline = /^((?:#[\p{L}\p{M}\p{N}_-]+\s+)+)(?=[^#\s])/u.exec(line);
  if (inline && inline[1]!.trim().split(/\s+/).length > 1) return `${inline[1]!.trim().split(/\s+/).at(-1)!.slice(1)} ${off(line.slice(inline[0].length))}`;
  return off(line);
}

describe("P6/P10: one place rule for the caption and the card", () => {
  const cases: [string, string, string[], string, string | null][] = [
    // [label, file, lines, line 1, tag-line city or null]
    ["Kota: 'कोटा ग्रामीण…' keeps the word, no tag in line 1", "BTN_RJ_BREAKING_1029_24NOV_MS_CONTROL_Gul_big_FULL.txt", ["कोटा से खबर", "कोटा ग्रामीण की मंडाना थाना पुलिस ने दिल्ली-मुंबई एक्सप्रेसवे पर नाकाबंदी की", "आरोपियों को दबोचा"], "कोटा ग्रामीण की मंडाना थाना पुलिस ने दिल्ली-मुंबई एक्सप्रेसवे पर नाकाबंदी की", "#Kota"],
    ["Jodhpur: 'जोधपुर पुलिस कमिश्नरेट में…'", "BTN_RJ_BREAKING_24NOV_2792_AM_CONTROL_RAJEEV_JDR_BIG_.txt", ["जोधपुर पुलिस कमिश्नरेट में कांस्टेबल प्रमोशन के लिए हुए साक्षात्कार", "पुलिस कमिश्नर ने खुद लिए इंटरव्यू"], "जोधपुर पुलिस कमिश्नरेट में कांस्टेबल प्रमोशन के लिए हुए साक्षात्कार", "#Jodhpur"],
    ["Jamwaramgarh: the district inside 'जयपुर-जमवारामगढ़' is never prefixed again", "BTN_RJ_BREAKING_24NOV_2799_AM_CONTROL_JPR9_BIG_.txt", ["जमवारामगढ़ से खबर", "जयपुर-जमवारामगढ़ स्टेट हाईवे पर भीषण सड़क हादसा", "तेज रफ्तार डंपर ने मारी बाइक को टक्कर"], "जयपुर-जमवारामगढ़ स्टेट हाईवे पर भीषण सड़क हादसा", "#Jaipur"],
    ["Churu: 'चूरू जिला प्रमुख के लिए…' → the tag (desk)", "BTN_RJ_BREAKING_2057_24NOV_mh_CONTROL_Sanjay_chr_big.txt", ["चूरू जिला प्रमुख के लिए कांग्रेस से आया बड़ा नाम", "प्रकाश बुड़ानिया होंगी उम्मीदवार"], "#Churu: जिला प्रमुख के लिए कांग्रेस से आया बड़ा नाम", null],
    ["Churu: 'चूरू जिला परिषद में…' → the tag (desk 3 of 5)", fileFor(null, "CHR"), ["चूरू जिला परिषद में कांग्रेस का बहुमत", "भाजपा पीछे"], "#Churu: जिला परिषद में कांग्रेस का बहुमत", null],
    ["Jodhpur: 'जोधपुर फर्जी कॉल सेंटर…' → the tag (desk)", "BTN_RJ_BREAKING_2127_24NOV_mh_CONTROL_rajeev_big.txt", ["जोधपुर", "जोधपुर फर्जी कॉल सेंटर से जुड़ा मामला", "बासनी में पकड़े गए युवक-युवतियों से पूछताछ जारी"], "#Jodhpur: फर्जी कॉल सेंटर से जुड़ा मामला", null],
    ["Bundi: 'बूंदी के केशवरायपाटन में…' → '#Bundi #केशवरायपाटन में…' (desk)", fileFor(null, "BND"), ["बूंदी के केशवरायपाटन में कार्तिक पूर्णिमा पर उमड़ा श्रद्धा का सैलाब", "हजारों श्रद्धालु पहुंचे"], "#Bundi #केशवरायपाटन में कार्तिक पूर्णिमा पर उमड़ा श्रद्धा का सैलाब", null],
    ["Churu: 'चूरू के सरदारशहर में…' → '#Churu #सरदारशहर में…' (desk)", fileFor(null, "CHR"), ["चूरू के सरदारशहर में हरियाणा का कुख्यात गैंगस्टर गिरफ्तार", "पुलिस ने घेराबंदी कर पकड़ा"], "#Churu #सरदारशहर में हरियाणा का कुख्यात गैंगस्टर गिरफ्तार", null],
    ["Khairthal: 'खैरथल के किशनगढ़बास में…' in an ALW file (desk)", "BTN_RJ_BREAKING_2003_24NOV_mh_CONTROL_ALW21_big.txt", ["खैरथल के किशनगढ़बास में अतिक्रमण कार्रवाई को लेकर बवाल!", "दुकानदार और स्थानीय लोग लामबंद"], "#Khairthal #किशनगढ़बास में अतिक्रमण कार्रवाई को लेकर बवाल!", null],
    ["Tonk: 'टोंक में…' keeps the word (desk 221 to 3)", fileFor(null, "TOK"), ["टोंक में अवैध खनन पर बड़ी कार्रवाई", "पुलिस मौके पर पहुंची"], "टोंक में अवैध खनन पर बड़ी कार्रवाई", "#Tonk"],
    ["Udaipur: 'उदयपुर घूमने आई…' → '#Udaipur: घूमने आई…'", fileFor(null, "UDR"), ["उदयपुर घूमने आई पर्यटक की कार पलटी", "पुलिस मौके पर पहुंची"], "#Udaipur: घूमने आई पर्यटक की कार पलटी", null],
    ["Udaipur: 'उदयपुर SP …' keeps the word", fileFor(null, "UDR"), ["उदयपुर SP के निर्देशन में नशे के खिलाफ कार्रवाई", "पुलिस मौके पर पहुंची"], "उदयपुर SP के निर्देशन में नशे के खिलाफ कार्रवाई", "#Udaipur"],
  ];
  it.each(cases)("%s", (_label, file, lines, l1, trailing) => {
    const d = worker(file, lines);
    expect(line1(d)).toBe(l1);
    if (trailing) expect(d.hashtags).toContain(trailing);
    // The card is line 1 as posted: never "Kota: ग्रामीण…", "Ajmer: जिला प्रमुख…", "जमवारामगढ़: जयपुर-जमवारामगढ़…"
    expect(d.headingPlace.cardHeadline).toBe(deskCard(l1));
  });

  it("the card heading for each line 1 shape", () => {
    expect(cardHeadlineOf(book, "#Churu: जिला प्रमुख के लिए नाम").text).toBe("Churu: जिला प्रमुख के लिए नाम");
    expect(cardHeadlineOf(book, "#Kota #लाडपुरा: मंदिर में चोरी")).toEqual({ text: "लाडपुरा: मंदिर में चोरी", place: "लाडपुरा" });
    expect(cardHeadlineOf(book, "#Jaipur: #BJP: नई घोषणा").text).toBe("Jaipur: BJP: नई घोषणा");
    expect(cardHeadlineOf(book, "#BJP: नई घोषणा")).toEqual({ text: "BJP: नई घोषणा", place: null });
    expect(cardHeadlineOf(book, "#SawaiMadhopur: बाघ दिखा").text).toBe("Sawai Madhopur: बाघ दिखा");
    expect(cardHeadlineOf(book, "#UttarPradesh: बड़ा फैसला").text).toBe("Uttar Pradesh: बड़ा फैसला");
    expect(cardHeadlineOf(book, "#Khairthal: बैठक").text).toBe("Khairthal: बैठक");
    expect(cardHeadlineOf(book, "#Kotputli-Behror: बैठक").text).toBe("Kotputli-Behror: बैठक");
    expect(cardHeadlineOf(book, "#Bundi #नैनवां में मां कंकाली की सवारी")).toEqual({ text: "नैनवां में मां कंकाली की सवारी", place: "नैनवां" });
    expect(cardHeadlineOf(book, "कोटा ग्रामीण की मंडाना थाना पुलिस ने #ACB को सौंपा")).toEqual({ text: "कोटा ग्रामीण की मंडाना थाना पुलिस ने ACB को सौंपा", place: null });
  });

  it("an inferred city stays in the tag line and the card has no place in front (Ajmer: 'अजमेर जिला प्रमुख चुनाव…' as the desk posted)", () => {
    const d = worker("BTN_RJ_BREAKING_1032_24NOV_MS_CONTROL_Shubham_big.txt", ["अजमेर जिला प्रमुख चुनाव भाजपा का कब्जा तय, चेहरे पर सस्पेंस बरकरार", "जिला परिषद में भाजपा के 19 सदस्य जीते"]);
    expect(line1(d)).toBe("अजमेर जिला प्रमुख चुनाव भाजपा का कब्जा तय, चेहरे पर सस्पेंस बरकरार");
    expect(d.headingPlace.cardHeadline).toBe(line1(d));
    expect(d.headingPlace.card).toBeNull();
  });

  it("the desk's own tag run: the card is its last place and the text ('#Bharatpur #नदबई: …' → 'नदबई: …')", () => {
    const d = worker(fileFor(null), ["#Bharatpur #नदबई: मारपीट में अधेड़ की मौत", "पुलिस मौके पर पहुंची"]);
    expect(line1(d)).toBe("#Bharatpur #नदबई: मारपीट में अधेड़ की मौत");
    expect(d.headingPlace.cardHeadline).toBe("नदबई: मारपीट में अधेड़ की मौत");
  });
});

describe("P3 (lead, 25 Nov 2026): anything of Rajasthan's keeps a story Rajasthan; only the headline or first point can make it national", () => {
  it.each([
    ["a Jaipur town in a route name ('कालाडेरा रेनवाल रोड')", "BTN_RJ_BREAKING_2050_24NOV_mh_CONTROL_jpr18_big.txt", ["ट्रक की सीट पर बैठे चालक की नीचे गिरने से हुई मौत", "कालाडेरा रेनवाल रोड पर कानरपुरा के पास की घटना", "दिल्ली से आ रहा था ट्रक"]],
    ["the desk's own Hindi place tag ('#कालाडेरा:')", fileFor(null), ["#कालाडेरा: ट्रक की सीट से गिरकर चालक की मौत", "दिल्ली से आ रहा था ट्रक"]],
    ["ACB", "BTN_RAJ_BREAKING_1301_23NOV_NDR_JNS_UPDATE_BIG_FULL.txt", ["शिखर अग्रवाल ACB प्रकरण !", "दिल्ली में इस बारे में शीर्ष स्तर पर दो बार हो चुका विचार विमर्श"]],
    ["Gehlot's Delhi visit", "BTN_RJ_BREAKING_6104_18NOV_US_CONTROL_Dinesh_Dangi_BIG.txt", ["अशोक गहलोत का दिल्ली दौरा", "गहलोत दिल्ली में कार्यक्रम में होंगे शामिल"]],
    ["Pilot's Punjab trip", "BTN_RJ_BREAKING_2121_23NOV_mh_CONTROL_Dinesh_Dangi_big.txt", ["सचिन पायलट आज पंजाब के दौरे पर", "सचिन पायलट पहुंचे पंजाब के अमृतसर"]],
    ["Dotasra in the first point", "BTN_RAJ_BREAKING_1302_23NOV_NDR_Aishwarya_Karari_BIG.txt", ["भाजपा में जाट Vote Bank को लेकर अंदरूनी मंथन", "गोविंद डोटासरा के कद के सामने भाजपा में बेचैनी", "दिल्ली तक पहुंची बात"]],
    ["the Chief Secretary in Seoul ('#सियोल:')", fileFor("RITURAJ"), ["#सियोल: मुख्य सचिव की 34 बैठकें", "कोरिया सरकार से समझौते"]],
    ["the state's विधानसभा", fileFor(null), ["विधानसभा में हंगामा", "दिल्ली के नेताओं ने भी दी प्रतिक्रिया"]],
    ["an outside place only in the body ('कांग्रेस से बड़ी खबर')", fileFor("VIKAS"), ["कांग्रेस से बड़ी खबर", "कांग्रेस ने अपने सांसदों को दिए निर्देश", "दिल्ली में होगी बैठक"]],
  ])("%s: Rajasthan", (_label, file, lines) => {
    const d = worker(file, lines as string[]);
    expect(d.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });

  it.each([
    ["बिहार के वैशाली में PM मोदी का संबोधन", "नीतीश कुमार के सम्मान में सेतु का नाम"],
    ["पंजाब PCS भर्ती को लेकर हाईकोर्ट का बड़ा फैसला", "पंजाब लोक सेवा आयोग की भर्ती प्रक्रिया"],
    ["दिल्ली सरकार के विभागों में 1,260 पदों पर भर्ती", "आवेदन की अंतिम तिथि तय"],
    ["दिल्ली विधानसभा में हंगामा", "विपक्ष का वॉकआउट"],
  ])("national when the headline or first point names an outside place and nothing is Rajasthan's: %s", (headline, point) => {
    const d = worker(fileFor("TV"), [headline, point]);
    expect(d.hashtags[0]).toBe("#FirstIndiaNews");
  });

  it("an airline pilot is no Sachin Pilot ('पायलट' alone is no Rajasthan leader)", () => {
    const d = worker(fileFor("TV"), ["दिल्ली एयरपोर्ट पर पायलट की सूझबूझ से टला हादसा", "विमान सुरक्षित उतरा"]);
    expect(d.hashtags[0]).toBe("#FirstIndiaNews");
  });
});

describe("the merged districts' hyphenated names are the district, never a route", () => {
  it("'खैरथल-तिजारा से हेमसिंह परमार की Exclusive Report' in an ALW21 file: Khairthal-Tijara, #Khairthal, not #Alwar", () => {
    const d = worker("BTN_RJ_BREAKING_2026_24NOV_mh_CONTROL_ALW21_big.txt", ["खैरथल-तिजारा से हेमसिंह परमार की Exclusive Report", "कोटकासिम में अपहरण की FIR पर कांग्रेस का प्रदर्शन"]);
    expect(d.headingPlace.district).toBe("Khairthal-Tijara");
    expect(tagsOf(d)).toContain("Khairthal");
    expect(tagsOf(d)).not.toContain("Alwar");
  });
  it.each([["कोटपूतली-बहरोड़ में बड़ा हादसा", "Kotputli-Behror"], ["डीडवाना-कुचामन में बारिश", "Didwana-Kuchaman"]])("'%s' in a JPR file opens with %s", (headline, district) => {
    const p = parseBreaking(`x\r\n${headline}\r\nपहला बिंदु\r\n`, fileFor(null, "JPR"), book);
    expect(p.district).toBe(district);
  });
});

describe("Desk screenshots of 25 Nov evening: a name twice, and a national post kept Rajasthan", () => {
  it("a misspelt dateline town takes the headline's spelling: '#Nagaur #कुचामन पंचायत…', the name once on line 1 and the card", () => {
    const d = worker("BTN_RJ_BREAKING_1085_25NOV_MS_CONTROL_NGR2_big.txt", [
      "नागौर के कुमाचन से खबर",
      "कुचामन पंचायत समिति में 27 व 28 को होने वाले प्रधान व उपप्रधान के चुनाव को लेकर प्रशासन सतर्क",
      "पंचायत समिति के सामने वाले मार्ग यातायात को सुचारू करने के लिए बनाया प्लान",
    ]);
    // The owner: Kuchaman stays the reporter's Nagaur (Didwana offered), and the caption keeps the town tag
    expect(line1(d)).toBe("#Nagaur #कुचामन पंचायत समिति में 27 व 28 को होने वाले प्रधान व उपप्रधान के चुनाव को लेकर प्रशासन सतर्क");
    expect(line1(d)).not.toContain("कुमाचन");
    expect(d.headingPlace).toMatchObject({ cardHeadline: "कुचामन पंचायत समिति में 27 व 28 को होने वाले प्रधान व उपप्रधान के चुनाव को लेकर प्रशासन सतर्क" });
  });

  it("an unknown dateline town that matches nothing in the headline is kept as written", () => {
    const d = worker(fileFor(null), ["झालावाड़ के मासलपुर से खबर", "पंचायत समिति की बैठक में हंगामा", ...POINTS]);
    expect(line1(d)).toBe("#Jhalawar #मासलपुर: पंचायत समिति की बैठक में हंगामा");
  });

  it.each([
    ["#Chittorgarh #रावतभाटा: रावतभाटा की सियासत में चुनाव बाद सामने आया नया घटनाक्रम", "रावतभाटा की सियासत में चुनाव बाद सामने आया नया घटनाक्रम"],
    ["#Rajsamand #कुंभलगढ़: कुंभलगढ़ के मजेरा के पास किराना व्यापारी के साथ मारपीट", "कुंभलगढ़ के मजेरा के पास किराना व्यापारी के साथ मारपीट"],
    ["#Kota: कोटा में हिस्ट्रीशीटर के घर में तोड़फोड़", "कोटा में हिस्ट्रीशीटर के घर में तोड़फोड़"],
    ["#Kota #लाडपुरा: नदी में डूबा युवक", "लाडपुरा: नदी में डूबा युवक"],
    ["#Jaisalmer #पोकरण: पोकरण-जोधपुर सड़क मार्ग पर हादसे की सूचना", "पोकरण: पोकरण-जोधपुर सड़क मार्ग पर हादसे की सूचना"],
  ])("card of '%s' is '%s' (X cards of 23–24 Nov)", (l1, card) => {
    expect(cardHeadlineOf(book, l1).text).toBe(card);
  });

  it("the Centre as the subject, Assam only in a later point: national, no @RajGovOfficial, @narendramodi offered or carried", () => {
    const d = worker("BTN_RJ_BREAKING_25NOV_2720_AM_CONTROL_TV_BIG_.txt", [
      "कैबिनेट फैसलों पर PM मोदी का X पर पोस्ट",
      "'बराक घाटी की विकास यात्रा नई ऊंचाइयों को छूने के लिए तैयार है'",
      "'कैबिनेट ने सिलचर के डोलू में एक ग्रीनफील्ड एयरपोर्ट के विकास को मंजूरी दी'",
      "'दक्षिणी असम और आसपास के राज्यों के लिए बेहतर हवाई कनेक्टिविटी'",
    ]);
    expect(d.hashtags[0]).toBe("#FirstIndiaNews");
    expect(d.cityFlag).toBe("national_story");
    expect(d.mentions).not.toContain("@RajGovOfficial");
    expect(d.hashtagSuggestions).not.toContain("#Jaipur");
    expect([...d.mentions, ...(d.handleSuggestions ?? []).map((h) => h.handle)]).toContain("@narendramodi");
  });

  it("Rajasthan's own stay Rajasthan: a former Chief Secretary flying from Jaipur to Silchar, a union minister from Rajasthan", () => {
    const usha = worker("BTN_RJ_BREAKING_2005_25NOV_mh_CONTROL_Krishan_Murari_big.txt", ["पूर्व मुख्य सचिव उषा शर्मा आज जाएंगी सिलचर (असम)", "इंडिगो फ्लाइट 6E-748 से जयपुर से जाएंगी सिलचर (असम)"]);
    expect(usha.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
    const shekhawat = worker(fileFor(null), ["केंद्रीय मंत्री गजेंद्र सिंह शेखावत ने की समीक्षा बैठक", "अधिकारियों को दिए निर्देश"]);
    expect(shekhawat.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
    const visit = worker(fileFor(null), ["PM मोदी का बांसवाड़ा दौरा कल", "तैयारियों का जायजा"]);
    expect(visit.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });
});

describe("Owner's 100% rule (26 Nov): what the new place and national rules must NOT change", () => {
  const NO_REPORTER = "btn_rj_breaking_611_bps_05NOV_control_TV_BIG.txt";
  it("a dateline town is never swapped for a district, a place further in, or a place more than one letter off", () => {
    // कोटा is a district, not a town: the desk's कोटड़ा stands
    expect(line1(worker(fileFor(null), ["उदयपुर के कोटड़ा से खबर", "कोटा से आई टीम ने की जांच", ...POINTS]))).not.toContain("#कोटा");
    // कुचामन named later in the headline, not at its opening: the unknown word stands
    expect(line1(worker(fileFor(null), ["नागौर के कुमाचन से खबर", "पंचायत समिति कुचामन में चुनाव की तैयारी", ...POINTS]))).toContain("कुमाचन");
  });

  it("the plain Centre on a Rajasthan reporter's file stays Rajasthan (a village story naming a scheme)", () => {
    const d = worker(fileFor("DINESH", "JPR"), ["केंद्र सरकार की योजना का लाभ नहीं मिल रहा, ग्रामीण परेशान", "अधिकारियों से की शिकायत"]);
    expect(d.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });

  it("the plain Centre on a desk file with no reporter is national ('दवाओं की सप्लाई चेन पर केंद्र सरकार सख्त')", () => {
    expect(worker(NO_REPORTER, ["दवाओं की सप्लाई चेन पर केंद्र सरकार सख्त", "नई गाइडलाइन जारी"]).hashtags[0]).toBe("#FirstIndiaNews");
  });

  it("the Prime Minister named only in a point stays Rajasthan (DGP Conference, posted #Jaipur on 23 Nov)", () => {
    const d = worker(fileFor("DINESH", "JPR"), ["इस बार आंध्रप्रदेश के तिरुपति में आयोजित होगी DGP Conference", "61वीं DG IG Conference का 4 से 6 दिसंबर तक होगा आयोजन, प्रधानमंत्री नरेंद्र मोदी, गृह मंत्री अमित शाह रहेंगे मौजूद"]);
    expect(d.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });

  it.each(["केंद्रीय विद्यालय में वार्षिकोत्सव", "केंद्रीय जेल में बंदी की मौत", "प्रधानमंत्री आवास योजना में गड़बड़ी", "केंद्रीय मंत्रालय की टीम पहुंची"])(
    "'%s' is not the Centre as a subject: no national flip", (headline) => {
      expect(worker(NO_REPORTER, [headline, "मामले की जांच शुरू"]).hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
    },
  );
});
describe("@ml_vikas (owner, 26 Nov 2026): always '#Jaipur:' and the card 'Jaipur:', always @RajGovOfficial, never on national", () => {
  const VIKAS = (n: number) => `BTN_RJ_BREAKING_${n}_26NOV_mh_CONTROL_Vikas_big.txt`;
  it("a story naming no place: '#Jaipur: …', card 'Jaipur: …', @RajGovOfficial tagged (was only offered)", () => {
    const d = worker(VIKAS(2009), ["Pharmacists के हितों की रक्षा के लिए नया संगठन", "Association of Pharmacist Employees (APE) रजि. का शुभारंभ"]);
    expect(line1(d)).toBe("#Jaipur: Pharmacists के हितों की रक्षा के लिए नया संगठन");
    expect(d.headingPlace.cardHeadline).toBe("Jaipur: Pharmacists के हितों की रक्षा के लिए नया संगठन");
    expect(d.mentions).toContain("@RajGovOfficial");
    expect(d.proposals.find((p) => p.item === "@RajGovOfficial")).toMatchObject({ layer: "emit" });
  });

  it("another district in the text (Chhabra, Baran): still '#Jaipur:', as the desk posted it", () => {
    const d = worker(VIKAS(2063), ["छबड़ा पावर प्लांट की ऐतिहासिक \"Performance\" !", "RVUNL ने 2320 मेगावाट विद्युत उत्पादन करते हुए किया सर्वश्रेष्ठ प्रदर्शन"]);
    expect(line1(d)).toBe("#Jaipur: छबड़ा पावर प्लांट की ऐतिहासिक \"Performance\" !");
    expect(d.mentions).toContain("@RajGovOfficial");
  });

  it("a headline opening with जयपुर: still '#Jaipur:' in front, and the card keeps 'Jaipur:'", () => {
    const d = worker(VIKAS(5118), ["जयपुर डिस्कॉम से बड़ी खबर", "बिजली चोरी के खिलाफ अभियान"]);
    expect(line1(d)).toBe("#Jaipur: जयपुर डिस्कॉम से बड़ी खबर");
    expect(d.headingPlace.cardHeadline).toBe("Jaipur: जयपुर डिस्कॉम से बड़ी खबर");
  });

  it("a place the desk wrote at the start leads instead (owner: the rule only when no place); no town tag is dropped", () => {
    const kota = worker(VIKAS(2100), ["कोटा के रामगंजमंडी से खबर", "थर्मल पावर प्लांट की यूनिट में तकनीकी खराबी", "उत्पादन ठप"]);
    expect(line1(kota)).toBe("#Kota #रामगंजमंडी: थर्मल पावर प्लांट की यूनिट में तकनीकी खराबी");
    const prefix = worker(VIKAS(2102), ["रामपुरा खुर्द: खेत में मिला शव", "पुलिस मौके पर पहुंची"]);
    expect(line1(prefix)).not.toContain("#Jaipur");
    expect(line1(prefix)).toContain("रामपुरा खुर्द");
  });

  it("a town beside #Jaipur is named once and keeps its tag ('जयपुर के सांगानेर से खबर' over 'सांगानेर में…')", () => {
    const d = worker(VIKAS(2104), ["जयपुर के सांगानेर से खबर", "सांगानेर में बिजली कटौती से लोग परेशान", "डिस्कॉम ने दी जानकारी"]);
    expect(line1(d)).toBe("#Jaipur #सांगानेर में बिजली कटौती से लोग परेशान");
  });

  it("@RajGovOfficial never moves off: a long post is fitted to 300 only when it cannot fit 280 with it", () => {
    const long = ["बिजली कंपनियों के घाटे पर ऊर्जा विभाग की उच्चस्तरीय समीक्षा बैठक में बड़े फैसले, उपभोक्ताओं को राहत देने की तैयारी तेज",
      "ऊर्जा राज्यमंत्री हीरालाल नागर ने अधिकारियों को दिए सख्त निर्देश, बकाया वसूली अभियान तेज करने को कहा, लापरवाही पर होगी कार्रवाई",
      "जयपुर डिस्कॉम, अजमेर डिस्कॉम और जोधपुर डिस्कॉम के प्रबंध निदेशकों के साथ विस्तृत चर्चा, नए बिजली कनेक्शन जल्द जारी होंगे"];
    const d = worker(VIKAS(2103), long);
    expect(d.mentions).toContain("@RajGovOfficial");
    const n = xLen(assemblePostText(d.bodyText, d.hashtags, d.mentions));
    expect(n).toBeLessThanOrEqual(300);
    // Another reporter's same post still fits 280
    const other = worker(fileFor("DIMPLE"), long);
    expect(xLen(assemblePostText(other.bodyText, other.hashtags, other.mentions))).toBeLessThanOrEqual(280);
  });

  it("a national story stays national: no #Jaipur, no @RajGovOfficial", () => {
    const d = worker(VIKAS(2101), ["दिल्ली में ऊर्जा मंत्रियों का राष्ट्रीय सम्मेलन", "कई राज्यों के मंत्री पहुंचे"]);
    expect(d.hashtags[0]).toBe("#FirstIndiaNews");
    expect(tagsOf(d)).not.toContain("Jaipur");
    expect(d.mentions).not.toContain("@RajGovOfficial");
  });

  it("another reporter's rule is unchanged: rituraj's Kota place line keeps '#Kota:'", () => {
    const d = worker(fileFor("rituraj"), ["कोटा से खबर", "थर्मल पावर प्लांट की यूनिट में तकनीकी खराबी", "उत्पादन ठप"]);
    expect(line1(d).startsWith("#Kota")).toBe(true);
  });
});

describe("The TV control room's 'FULL_<n>_' label line (26 Nov 2026)", () => {
  it("Kota: the label goes, the dateline is read: '#Kota: अब राजस्थान…'", () => {
    const d = worker("BTN_RJ_BREAKING_1041_25NOV_MS_CONTROL_Bhanwar_big_FULL.txt", [
      "FULL_1041_कोटा से खबर", "कोटा से खबर", "अब राजस्थान का तीसरा प्रमुख क्रिकेट हब बनने की तरफ कोटा", "कोटा क्रिकेट जगत की दशकों पुरानी उम्मीद आज उतरी धरातल पर",
    ]);
    expect(line1(d)).toBe("#Kota: अब राजस्थान का तीसरा प्रमुख क्रिकेट हब बनने की तरफ कोटा");
    expect(d.bodyText).not.toContain("FULL_");
  });

  it("the district chiefs' results: the headline once, no label", () => {
    const d = worker("BTN_RJ_BREAKING_6804_VG_25NOV_CONTROL_JNS_BIG_FULL_SCREEN.txt", [
      "FULL_6804_प्रदेश में 37 जिला प्रमुखों का परिणाम घोषित", "प्रदेश में 37 जिला प्रमुखों का परिणाम घोषित", "24 जिला परिषदों में कांग्रेस के बने जिला प्रमुख",
    ]);
    expect(line1(d)).toBe("प्रदेश में 37 जिला प्रमुखों का परिणाम घोषित");
    expect(d.bodyText).not.toContain("FULL_");
    expect(d.bodyText.split("\n\n")[1]!.startsWith("24 जिला परिषदों")).toBe(true);
  });

  it("a label of a letter or two is no copy: its words stay", () => {
    const d = worker(fileFor(null, "JPR"), ["FULL_5_ए", "खान विभाग की समीक्षा बैठक", "अधिकारियों को दिए निर्देश"]);
    expect(d.bodyText).not.toContain("FULL_");
    expect(d.bodyText).toContain("ए");
  });

  it("a label whose words appear nowhere below keeps them as the headline (no word lost)", () => {
    const d = worker(fileFor(null, "JPR"), ["full_6099_खान विभाग की समीक्षा बैठक", "जयपुर", "अधिकारियों को दिए निर्देश"]);
    expect(line1(d)).toContain("खान विभाग की समीक्षा बैठक");
    expect(d.bodyText).not.toMatch(/full_/i);
  });
});