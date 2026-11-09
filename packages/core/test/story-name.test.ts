import { describe, expect, it } from "vitest";
import { parseLinkSlug, storyLinkName, stripPlacePrefix, transliterateWord } from "../src";

// 22:41 IST on 9 November 2026
const AT = "2026-11-09T17:11:30Z";
const SLUG = /^[a-z0-9-]+$/;
const FILE = /^[A-Za-z0-9-]+$/;

describe("transliterateWord", () => {
  it("writes Hindi in plain Latin: matras, halant, anusvara, chandrabindu, nukta, schwa", () => {
    expect(transliterateWord("अस्पताल")).toBe("aspatal");
    expect(transliterateWord("ट्रॉमा")).toBe("trauma");
    expect(transliterateWord("वार्ड")).toBe("vard");
    expect(transliterateWord("लोकार्पण")).toBe("lokarpan");
    expect(transliterateWord("नए")).toBe("naye");
    expect(transliterateWord("में")).toBe("men");
    expect(transliterateWord("संबंध")).toBe("sambandh");
    expect(transliterateWord("हँसी")).toBe("hansi");
    expect(transliterateWord("क़ानून")).toBe("qanun");
    expect(transliterateWord("ज़रूरी")).toBe("zaruri");
    expect(transliterateWord("बिगड़े")).toBe("bigre");
    // Medial schwa between a vowel and a consonant-plus-vowel; a final conjunct keeps its a
    expect(transliterateWord("जयपुर")).toBe("jaypur");
    expect(transliterateWord("समझना")).toBe("samajhna");
    expect(transliterateWord("पत्र")).toBe("patra");
    expect(transliterateWord("स्वास्थ्य")).toBe("svasthya");
    // One syllable keeps it
    expect(transliterateWord("व")).toBe("va");
    expect(transliterateWord("२०२६")).toBe("2026");
    expect(transliterateWord("SMS")).toBe("SMS");
  });

  it("is stable: the same word always gives the same Latin", () => {
    const w = "मुख्यमंत्री";
    expect(transliterateWord(w)).toBe(transliterateWord(w.normalize("NFD")));
    expect(transliterateWord(w)).toBe("mukhyamantri");
  });
});

describe("stripPlacePrefix", () => {
  it("takes off a place before a colon, a district before a dash, or a district as the first word", () => {
    expect(stripPlacePrefix("#Jaipur: नई सड़क बनी", "Jaipur")).toBe("नई सड़क बनी");
    expect(stripPlacePrefix("मेड़ता सिटी : नई सड़क बनी", "Nagaur")).toBe("नई सड़क बनी");
    expect(stripPlacePrefix("जयपुर- नई सड़क बनी", "Jaipur")).toBe("नई सड़क बनी");
    expect(stripPlacePrefix("कोटा में बारिश", "Kota")).toBe("में बारिश");
  });

  it("leaves a headline that only starts like one", () => {
    expect(stripPlacePrefix("कोटा", "Kota")).toBe("कोटा");
    expect(stripPlacePrefix("Kota: rain", "Kota")).toBe("Kota: rain");
    expect(stripPlacePrefix("जयपुर में बारिश", "Kota")).toBe("जयपुर में बारिश");
  });
});

describe("storyLinkName", () => {
  it("names a Hindi story by district, headline and IST time (the owner's example)", () => {
    expect(storyLinkName({ district: "Jaipur", headline: "जयपुर: SMS अस्पताल में नए ट्रॉमा वार्ड का लोकार्पण", receivedAt: AT })).toEqual({
      linkSlug: "jaipur-sms-aspatal-men-naye-trauma-vard-ka-lokarpan-2241",
      fileStem: "Jaipur-SMS-aspatal-men-naye-trauma-vard-09Nov-2241",
    });
  });

  it("takes a Date as well as an ISO string, and reads the clock in IST across midnight", () => {
    expect(storyLinkName({ district: "Kota", headline: "बारिश", receivedAt: new Date(AT) }).linkSlug).toBe("kota-barish-2241");
    // 19:00 UTC on 9 Nov is 00:30 on 10 Nov in India
    expect(storyLinkName({ district: "Kota", headline: "बारिश", receivedAt: "2026-11-09T19:00:00Z" })).toEqual({
      linkSlug: "kota-barish-0030",
      fileStem: "Kota-barish-10Nov-0030",
    });
  });

  it("does not repeat the district: a hashtag prefix or a leading district word goes", () => {
    const n = storyLinkName({ district: "Kota", headline: "#Kota: कोटा में बारिश से हालात बिगड़े, स्कूलों में छुट्टी घोषित", receivedAt: AT });
    expect(n.linkSlug).toBe("kota-men-barish-se-halat-bigre-skulon-men-chhutti-2241");
    expect(n.fileStem).toBe("Kota-men-barish-se-halat-bigre-skulon-09Nov-2241");
  });

  it("names a Hindi district by its English name, with spaces as hyphens", () => {
    expect(storyLinkName({ district: "जोधपुर", headline: "जोधपुर- नई सड़क बनी", receivedAt: AT }).linkSlug).toBe("jodhpur-nai-sarak-bani-2241");
    expect(storyLinkName({ district: "Sawai Madhopur", headline: "बाघिन ने दिए तीन शावकों को जन्म", receivedAt: AT })).toEqual({
      linkSlug: "sawai-madhopur-baghin-ne-diye-tin-shavkon-ko-janma-2241",
      fileStem: "Sawai-Madhopur-baghin-ne-diye-tin-shavkon-ko-09Nov-2241",
    });
  });

  it("an English headline keeps its words (and its capitals in the file name)", () => {
    expect(storyLinkName({ district: "Udaipur", headline: "Udaipur: CM Inaugurates New City Bus Service", receivedAt: AT })).toEqual({
      linkSlug: "udaipur-cm-inaugurates-new-city-bus-service-2241",
      fileStem: "Udaipur-CM-Inaugurates-New-City-Bus-Service-09Nov-2241",
    });
  });

  it("uses 'news' without a district", () => {
    expect(storyLinkName({ district: null, headline: "Breaking: PM to visit Jodhpur on Friday", receivedAt: AT })).toEqual({
      linkSlug: "news-pm-to-visit-jodhpur-on-friday-2241",
      fileStem: "News-PM-to-visit-Jodhpur-on-Friday-09Nov-2241",
    });
    expect(storyLinkName({ district: "  ", headline: null, receivedAt: AT })).toEqual({ linkSlug: "news-2241", fileStem: "News-09Nov-2241" });
  });

  it("keeps a long headline to 8 words and 60 characters in the link", () => {
    const n = storyLinkName({
      district: "Bikaner",
      headline: "मुख्यमंत्री ने राजस्थान विधानसभा में किसानों के लिए नई कल्याणकारी योजनाओं की घोषणा की और अधिकारियों को निर्देश दिए",
      receivedAt: AT,
    });
    const words = n.linkSlug.replace(/^bikaner-/, "").replace(/-2241$/, "");
    expect(words.split("-").length).toBeLessThanOrEqual(8);
    expect(words.length).toBeLessThanOrEqual(60);
    expect(n.linkSlug).toMatch(/^bikaner-mukhyamantri-ne-rajasthan-/);
    expect(n.fileStem.split("-").length).toBeLessThanOrEqual(1 + 6 + 2);

    const one = storyLinkName({ district: "Kota", headline: "a".repeat(200), receivedAt: AT });
    expect(one.linkSlug).toBe(`kota-${"a".repeat(60)}-2241`);
  });

  it("drops punctuation and emoji, and keeps both names to their character sets", () => {
    const n = storyLinkName({ district: "Ajmer", headline: "🚨🚨 दरगाह में \"उर्स\" शुरू!!! — ₹5 करोड़ का इंतज़ाम (2026) 🙏", receivedAt: AT });
    expect(n.linkSlug).toBe("ajmer-dargah-men-urs-shuru-5-karor-ka-intazam-2241");
    expect(n.fileStem).toBe("Ajmer-dargah-men-urs-shuru-5-karor-09Nov-2241");
    expect(storyLinkName({ district: "Udaipur", headline: "😀🔥!!", receivedAt: AT }).linkSlug).toBe("udaipur-2241");
    expect(storyLinkName({ district: "Delhi / NCR", headline: "Café's re-opening", receivedAt: AT }).linkSlug).toBe("delhi-ncr-cafe-s-re-opening-2241");
  });

  it("always gives names in the allowed characters that resolve's pattern accepts", () => {
    const cases = [
      { district: "Sri Ganganagar", headline: "श्रीगंगानगर: नहर में पानी", receivedAt: AT },
      { district: null, headline: "॥ ॐ ॥", receivedAt: AT },
      { district: "Chittorgarh", headline: "चित्तौड़गढ़ किले में रोशनी", receivedAt: AT },
    ];
    for (const c of cases) {
      const n = storyLinkName(c);
      expect(n.linkSlug).toMatch(SLUG);
      expect(n.linkSlug).toMatch(/^[a-z0-9-]{3,120}$/);
      expect(n.fileStem).toMatch(FILE);
      expect(storyLinkName(c)).toEqual(n);
    }
  });
});

describe("parseLinkSlug", () => {
  it("reads the IST hour and minute and whether there is a district", () => {
    expect(parseLinkSlug("jaipur-sms-aspatal-2241")).toEqual({ hour: 22, minute: 41, noDistrict: false, districtPrefix: "jaipur" });
    expect(parseLinkSlug("news-2241")).toMatchObject({ hour: 22, minute: 41, noDistrict: true });
    expect(parseLinkSlug("jaipur-2461")).toBeNull();
    expect(parseLinkSlug("jaipur-sms")).toBeNull();
    expect(parseLinkSlug("2241")).toBeNull();
  });
});
