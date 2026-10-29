import { describe, expect, it } from "vitest";
import {
  BODY_CUT, COMPOSE_FORMAT, ELLIPSIS, FALLBACK_TOPIC_TAG, RuleComposer, X_LIMIT, assemblePostText, bodyBudget, bodyExcerpt, checkXPost,
  composeXText, cutOnWords, districtHashtag, firstIndiaText, handleGazetteer, hashtagGazetteer, selectTagLine, truncateHeadline, xLen,
  type HashtagRule,
} from "../src";

describe("xLen", () => {
  it("counts Devanagari per code point", () => {
    expect(xLen("दिल्ली")).toBe(6);
  });

  it("weighs the ellipsis 2 and an emoji 2", () => {
    expect(xLen(ELLIPSIS)).toBe(2);
    expect(xLen("👍🏽")).toBe(2);
  });
});

describe("truncateHeadline", () => {
  it("keeps a short headline whole, with no ellipsis", () => {
    expect(truncateHeadline("जयपुर में भारी बारिश", 200)).toEqual({ text: "जयपुर में भारी बारिश", truncated: false });
  });

  it("cuts after 9 words and adds an ellipsis", () => {
    const headline = "एक दो तीन चार पांच छह सात आठ नौ दस ग्यारह";
    expect(truncateHeadline(headline, 200).text).toBe(`एक दो तीन चार पांच छह सात आठ नौ${ELLIPSIS}`);
  });

  it("never splits a syllable when the budget is tight", () => {
    const { text } = truncateHeadline("मुख्यमंत्री", 5);
    const body = text.replace(ELLIPSIS, "");
    expect("मुख्यमंत्री".startsWith(body)).toBe(true);
    expect(xLen(body)).toBeLessThanOrEqual(5);
    expect(body.endsWith("्")).toBe(false);
  });

  it("drops a dangling danda or comma before the ellipsis", () => {
    const { text } = truncateHeadline("एक दो तीन चार पांच छह सात आठ नौ, दस", 200);
    expect(text).toBe(`एक दो तीन चार पांच छह सात आठ नौ${ELLIPSIS}`);
  });
});

describe("composeXText", () => {
  it("always fits X's limit, tags included", () => {
    const tags = Array.from({ length: 4 }, (_, i) => `#बहुतलंबाहैशटैग${i}`);
    const text = composeXText("राजस्थान ".repeat(80), tags, ["@CMOfficeRaj"]);
    expect(xLen(text)).toBeLessThanOrEqual(X_LIMIT);
  });

  it("puts the tag line after a blank line", () => {
    expect(assemblePostText("खबर", ["#Jaipur"], ["@JDA"])).toBe("खबर\n\n#Jaipur @JDA");
  });

  it("budgets for the separator and the ellipsis", () => {
    expect(bodyBudget(["#ab"], [])).toBe(X_LIMIT - 3 - 2 - 2);
  });
});

describe("checkXPost", () => {
  it("refuses a link, with the reason", () => {
    const check = checkXPost("पूरी खबर jaipur.gov.in/news पर");
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain("13 times");
  });

  it("refuses an over-long post", () => {
    expect(checkXPost("क".repeat(281)).problems[0]).toContain("1 characters over");
  });

  it("accepts a normal post", () => {
    expect(checkXPost("जयपुर मेट्रो फेज-2 को मंजूरी\n\n#Jaipur").ok).toBe(true);
  });

  it("refuses a post that is only hashtags and mentions", () => {
    expect(checkXPost("#Jaipur: \n\n#RajasthanWithFirstIndia @BhajanlalBjp").problems[0]).toContain("only hashtags");
    expect(checkXPost("#Jaipur: खबर\n\n#RajasthanWithFirstIndia").ok).toBe(true);
  });
});

// The sample post from First India's X account (28 Oct 2026)
const HC_HEADLINE = "राजस्थान हाईकोर्ट का SI भर्ती-2016 को लेकर बड़ा निर्णय";
const HC_BODY =
  "50% आरक्षण सीमा के अनुसार पदों की होगी पुनर्गणना के आदेश, 90 दिन में पदों की पुनर्गणना कर संशोधित सूची जारी करने के आदेश दिए गए हैं। " +
  "कोर्ट ने कहा कि भर्ती प्रक्रिया में आरक्षण के नियमों का पालन जरूरी है और राज्य सरकार को तय समय में पालना रिपोर्ट पेश करनी होगी। " +
  "याचिकाकर्ताओं की ओर से वरिष्ठ अधिवक्ता ने पैरवी की।";

const rule = (r: Partial<HashtagRule> & Pick<HashtagRule, "id" | "name" | "hashtagLatin">): HashtagRule => ({
  matchType: "entity", aliases: [], hashtagDevanagari: null, priority: 5, ...r,
});

const gazetteer = hashtagGazetteer([
  rule({ id: "d1", matchType: "district", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर" }),
  rule({ id: "d2", matchType: "district", name: "सवाई माधोपुर", aliases: ["Sawai Madhopur"], hashtagLatin: "SawaiMadhopur" }),
  rule({ id: "c1", matchType: "city", name: "कोटा", aliases: ["Kota"], hashtagLatin: "Kota" }),
  rule({ id: "t1", name: "हाईकोर्ट", aliases: ["हाई कोर्ट", "उच्च न्यायालय"], hashtagLatin: "RajasthanHighCourt", priority: 8 }),
  rule({ id: "t2", name: "पुलिस", aliases: ["चोरी"], hashtagLatin: "RajasthanPolice" }),
]);

describe("districtHashtag", () => {
  it("uses the gazetteer's Latin tag for a known place, in either script", () => {
    expect(districtHashtag("Jaipur", gazetteer)).toBe("#Jaipur");
    expect(districtHashtag("जयपुर", gazetteer)).toBe("#Jaipur");
    expect(districtHashtag("Sawai Madhopur", gazetteer)).toBe("#SawaiMadhopur");
  });

  it("builds the tag from an unknown name: words capitalised, spaces dropped", () => {
    expect(districtHashtag("sri ganganagar", gazetteer)).toBe("#SriGanganagar");
    expect(districtHashtag("Jhunjhunu", gazetteer)).toBe("#Jhunjhunu");
  });

  it("never takes a topic rule as the district", () => {
    expect(districtHashtag("पुलिस", gazetteer)).toBe("#पुलिस");
  });
});

describe("selectTagLine", () => {
  const cfg = { script: "latin" as const, fixed: ["#RajasthanWithFirstIndia"], max: 4 };

  it("puts the fixed tag first, then topic tags; places stay out", () => {
    expect(selectTagLine(`जयपुर: ${HC_HEADLINE} कोटा पुलिस`, gazetteer, cfg)).toEqual(["#RajasthanWithFirstIndia", "#RajasthanHighCourt", "#RajasthanPolice"]);
  });

  it("adds #FirstIndiaNews only when no topic matched and the org has no fixed tag", () => {
    expect(selectTagLine("जयपुर में बारिश", gazetteer, cfg)).toEqual(["#RajasthanWithFirstIndia"]);
    expect(selectTagLine("जयपुर में बारिश", gazetteer, { ...cfg, fixed: [] })).toEqual([FALLBACK_TOPIC_TAG]);
    expect(selectTagLine("जयपुर पुलिस", gazetteer, { ...cfg, fixed: [] })).toEqual(["#RajasthanPolice"]);
  });

  it("skips excluded tags and respects the cap", () => {
    expect(selectTagLine("हाईकोर्ट पुलिस", gazetteer, { ...cfg, max: 2 }, ["#RajasthanHighCourt"])).toEqual(["#RajasthanWithFirstIndia", "#RajasthanPolice"]);
    expect(selectTagLine("हाईकोर्ट", gazetteer, { ...cfg, max: 1 })).toEqual(["#RajasthanWithFirstIndia"]);
  });
});

describe("bodyExcerpt and cutOnWords", () => {
  it("makes one paragraph, without links or a repeated headline", () => {
    expect(bodyExcerpt("पहली पंक्ति।\n\nदूसरी www.example.com पंक्ति", "")).toBe("पहली पंक्ति। दूसरी पंक्ति");
    expect(bodyExcerpt("खबर का पहला वाक्य। आगे की बात", "खबर का पहला वाक्य")).toBe("आगे की बात");
  });

  it("strips every link, however many", () => {
    const links = Array.from({ length: 30 }, (_, i) => `site${i}.com/x https://t.co/${i}`).join(" खबर ");
    const out = bodyExcerpt(`शुरू ${links} अंत`);
    expect(checkXPost(out).problems.some((p) => p.includes("link"))).toBe(false);
    expect(out.startsWith("शुरू")).toBe(true);
    expect(out.endsWith("अंत")).toBe(true);
  });

  it("strips a repeated headline only as a whole word", () => {
    expect(bodyExcerpt("जयपुरवासियों ने दीवाली मनाई", "जयपुर")).toBe("जयपुरवासियों ने दीवाली मनाई");
    expect(bodyExcerpt("जयपुर, शहर में रौनक", "जयपुर")).toBe("शहर में रौनक");
    expect(bodyExcerpt("जयपुर", "जयपुर")).toBe("");
  });

  it("cuts on a whole word and drops trailing punctuation", () => {
    expect(cutOnWords("एक दो, तीन चार", 7)).toBe("एक दो");
    expect(cutOnWords("मुख्यमंत्री", 5)).toBe("");
    expect(cutOnWords("एक दो", 0)).toBe("");
  });

  it("never ends inside an emoji sequence or a word, even in a long body", () => {
    const family = "👨‍👩‍👧‍👦";
    const body = `${"शब्द ".repeat(10)}${family}${family}${family} ${"दूसरा ".repeat(400)}`;
    for (const budget of [40, 49, 50, 51, 52, 53, 60, 120, 200]) {
      const cut = cutOnWords(body, budget);
      expect(xLen(cut)).toBeLessThanOrEqual(budget);
      expect(body.startsWith(cut)).toBe(true);
      // the next character is a boundary, never the middle of a word or a ZWJ sequence
      expect(/^(?:$|\s|👨)/u.test(body.slice(cut.length))).toBe(true);
      expect(cut.endsWith("‍")).toBe(false);
    }
  });
});

describe("firstIndiaText", () => {
  const tags = ["#RajasthanWithFirstIndia", "#RajasthanHighCourt"];

  it("builds the sample post: #District: headline, body cut with four dots, tag line", () => {
    const text = firstIndiaText({ district: "#Jaipur", headline: HC_HEADLINE, body: HC_BODY }, tags);
    const [line1, line2, ...rest] = text.split("\n\n");
    expect(rest).toEqual([]);
    expect(line1).toBe(`#Jaipur: ${HC_HEADLINE}`);
    expect(line2!.startsWith("50% आरक्षण सीमा के अनुसार")).toBe(true);
    expect(line2!.endsWith(BODY_CUT)).toBe(true);
    expect(line2!.endsWith(`.${BODY_CUT}`)).toBe(false);
    const post = assemblePostText(text, tags, []);
    expect(xLen(post)).toBeLessThanOrEqual(X_LIMIT);
    // As full as it can be: one more word would not fit
    const kept = line2!.slice(0, -BODY_CUT.length);
    const next = HC_BODY.slice(kept.length).replace(/^[\s,।]+/u, "").split(" ")[0]!;
    expect(xLen(post) + 1 + xLen(next)).toBeGreaterThan(X_LIMIT);
    expect(checkXPost(post).ok).toBe(true);
  });

  it("keeps a short body whole, with no dots", () => {
    expect(firstIndiaText({ district: "#Kota", headline: "कोटा में बारिश", body: "शहर में दो घंटे तेज बारिश हुई।" }, tags)).toBe(
      "#Kota: कोटा में बारिश\n\nशहर में दो घंटे तेज बारिश हुई।",
    );
  });

  it("has no district prefix when the story has no district", () => {
    expect(firstIndiaText({ district: "", headline: "खबर", body: "" }, [])).toBe("खबर");
  });

  it("drops the body when no word of it fits, and only then cuts the headline with …", () => {
    // 9 + 224 = 233 of the 280 - 46 = 234 left after the tag line: no room for the blank line and a body word
    const long = "राजस्थान ".repeat(25).trim();
    expect(firstIndiaText({ district: "#Jaipur", headline: long, body: "मुख्यमंत्री ने कहा" }, tags)).toBe(`#Jaipur: ${long}`);
    const huge = "राजस्थान ".repeat(40).trim();
    const cut = firstIndiaText({ district: "#Jaipur", headline: huge, body: "कुछ" }, tags);
    expect(cut.startsWith("#Jaipur: राजस्थान")).toBe(true);
    // Cut on a whole word, not mid-word
    expect(cut.endsWith(`राजस्थान${ELLIPSIS}`)).toBe(true);
    expect(cut).not.toContain("\n");
    expect(xLen(assemblePostText(cut, tags, []))).toBeLessThanOrEqual(X_LIMIT);
  });

  it("cuts one huge word on graphemes, never on a virama", () => {
    const word = "मुख्यमंत्री".repeat(40);
    const cut = firstIndiaText({ district: "", headline: word, body: "" }, tags);
    expect(cut.endsWith(ELLIPSIS)).toBe(true);
    expect(cut.slice(0, -1).endsWith("्")).toBe(false);
    expect(xLen(assemblePostText(cut, tags, []))).toBeLessThanOrEqual(X_LIMIT);
  });

  it("is empty when there is no headline, never a bare #District:", () => {
    expect(firstIndiaText({ district: "#Jaipur", headline: "  ", body: "" }, tags)).toBe("");
  });

  it("drops the #District prefix, then everything, when the tag line leaves no room", () => {
    // 280 - (266 + 2) = 12 left: "#SawaiMadhopur: " (16) cannot fit, "खबर आज की…" (11) can
    const long = [`#${"क".repeat(265)}`];
    const text = firstIndiaText({ district: "#SawaiMadhopur", headline: "खबर आज की बड़ी", body: "" }, long);
    expect(text).toBe(`खबर आज की${ELLIPSIS}`);
    expect(xLen(assemblePostText(text, long, []))).toBeLessThanOrEqual(X_LIMIT);
    // the tag line alone is over the limit: nothing fits
    expect(firstIndiaText({ district: "#Jaipur", headline: "खबर", body: "" }, [`#${"क".repeat(300)}`])).toBe("");
  });

  it("always fits, with long tags and handles reserved", () => {
    const many = [...tags, "#बहुतलंबाहैशटैगएक", "@CMOfficeRajasthan", "@BhajanlalBjp"];
    const text = firstIndiaText({ district: "#SawaiMadhopur", headline: HC_HEADLINE, body: HC_BODY.repeat(5) }, many);
    expect(xLen(`${text}\n\n${many.join(" ")}`)).toBeLessThanOrEqual(X_LIMIT);
  });
});

describe("RuleComposer", () => {
  const composer = new RuleComposer({
    version: "rules-1",
    hashtagConfig: { script: "latin", fixed: ["#RajasthanWithFirstIndia"], max: 4 },
    hashtags: gazetteer,
    handles: handleGazetteer([
      { id: "m1", entityName: "भजनलाल शर्मा", aliases: ["Bhajanlal Sharma", "मुख्यमंत्री भजनलाल"], handle: "BhajanlalBjp", priority: 10 },
    ]),
  });

  it("composes the First India post for a Samvadia story", async () => {
    const draft = await composer.compose({ headline: HC_HEADLINE, body: HC_BODY, place: "Jaipur" });
    expect(draft.hashtags).toEqual(["#RajasthanWithFirstIndia", "#RajasthanHighCourt"]);
    expect(draft.bodyText.split("\n\n")[0]).toBe(`#Jaipur: ${HC_HEADLINE}`);
    expect(draft.bodyText.endsWith(BODY_CUT)).toBe(true);
    expect(xLen(assemblePostText(draft.bodyText, draft.hashtags, []))).toBeLessThanOrEqual(X_LIMIT);
    expect(draft.composeMethod).toBe("rules");
    expect(draft.composeVersion).toBe(`${COMPOSE_FORMAT}.rules-1`);
  });

  it("leaves room for every mention suggestion", async () => {
    const draft = await composer.compose({ headline: "जयपुर में कैबिनेट बैठक", body: `मुख्यमंत्री भजनलाल शर्मा ने कहा ${"कि काम इसी साल शुरू होगा ".repeat(20)}`, place: "Jaipur" });
    expect(draft.mentionSuggestions).toEqual([{ handleId: "m1", entity: "भजनलाल शर्मा", handle: "@BhajanlalBjp", exact: true }]);
    expect(draft.hashtags).toEqual(["#RajasthanWithFirstIndia"]);
    expect(xLen(assemblePostText(draft.bodyText, draft.hashtags, ["@BhajanlalBjp"]))).toBeLessThanOrEqual(X_LIMIT);
  });

  it("does not repeat the district in the tag line, and builds an unknown district", async () => {
    const c = new RuleComposer({
      version: "v",
      hashtagConfig: { script: "latin", fixed: ["#Jaipur", "#RajasthanWithFirstIndia"], max: 4 },
      hashtags: gazetteer,
      handles: handleGazetteer([]),
    });
    expect((await c.compose({ headline: "जयपुर पुलिस की कार्रवाई", body: "", place: "Jaipur" })).hashtags).toEqual(["#RajasthanWithFirstIndia", "#RajasthanPolice"]);
    expect((await c.compose({ headline: "खबर", body: "", place: "Sri Ganganagar" })).bodyText).toBe("#SriGanganagar: खबर");
  });

  it("uses the body as line 1 when there is no headline", async () => {
    const draft = await composer.compose({ headline: "", body: "स्कूल की छत का प्लास्टर गिरा", place: "Kota" });
    expect(draft.bodyText).toBe("#Kota: स्कूल की छत का प्लास्टर गिरा");
  });

  it("gives empty text (refused at approve) when the story has neither headline nor body", async () => {
    const draft = await composer.compose({ headline: "", body: "", place: "Jaipur" });
    expect(draft.bodyText).toBe("");
    expect(checkXPost(assemblePostText(draft.bodyText, draft.hashtags, [])).ok).toBe(false);
  });

  it("has no #District: without a place", async () => {
    expect((await composer.compose({ headline: "खबर", body: "पूरी खबर" })).bodyText).toBe("खबर\n\nपूरी खबर");
  });
});
