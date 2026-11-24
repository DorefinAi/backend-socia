// Place, heading and card fixes of 25 Nov 2026 (owner-approved): national detection (P3), merged districts' desk tags
// (P5), one place rule for the caption and the card (P6/P10), two-line files and desk instructions (P8), file codes (P9)
// and statewide list stories (P11). Cases from the desk's posts of 15–24 Nov (minimal snippets, no full files).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_RAJASTHAN, PlaceBook, composeBreaking, isDeskNote, isRajasthanStory, parseBreaking, pickReporter, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData,
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
