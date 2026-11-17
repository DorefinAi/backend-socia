// The desk's text is never changed or dropped by the parser (owner, 17 Nov 2026, after "85.59 प्रतिशत" became
// "59 प्रतिशत"): numbers stay whole, only intended lines come off the top (file name, separators, desk notes,
// datelines, the "बर्थ-डे" label), and a safety net flags any word that still goes missing.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PlaceBook, isDeskNote, lostWords, parseBreaking, parsePlacesData } from "../src";

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const FILE = "BTN_RJ_BREAKING_1_16NOV_US_CONTROL_X_big.txt";
const parse = (lines: string[], file = FILE) => parseBreaking(`${file.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, file, book);
const text = (s: ReturnType<typeof parse>) => [s.headline, ...s.points].join("\n");

describe("numbers at the start of a line stay whole", () => {
  it("decimals, dates and times: the 16 Nov cases", () => {
    const s = parse(["जमवारामगढ़ में मतदान", "85.59 प्रतिशत पहुंचा मतदान", "43.86 प्रतिशत दोपहर तक", "3.37 लाख मतदाता", "7.56 ग्राम स्मैक बरामद", "3.30 बजे होगा कार्यक्रम", "1.11.2026 से मिलेगा लाभ", "12.600 किलो अफीम"]);
    expect(s.points).toEqual(["85.59 प्रतिशत पहुंचा मतदान", "43.86 प्रतिशत दोपहर तक", "3.37 लाख मतदाता", "7.56 ग्राम स्मैक बरामद", "3.30 बजे होगा कार्यक्रम", "1.11.2026 से मिलेगा लाभ", "12.600 किलो अफीम"]);
    expect(s.needsCheck).not.toContain("text_changed");
  });
  it("a decimal in the headline too", () => {
    expect(parse(["9.20 लाख से अधिक मतदाताओं की सूची जारी", "निर्वाचन विभाग ने दी जानकारी"]).headline).toBe("9.20 लाख से अधिक मतदाताओं की सूची जारी");
  });
  it("a minus sign and 'more than' stay: -2.5 डिग्री, >50 लोग", () => {
    expect(parse(["शीतलहर का असर", "-2.5 डिग्री पहुंचा पारा", "- 1 डिग्री माउंट आबू में", ">50 लोग घायल"]).points).toEqual(["-2.5 डिग्री पहुंचा पारा", "- 1 डिग्री माउंट आबू में", ">50 लोग घायल"]);
  });
  it("a numbered list keeps its numbers (they are the desk's text)", () => {
    expect(parse(["रेवदर सरपंच परिणाम", "1. जोलपुर प्रेम कुंवर", "2) डबाणी प्रकाश कुंवर", "10. थल नरसाराम"]).points).toEqual(["1. जोलपुर प्रेम कुंवर", "2) डबाणी प्रकाश कुंवर", "10. थल नरसाराम"]);
  });
  it("symbol bullets still come off, and a dash that is a bullet", () => {
    expect(parse(["सड़क हादसा", "• दो लोग घायल", "➤ पुलिस मौके पर", "* जांच शुरू", "- अस्पताल में भर्ती"]).points).toEqual(["दो लोग घायल", "पुलिस मौके पर", "जांच शुरू", "अस्पताल में भर्ती"]);
  });
});

describe("the words before the headline's colon", () => {
  it("a known place comes off into the district (the desk's dateline)", () => {
    const s = parse(["टोंक: पंचायतीराज चुनाव 2026", "मतदान जारी"]);
    expect([s.headline, s.district]).toEqual(["पंचायतीराज चुनाव 2026", "Tonk"]);
  });
  it("one unknown Hindi word is the desk's town: it comes off and is kept as the town", () => {
    const s = parse(["आकोला: 100 साल पुरानी परंपरा", "गांव में उत्सव"]);
    expect([s.headline, s.town]).toEqual(["100 साल पुरानी परंपरा", "आकोला"]);
  });
  it("anything else stays in the headline: two unknown words, a label, a quoted title", () => {
    for (const h of ["विधायक बोले: सड़क जल्द बनेगी", "आरोप: पुलिस ने नहीं की सुनवाई", "वेलिंग्टन वनडे: न्यूजीलैंड 134 रन पर ऑल आउट", "‘बिलॉन्गिंग: अ जर्नी ऑफ लव’ किताब की लांचिंग आज"]) {
      const s = parse([h, "आगे की जानकारी"]);
      expect(s.headline, h).toBe(h);
      expect(s.town, h).toBeNull();
      expect(s.needsCheck, h).not.toContain("text_changed");
    }
  });
});

describe("lines at the top", () => {
  it("a dateline comes off into the district", () => {
    const s = parse(["बीकानेर से खबर", "कानून मंत्री की प्रेस वार्ता", "कई घोषणाएं की"]);
    expect([s.headline, s.district]).toEqual(["कानून मंत्री की प्रेस वार्ता", "Bikaner"]);
  });
  it("one unknown word as a dateline is kept as the town even with no district", () => {
    expect(parse(["मासलपुर", "पंचायत में मतदान जारी", "लंबी कतारें"]).town).toBe("मासलपुर");
  });
  it("a byline stays as the headline (the desk posts it) and its place is read", () => {
    const s = parse(["जोधपुर से राजीव गौड़ की रिपोर्ट", "जमीनों पर कब्जों का खेल", "फर्जी दस्तावेज तैयार"]);
    expect([s.headline, s.points[0], s.district]).toEqual(["जोधपुर से राजीव गौड़ की रिपोर्ट", "जमीनों पर कब्जों का खेल", "Jodhpur"]);
    expect(parse(["ACB से नवीन शर्मा की रिपोर्ट", "IAS प्रकरण में अपडेट"]).headline).toBe("ACB से नवीन शर्मा की रिपोर्ट");
    expect(parse(["डॉ.ऋतुराज शर्मा व ऐश्वर्य प्रधान की रिपोर्ट", "एम्पलॉई गॉसिप"]).headline).toBe("डॉ.ऋतुराज शर्मा व ऐश्वर्य प्रधान की रिपोर्ट");
  });
  it("a label the desk posts stays as the headline; 'बर्थ-डे' (never posted) comes off", () => {
    expect(parse(["सियासी गपशप", "काश ऐसे होता सभी का चुनाव"]).headline).toBe("सियासी गपशप");
    // "<place> से <label>" is the headline too, not a dateline with a town called "सियासी गपशप"
    const d = parse(["दौसा से सियासी गपशप", "काश ऐसे होता सभी का चुनाव"]);
    expect([d.headline, d.town]).toEqual(["दौसा से सियासी गपशप", null]);
    expect(parse(["उत्तर प्रदेश की सियासत", "नए गठबंधन की चर्चा"]).headline).toBe("उत्तर प्रदेश की सियासत");
    const b = parse(["बर्थ-डे", "RAS कीर्ति राठौड़ का जन्मदिन आज"]);
    expect([b.headline, b.town]).toEqual(["RAS कीर्ति राठौड़ का जन्मदिन आज", null]);
  });
  it("a two-word stub ending in a postposition joins the next line", () => {
    expect(parse(["जयपुर के", "बिरला ऑडिटोरियम में कार्यक्रम का मंचन", "कई लोग पहुंचे"]).headline).toBe("जयपुर के बिरला ऑडिटोरियम में कार्यक्रम का मंचन");
    // A whole line ending in की / के stays a line of its own
    expect(parse(["धरना प्रदर्शन", "ग्रामीणों ने तत्काल कार्रवाई की मांग की", "प्रशासन ने दिया आश्वासन"]).points).toEqual(["ग्रामीणों ने तत्काल कार्रवाई की मांग की", "प्रशासन ने दिया आश्वासन"]);
  });
});

describe("desk notes", () => {
  it("a line starting नोट (any punctuation, ः included) is a note", () => {
    for (const n of ["नोट :- फोटो के साथ फुल स्क्रीन कराएं", "नोट- खबर को फोटो के साथ फुलस्क्रीन करावें।", "नोटः पंचायत चुनाव की मतदान प्रक्रिया से जुड़ी फोटो के साथ फुलस्क्रीन करावें", "NOTE : full screen only"]) expect(isDeskNote(n), n).toBe(true);
  });
  it("a short line that is only the instruction is a note; a news line that mentions it is not", () => {
    expect(isDeskNote("फोटो के साथ फुलस्क्रीन करावें")).toBe(true);
    expect(isDeskNote("लोगों ने फुलस्क्रीन करें कहा तो भीड़ जुटी")).toBe(false);
    const s = parse(["बाजार में रौनक", "नोट :- फोटो के साथ फुल स्क्रीन कराएं", "लोगों ने फुलस्क्रीन करें कहा तो भीड़ जुटी"]);
    expect(s.points).toEqual(["लोगों ने फुलस्क्रीन करें कहा तो भीड़ जुटी"]);
    expect(s.deskNote).toBe("नोट :- फोटो के साथ फुल स्क्रीन कराएं");
  });
  it("'नोट और दारू' (bank notes) is news", () => {
    expect(parse(["पुलिस की कार्रवाई", "नोट और दारू के साथ आरोपी गिरफ्तार"]).points).toEqual(["नोट और दारू के साथ आरोपी गिरफ्तार"]);
  });
});

describe("review fixes (17 Nov)", () => {
  it("'आकोला:100 साल' (no space after the colon) keeps every word and raises no flag", () => {
    const s = parse(["आकोला:100 साल पुरानी परंपरा", "गांव में उत्सव"]);
    expect(s.headline).toBe("100 साल पुरानी परंपरा");
    expect(s.needsCheck).not.toContain("text_changed");
  });
  it("a dateline broken over two lines ('जयपुर के' / 'चाकसू से खबर') comes off whole, with no flag", () => {
    const s = parse(["जयपुर के", "चाकसू से खबर", "थाना पुलिस की कार्रवाई", "आरोपी गिरफ्तार"]);
    expect([s.headline, s.district]).toEqual(["थाना पुलिस की कार्रवाई", "Jaipur"]);
    expect(s.needsCheck).not.toContain("text_changed");
  });
  it("'नोट-बंदी के बाद ...' is news; 'नोट---हाईकोर्ट की फोटो के साथ ...' is a note; a long line ending in the instruction is a note", () => {
    expect(isDeskNote("नोट-बंदी के बाद बाजार में रौनक")).toBe(false);
    expect(parse(["बाजार की खबर", "नोट-बंदी के बाद बाजार में रौनक"]).points).toEqual(["नोट-बंदी के बाद बाजार में रौनक"]);
    expect(isDeskNote("नोट---हाईकोर्ट और विद्याधर बाग की फोटो के साथ फुल स्क्रीन कराएं")).toBe(true);
    expect(isDeskNote("नोट--मुख्य सचिव की फोटो के साथ फुल स्क्रीन करवाएं")).toBe(true);
    expect(isDeskNote("पंचायत चुनाव की मतदान प्रक्रिया से जुड़ी फोटो के साथ फुलस्क्रीन करावें")).toBe(true);
  });
  it("a run of dashes before a number stays whole; a one-letter word is text, a stray keystroke is not", () => {
    expect(parse(["घायलों की संख्या", "--5 लोग घायल"]).points).toEqual(["--5 लोग घायल"]);
    expect(parse(["मंदिर में आयोजन", "ॐ", "भक्तों की भीड़", "ब्"]).points).toEqual(["ॐ", "भक्तों की भीड़"]);
  });
});

describe("datelines the desk writes, read as datelines; anything with other words stays text", () => {
  it("'बीकानेर से दुखद खबर', 'चूरू के खबर', 'हिण्डौन सिटी खबर', 'झुंझुनूं के उदयपुरवाटी से दर्दनाक खबर', 'जयपुर से इस वक्त की बड़ी खबर'", () => {
    expect(parse(["बीकानेर से दुखद खबर", "हादसे में दो की मौत", "पुलिस मौके पर"]).district).toBe("Bikaner");
    expect(parse(["चूरू के खबर", "मतदान शांतिपूर्ण संपन्न", "शाम तक कतारें"]).district).toBe("Churu");
    const u = parse(["झुंझुनूं के उदयपुरवाटी से दर्दनाक खबर", "करंट से 5 मजदूरों की मौत", "गांव में मातम"]);
    expect([u.headline, u.district, u.town]).toEqual(["करंट से 5 मजदूरों की मौत", "Jhunjhunu", "उदयपुरवाटी"]);
    const j = parse(["जयपुर से इस वक्त की बड़ी खबर", "स्पेशल पुलिस कमिश्नर का बड़ा एक्शन", "कई अफसर हटाए"]);
    expect([j.headline, j.district, j.town]).toEqual(["स्पेशल पुलिस कमिश्नर का बड़ा एक्शन", "Jaipur", null]);
  });
  it("'आबूरोड से रेलवे की बड़ी खबर' keeps 'रेलवे': it is the headline, not a dateline", () => {
    expect(parse(["आबूरोड से रेलवे की बड़ी खबर", "12 ट्रेनों का समय बदला", "यात्री ध्यान दें"]).headline).toBe("आबूरोड से रेलवे की बड़ी खबर");
  });
});

describe("safety net: lostWords counts every word", () => {
  it("fires on a dropped number, even when the same number is elsewhere in the story", () => {
    // "85.59" became "59": both the lost word and a changed one are reported
    expect(lostWords(["85.59 प्रतिशत मतदान"], [], ["59 प्रतिशत मतदान"])).toEqual(["85.59"]);
    // A "20" dropped from one line is not hidden by the "20" of another
    expect(lostWords(["20 लोग घायल", "20 मिनट देरी"], [], ["लोग घायल", "20 मिनट देरी"])).toEqual(["20"]);
  });
  it("fires on a dropped Hindi or English word", () => {
    expect(lostWords(["विधायक बोले: सड़क जल्द बनेगी"], [], ["सड़क जल्द बनेगी"])).toEqual(["विधायक", "बोले"]);
    expect(lostWords(["SMS अस्पताल की Emergency सेवाएं"], [], ["SMS अस्पताल की सेवाएं"])).toEqual(["Emergency"]);
  });
  it("text taken off on purpose is not a loss; a district name is not credited unless the desk's own line carried it", () => {
    expect(lostWords(["जयपुर", "शहर में जाम"], ["जयपुर"], ["शहर में जाम"])).toEqual([]);
    expect(lostWords(["जयपुर में जाम"], [], ["में जाम"])).toEqual(["जयपुर"]);
  });
});

describe("safety net: every word of the file reaches the story", () => {
  it("English words and numbers count too, and nothing is flagged on a normal file", () => {
    const s = parse(["जयपुर: SMS अस्पताल की Emergency सेवाएं होंगी मजबूत", "ICU में 20 नए बेड", "Rs 5.5 करोड़ मंजूर"]);
    expect(text(s)).toContain("Emergency");
    expect(text(s)).toContain("5.5");
    expect(s.needsCheck).not.toContain("text_changed");
  });
  it("text_changed is a serious check (the queue's needs-review flag)", async () => {
    const { SERIOUS_CHECKS } = await import("../src");
    expect(SERIOUS_CHECKS).toContain("text_changed");
  });
  it("the stored test fixtures all keep every word", () => {
    const dir = new URL("./fixtures/breaking/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".txt"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(parseBreaking(readFileSync(new URL(f, dir), "utf8"), f, book).needsCheck, f).not.toContain("text_changed");
  });
});
