// "Create draft" rewording (handoff/web-scraper-contract.md, "Draft rewording"): rules only, no AI, no
// network. Recorded publisher fixtures (Hindi and English) plus small hand-made cases for the edges.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REWRITE_MAX_HEADLINE_CHARS, REWRITE_MAX_SUMMARY_CHARS, RuleRewriter, TOO_CLOSE, boundInput, capText, cleanHeadline, closestSource, copyStats, createRewriter, detectLang, parseRss, phraseCount, phraseWords, referenceTexts, rewriteChecked,
  rewriteModeFrom, splitSentences, stripMarkers, wordTokens, type RawArticle, type RewriteInput, type Rewriter,
} from "../src";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/trends", name), "utf8");
const articles = (file: string): RawArticle[] => parseRss(fixture(file), { name: file, platform: "RSS", rajasthan: true });
const inputOf = (a: RawArticle): RewriteInput => ({
  headline: a.title, summaries: [{ source: a.sourceName, text: a.description }], district: null, lang: detectLang(`${a.title} ${a.description}`),
});
const rw = new RuleRewriter();
const SEED = "2026-10-29T06:00:00.000Z|item";

/** Hindi publisher items with a summary: the typical "Create draft" case */
const HINDI = [...articles("bhaskar-rajasthan.xml"), ...articles("amarujala-rajasthan.xml"), ...articles("navajyoti.xml"), ...articles("abp-rajasthan.xml")];
const ENGLISH = [...articles("the-hindu.xml"), ...articles("toi-jaipur.xml"), ...articles("indianexpress-jaipur.xml"), ...articles("google-news-en.xml")];

const numbers = (t: string) => t.match(/\d+(?:[.,:]\d+)*%?/g) ?? [];
const quotations = (t: string) => t.match(/“[^”]+”|‘[^’]+’|"[^"]+"/gu)?.filter((q) => q.trim().split(/\s+/).length > 2) ?? [];
const hashtags = (t: string) => t.match(/#[\p{L}\p{M}\p{N}_]+/gu) ?? [];

describe("RuleRewriter on recorded publisher items", () => {
  it("is deterministic for a seed, and another seed words it differently", async () => {
    let differ = 0;
    for (const a of HINDI) {
      const one = await rw.rewrite(inputOf(a), SEED);
      expect(await rw.rewrite(inputOf(a), SEED)).toEqual(one);
      const other = await rw.rewrite(inputOf(a), `${SEED}-again`);
      if (`${other.headline}\n${other.body}` !== `${one.headline}\n${one.body}`) differ++;
      // Over a few drafts every item gets more than one wording
      const texts = new Set(["a", "b", "c", "d"].map((s) => rw.rewriteSync(inputOf(a), `${SEED}|${s}`)).map((o) => `${o.headline}\n${o.body}`));
      expect(texts.size, a.title).toBeGreaterThan(1);
    }
    expect(differ / HINDI.length).toBeGreaterThanOrEqual(0.9);
  });

  it("never changes a number, a long quotation or a hashtag, and never adds one", () => {
    for (const a of [...HINDI, ...ENGLISH]) {
      const out = rw.rewriteSync(inputOf(a), SEED);
      const source = `${a.title} ${a.description}`;
      const text = `${out.headline} ${out.body}`;
      for (const n of numbers(text)) expect(numbers(source), `${n} in "${text}"`).toContain(n);
      // Every number of the cleaned headline stays in the headline
      for (const n of numbers(cleanHeadline(a.title, { district: null, sources: [a.sourceName] }))) expect(numbers(out.headline), a.title).toContain(n);
      for (const q of quotations(a.title)) expect(out.headline).toContain(q);
      for (const h of hashtags(source)) if (text.includes(h.slice(1))) expect(text).toContain(h);
    }
  });

  it("keeps names, places and dates as written", () => {
    const asaram = articles("abp-rajasthan.xml").find((a) => a.title.includes("आसाराम"))!;
    const out = rw.rewriteSync(inputOf(asaram), SEED);
    expect(out.headline).toContain("जोधपुर");
    expect(out.headline).toContain("आसाराम");
    expect(`${out.headline} ${out.body}`).toContain("सोमवार (26 अक्टूबर)");

    const da = articles("navajyoti.xml").find((a) => a.title.includes("महंगाई भत्ते"))!;
    const daOut = rw.rewriteSync(inputOf(da), SEED);
    expect(daOut.headline).toContain("3%");
    expect(daOut.body).toContain("मोदी कैबिनेट");

    const hc = articles("indianexpress-jaipur.xml").find((a) => a.title.includes("Kanhaiya Lal"))!;
    const hcOut = rw.rewriteSync(inputOf(hc), SEED);
    for (const name of ["Gandhi", "Kanhaiya Lal", "‘Terrorism a weapon of the weak’"]) expect(hcOut.headline).toContain(name);
  });

  it("rewords: no output repeats its source, and typical Hindi items come out below the 0.4 threshold", async () => {
    const sims: number[] = [];
    for (const a of HINDI) {
      const input = inputOf(a);
      const out = await rewriteChecked(rw, input, `${SEED}|${a.url}`);
      expect(out.headline).not.toBe(a.title);
      expect(out.tooClose).toBe(out.similarity > TOO_CLOSE);
      expect(out.similarity).toBeGreaterThanOrEqual(0);
      expect(out.similarity).toBeLessThanOrEqual(1);
      sims.push(out.similarity);
    }
    const under = sims.filter((s) => s <= TOO_CLOSE).length;
    // Bhaskar, Amar Ujala, Navajyoti, ABP: 20 items. Legal/police terms are never swapped, so a single long
    // summary often stays close; about half come out under the threshold (the rest are flagged tooClose)
    expect(under / sims.length).toBeGreaterThanOrEqual(0.5);
    expect([...sims].sort((a, b) => a - b)[sims.length >> 1]).toBeLessThanOrEqual(0.45);
    const bhaskar = await Promise.all(articles("bhaskar-rajasthan.xml").map((a) => rewriteChecked(rw, inputOf(a), `${SEED}|${a.url}`)));
    expect(bhaskar.filter((o) => !o.tooClose).length).toBeGreaterThanOrEqual(4);
  });

  it("rewords English copy too, Title Case headlines included", () => {
    const toi = articles("toi-jaipur.xml").find((a) => a.title.startsWith("RSPCB"))!;
    expect(rw.rewriteSync(inputOf(toi), SEED).headline).toBe("RSPCB to track air, noise pollution before Diwali");
    const hindu = articles("the-hindu.xml").find((a) => a.title.startsWith("MIDS"))!;
    const out = rw.rewriteSync(inputOf(hindu), SEED);
    // "alleges" is a protected word: that headline stays; another one is reworded
    expect(out.headline).toContain("alleges");
    const governor = articles("toi-jaipur.xml").find((a) => a.title.startsWith("Governor"))!;
    expect(rw.rewriteSync(inputOf(governor), SEED).headline).not.toBe(governor.title);
    expect(out.body).toContain("Prof. Kalaiyarasan");
    expect(out.body).not.toMatch(/\ban probe\b|\ba inquiry\b/);
  });
});

describe("cleaning", () => {
  const noisy: RewriteInput = {
    headline: "Rajasthan News: जयपुर में सड़क हादसे में 3 की मौत, 5 घायल; जानें पूरा मामला - Dainik Bhaskar",
    district: "Jaipur",
    lang: "hi",
    summaries: [{
      source: "Dainik Bhaskar",
      text:
        "Jaipur Road Accident News: जयपुर। नमस्कार, अजमेर रोड पर गुरुवार सुबह 6 बजे तेज रफ्तार ट्रक ने कार को टक्कर मार दी। हादसे में 3 लोगों की मौत हो गई और 5 घायल हुए। " +
        "पुलिस ने बताया कि घायलों को एसएमएस अस्पताल में भर्ती कराया गया है। (फाइल फोटो) ये भी पढ़ें: जयपुर में बारिश का अलर्ट। Follow us on X for latest updates. " +
        "© 2026 Dainik Bhaskar. All rights reserved.",
    }],
  };

  it("drops site names, labels, click-bait, datelines, greetings, captions and site furniture", () => {
    for (const seed of ["a", "b", "c", "d"]) {
      const out = rw.rewriteSync(noisy, seed);
      const text = `${out.headline}\n${out.body}`;
      for (const junk of ["Rajasthan News", "जानें", "पूरा मामला", "Dainik Bhaskar", "Jaipur Road Accident News", "जयपुर।", "नमस्कार", "फाइल फोटो", "ये भी पढ़ें", "Follow us", "©", "rights reserved"]) {
        expect(text, seed).not.toContain(junk);
      }
      // The facts stay
      for (const fact of ["जयपुर", "3", "5", "अजमेर रोड", "गुरुवार", "6 बजे", "एसएमएस अस्पताल"]) expect(text, seed).toContain(fact);
      // The headline's facts are not told again in the body
      expect(out.body).not.toMatch(/3 लोगों की/u);
    }
  });

  it("English: Title Case headline with a click-bait tail, dateline, agency credit, Also read", () => {
    const out = rw.rewriteSync({
      headline: "3 Dead After Truck Rams Into Car In Rajasthan's Ajmer; Watch Video",
      district: "Ajmer",
      lang: "en",
      summaries: [{
        source: "NDTV",
        text:
          "AJMER: Three people were killed and five injured when a speeding truck crashed into a car on the Ajmer-Jaipur highway on Thursday morning, police said. " +
          "\"The driver fled the spot,\" SP Devendra Bishnoi told reporters. Also read: Rajasthan weather update. (Representative image)",
      }],
    }, "seed");
    expect(out.headline).not.toMatch(/watch|video/i);
    expect(out.headline).toContain("Rajasthan's Ajmer");
    expect(out.body).not.toMatch(/^AJMER|Also read|Representative/);
    expect(out.body).toContain("\"The driver fled the spot,\" SP Devendra Bishnoi");
  });

  it("cuts Google's '...' on the last whole word and drops the publisher self-promotion", () => {
    expect(cleanHeadline("मिस एंड मिसेज राजस्थान ग्लैमर के ऑडिशन नवंबर में: पेजेंट का पोस्टर लॉन्च, जनवरी में होगा ग्रैंड फिनाले; गां...", { district: null, sources: [] }))
      .toBe("मिस एंड मिसेज राजस्थान ग्लैमर के ऑडिशन नवंबर में: पेजेंट का पोस्टर लॉन्च, जनवरी में होगा ग्रैंड फिनाले");
    const out = rw.rewriteSync({
      headline: "नौकरी के बदले पैसे मांगने वाला अफसर बर्खास्त:आंगनबाड़ी भर्ती निकलते ही एक्टिव हो गई थी दलाल गैंग, भास्कर ने किया था खुलासा",
      district: "Pali", lang: "hi", summaries: [{ source: "Dainik Bhaskar", text: "" }],
    }, "x");
    expect(out.headline).not.toContain("भास्कर");
    expect(out.headline).toContain("दलाल गैंग");
  });
});

describe("what is never touched", () => {
  const one = (text: string, seed = "s") => rw.rewriteSync({ headline: text, summaries: [], lang: detectLang(text) }, seed).headline;

  it("names of states, schemes and quoted words", () => {
    for (const seed of ["1", "2", "3", "4", "5"]) {
      const states = one("मध्य प्रदेश में भारी बारिश से नदियां उफान पर, उत्तर प्रदेश के कई जिलों में अलर्ट", seed);
      expect(states).toContain("मध्य प्रदेश में");
      expect(states).toContain("उत्तर प्रदेश के");
      expect(one("प्रधानमंत्री फसल बीमा योजना में किसानों को 345 करोड़ जारी", seed)).toContain("प्रधानमंत्री फसल बीमा योजना");
      expect(one("मंत्री बोले- “पुलिस ने बताया कि मामला दर्ज हुआ है” और जांच जारी", seed)).toContain("“पुलिस ने बताया कि मामला दर्ज हुआ है”");
      expect(one("#JaipurMetro पर काम शुरू, 400 करोड़ की लागत से बनेगा कॉरिडोर", seed)).toContain("#JaipurMetro");
      // "और" meaning "more" stays; a hyphenated compound stays whole
      expect(one("घर-घर सर्वे के बाद बारिश और तेज होगी, मौसम विभाग ने चेताया", seed)).toMatch(/घर-घर.*और तेज/u);
    }
  });

  it("Devanagari stays whole: NFC, no mark without its letter, every word from the source or the tables", () => {
    const known = phraseWords();
    const extra = new Set(["इसमें", "इससे", "इसके", "इसे", "वहां"]);
    for (const a of HINDI) {
      const out = rw.rewriteSync(inputOf(a), SEED);
      const text = `${out.headline} ${out.body}`;
      expect(text).toBe(text.normalize("NFC"));
      expect(text).not.toMatch(/(?:^|[\s\p{P}])\p{M}/u);
      // ":" joins words for the segmenter ("चेतावनी:तूफान"); the rewrite splits them, so compare word by word
      const sourceWords = new Set(wordTokens(`${a.title} ${a.description}`.replace(/:/gu, " ")));
      for (const w of wordTokens(text)) {
        if (!/\p{Script=Devanagari}/u.test(w) || sourceWords.has(w) || known.has(w) || extra.has(w)) continue;
        // A participle turned round: खरीदकर ↔ खरीदने
        const stem = w.replace(/(?:ने|कर)$/u, "");
        expect(sourceWords.has(`${stem}कर`) || sourceWords.has(`${stem}ने`), `"${w}" in "${text}"`).toBe(true);
      }
    }
  });
});

describe("facts that a near-synonym would change", () => {
  const SEEDS = Array.from({ length: 12 }, (_, i) => `seed-${i}`);
  const body = (text: string, seed: string) => rw.rewriteSync({ headline: "खबर", summaries: [{ source: "S", text }], lang: detectLang(text) }, seed).body;

  // Legal, police and casualty terms: each stays exactly as the publisher wrote it, whatever the seed
  const HINDI_TERMS: [term: string, sentence: string][] = [
    ["गिरफ्तार किया गया", "पुलिस थाने में दो युवकों को गिरफ्तार किया गया और पूछताछ जारी है।"],
    ["गिरफ्तार कर लिया", "पुलिस ने शाम को तीनों युवकों को गिरफ्तार कर लिया और थाने ले गई।"],
    ["बरामद किया", "पुलिस ने आरोपी के घर से 20 लाख रुपये बरामद किया और जांच जारी रखी।"],
    ["जब्त किया", "विभाग की टीम ने दुकान से 200 किलो मावा जब्त किया और नमूने भेजे।"],
    ["आरोपी", "अदालत ने तीनों आरोपी युवकों को 14 दिन की न्यायिक हिरासत में भेजा।"],
    ["अभियुक्त", "अदालत ने अभियुक्त को दोषी करार देते हुए सजा सुनाई।"],
    ["की जांच", "मामले की जांच एसओजी को सौंपी गई है और रिपोर्ट मांगी गई है।"],
    ["हत्या", "गोली मारकर युवक की हत्या कर दी गई और हमलावर मौके से भाग गए।"],
    ["मारकर", "गोली मारकर युवक की हत्या कर दी गई और हमलावर मौके से भाग गए।"],
    ["काटकर", "बदमाशों ने ताला काटकर दुकान से नकदी चुरा ली और भाग गए।"],
    ["घायल", "हादसे में दो लोग घायल हुए और उन्हें अस्पताल भेजा गया।"],
    ["फर्जी", "फर्जी प्रमाण पत्र से नौकरी पाने के मामले में चार लोगों पर केस हुआ।"],
    ["धोखाधड़ी", "कंपनी के निदेशक पर धोखाधड़ी का मामला दर्ज हुआ है।"],
    ["पर रोक लगा दी", "हाईकोर्ट ने भर्ती प्रक्रिया पर रोक लगा दी और सरकार से जवाब मांगा।"],
    ["फरार हो गया", "घटना के बाद बस चालक फरार हो गया और पुलिस तलाश कर रही है।"],
    ["नियुक्त", "सरकार ने उन्हें जिला कलेक्टर के पद पर नियुक्त किया है।"],
    ["चेतावनी", "मौसम विभाग ने 15 जिलों में भारी बारिश की चेतावनी जारी की गई है।"],
    ["पुलिस", "पुलिस और प्रशासन की टीम मौके पर पहुंची और लोगों को हटाया।"],
  ];
  const ENGLISH_TERMS: [term: string, sentence: string][] = [
    ["arrested", "The police arrested two men from the bus stand late in the evening."],
    ["detained", "The police detained two men for questioning near the bus stand."],
    ["dead", "Two people were found dead inside the house near the railway station."],
    ["killed", "Two people were killed when the roof of the old school collapsed."],
    ["murder", "The court framed charges of murder against the three men in the case."],
    ["alleged", "The family alleged that the hospital staff ignored the patient for hours."],
    ["seized", "The officers seized 20 kg of poppy husk from the truck at the check post."],
    ["investigation", "The state has ordered an investigation into the collapse of the bridge."],
    ["inquiry", "The collector ordered an inquiry into the death of the student."],
    ["probe", "The committee will probe the purchase of the villas by the officer."],
    ["injured", "Five people were injured in the clash between the two groups."],
    ["convicted", "The court convicted the man of the robbery after a long trial."],
    ["registered", "A case was registered against the driver of the truck at the station."],
    ["rape", "The police registered a rape case against the man on Monday."],
    ["assault", "The teacher faces an assault case filed by the parents of the student."],
  ];

  it("keeps legal, police and casualty terms word for word", () => {
    for (const [term, sentence] of [...HINDI_TERMS, ...ENGLISH_TERMS]) {
      for (const seed of SEEDS) expect(body(sentence, seed), `${term} (${seed})`).toContain(term);
    }
  });

  it("has no table entry that would swap one of them", () => {
    const words = phraseWords();
    for (const w of ["अभियुक्त", "अभियुक्तों", "पड़ताल", "कत्ल", "दबोच", "जाली", "ठगी", "पाबंदी", "तैनात", "nabbed", "detained", "killing", "claimed", "confiscated", "inquiry", "hurt", "cleared"]) {
      expect(words.has(w), w).toBe(false);
    }
  });

  it("turns only a sequence participle round, never an instrumental one", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      seen.add(body("वह बाजार जाकर सब्जी खरीदकर घर लौटा और फिर काम पर गया।", seed));
      const how = body("बदमाशों ने गोली मारकर युवक की हत्या की और बाइक छीनकर भाग गए।", seed);
      expect(how).toContain("गोली मारकर");
      expect(how).toContain("छीनकर");
      expect(how).not.toMatch(/मारने के|छीनने के/u);
    }
    expect([...seen].some((t) => /जाने के (?:बाद|पश्चात)|खरीदने के (?:बाद|पश्चात)/u.test(t))).toBe(true);
  });

  it("never drops quotation marks, even around one word", () => {
    for (const seed of SEEDS) {
      const h = rw.rewriteSync({ headline: "जीत पर रोए सरपंच, किरोड़ी-समर्थकों का 'डांस':'बोतल वाले' सांसद बोले- ‘फूल’ मत बरसाओ", summaries: [], lang: "hi" }, seed).headline;
      for (const q of ["'डांस'", "'बोतल वाले'", "‘फूल’"]) expect(h, seed).toContain(q);
    }
  });
});

describe("bounded input", () => {
  it("strips the mask's private-use markers and caps headline and summaries on a space", () => {
    const sneaky = "जयपुर में 0 बारिश  हुई";
    const out = rw.rewriteSync({ headline: sneaky, summaries: [{ source: "S", text: `${sneaky}। ${sneaky}।` }], lang: "hi" }, "s");
    expect(`${out.headline}${out.body}`).not.toMatch(/[]/u);
    const long = boundInput({ headline: "शब्द ".repeat(200), summaries: [{ source: "S", text: "वाक्य ".repeat(3000) }], lang: "hi" });
    expect(long.headline.length).toBeLessThanOrEqual(REWRITE_MAX_HEADLINE_CHARS);
    expect(long.summaries[0]!.text.length).toBeLessThanOrEqual(REWRITE_MAX_SUMMARY_CHARS);
    expect(long.headline.endsWith("शब्द")).toBe(true);
    expect(capText("abc def", 5)).toBe("abc");
    expect(stripMarkers("abc")).toBe("abc");
  });

  it("stays fast on long, punctuation-heavy text (no quadratic scans)", async () => {
    const huge = `${"राजस्थान में बारिश हुई. ".repeat(2000)}${"a. ".repeat(5000)}`;
    const started = Date.now();
    splitSentences(huge);
    await rewriteChecked(rw, { headline: "राजस्थान में बारिश ".repeat(50), summaries: [{ source: "S", text: huge }, { source: "T", text: huge }], lang: "hi" }, "s");
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("blending several publishers of one story", () => {
  const cluster: RewriteInput = {
    headline: "जोधपुर में सड़क हादसे में 4 की मौत",
    district: "Jodhpur",
    lang: "hi",
    summaries: [
      { source: "Dainik Bhaskar", text: "जोधपुर में बुधवार रात तेज रफ्तार बस ने जीप को टक्कर मार दी। हादसे में 4 लोगों की मौत हो गई।" },
      { source: "Rajasthan Patrika", text: "जोधपुर में बस और जीप की भिड़ंत\nहादसे में 4 लोगों की मौत हो गई। मृतकों में 2 महिलाएं शामिल हैं।" },
      { source: "Amar Ujala", text: "जोधपुर हादसा\nपुलिस ने बताया कि बस चालक फरार हो गया। मुख्यमंत्री भजनलाल शर्मा ने हादसे पर दुख जताया।" },
    ],
  };

  it("takes facts from more than one publisher, each fact once, and stays well under the threshold", async () => {
    for (const seed of ["a", "b", "c"]) {
      const out = await rewriteChecked(rw, cluster, seed);
      expect(out.usedSources[0]).toBe("Dainik Bhaskar");
      expect(out.usedSources.length).toBeGreaterThanOrEqual(2);
      expect(out.body).toContain("बस चालक");
      expect(out.body).toContain("भजनलाल शर्मा");
      expect(out.body.match(/बुधवार रात/gu)).toHaveLength(1);
      // "4 लोगों की मौत" is in the headline already: not again in the body
      expect(out.body).not.toContain("4 लोगों");
      expect(out.similarity).toBeLessThan(0.3);
    }
  });

  it("blends a recorded cluster (Bhaskar + Amar Ujala + Google News on the panchayat vote)", async () => {
    const bhaskar = articles("bhaskar-rajasthan.xml").find((a) => a.title.startsWith("पंचायत-चुनाव के दूसरे चरण"))!;
    const ujala = articles("amarujala-rajasthan.xml").find((a) => a.title.includes("64.32"))!;
    const input: RewriteInput = {
      headline: bhaskar.title, district: null, lang: "hi",
      summaries: [{ source: "Dainik Bhaskar", text: bhaskar.description }, { source: "Amar Ujala", text: `${ujala.title}\n${ujala.description}` }],
    };
    const out = await rewriteChecked(rw, input, SEED);
    expect(out.usedSources).toEqual(["Dainik Bhaskar", "Amar Ujala"]);
    expect(out.body).toContain("64.32");
    expect(out.tooClose).toBe(false);
  });
});

describe("similarity and the retry gate", () => {
  it("word 4-gram overlap and the longest copied run", () => {
    const s = "राजस्थान में पंचायत चुनाव के दूसरे चरण में बुधवार को 22 जिलों में वोटिंग हुई";
    expect(copyStats(s, s)).toEqual({ overlap: 1, longestRun: wordTokens(s).length, similarity: 1 });
    expect(copyStats("एकदम अलग शब्दों वाला वाक्य यहां", s).similarity).toBe(0);
    const half = copyStats("राजस्थान में पंचायत चुनाव के दूसरे चरण में मतदान संपन्न हुआ और नतीजे जल्द आएंगे", s);
    expect(half.longestRun).toBe(8);
    expect(half.similarity).toBeGreaterThan(0.3);
    expect(half.similarity).toBeLessThan(0.6);
    expect(closestSource(s, [{ source: "A", text: "कुछ और" }, { source: "B", text: s }]).source).toBe("B");
  });

  it("tries up to 3 more seeds when too close and keeps the least similar", async () => {
    const input: RewriteInput = { headline: "एक दो तीन चार पांच छह", summaries: [{ source: "X", text: "सात आठ नौ दस ग्यारह बारह" }], lang: "hi" };
    const seen: string[] = [];
    const copier: Rewriter = {
      name: "rules",
      async rewrite(_i, seed) {
        seen.push(seed);
        // The 3rd seed copies least
        return seed.endsWith("#2") ? { headline: "बिलकुल नया शीर्षक यहां", body: "", usedSources: ["X"] } : { headline: "एक दो तीन चार पांच छह", body: "सात आठ नौ दस", usedSources: ["X"] };
      },
    };
    const out = await rewriteChecked(copier, input, "seed");
    expect(seen).toEqual(["seed", "seed#1", "seed#2"]);
    expect(out).toMatchObject({ headline: "बिलकुल नया शीर्षक यहां", tooClose: false, similarity: 0, seed: "seed#2", attempts: 3 });

    const stubborn: Rewriter = { name: "rules", rewrite: async () => ({ headline: "एक दो तीन चार पांच छह", body: "", usedSources: [] }) };
    const kept = await rewriteChecked(stubborn, input, "s");
    expect(kept).toMatchObject({ tooClose: true, attempts: 4 });
    expect(kept.similarity).toBeGreaterThan(TOO_CLOSE);
    expect(referenceTexts(input)[0]!.text).toContain("एक दो तीन");
  });
});

describe("REWRITE_MODE and the tables", () => {
  it("rules is the default and the only mode; anything else is refused", () => {
    expect(rewriteModeFrom(undefined)).toBe("rules");
    expect(rewriteModeFrom("")).toBe("rules");
    expect(rewriteModeFrom(" rules ")).toBe("rules");
    expect(() => rewriteModeFrom("local-llm")).toThrow(/not available/);
    expect(createRewriter("rules").name).toBe("rules");
  });

  it("has 150+ Hindi and English phrases", () => {
    expect(phraseCount()).toBeGreaterThanOrEqual(300);
  });

  it("splits Hindi and English sentences without breaking decimals, times, initials or quotations", () => {
    expect(splitSentences("मतदान सुबह 7 बजे शुरू हुआ। 64.32 प्रतिशत वोट पड़े. कहा, “यह ठीक है। आगे देखेंगे।” फिर लौटे")).toEqual([
      "मतदान सुबह 7 बजे शुरू हुआ।", "64.32 प्रतिशत वोट पड़े.", "कहा, “यह ठीक है। आगे देखेंगे।” फिर लौटे",
    ]);
    expect(splitSentences("Turnout was 13% till 10 a.m. on Friday. Dr. J. Kamatchi spoke at 8:30. Done")).toEqual([
      "Turnout was 13% till 10 a.m. on Friday.", "Dr. J. Kamatchi spoke at 8:30.", "Done",
    ]);
  });
});
