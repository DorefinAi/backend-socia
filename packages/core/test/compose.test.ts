import { describe, expect, it } from "vitest";
import {
  ELLIPSIS, RuleComposer, X_LIMIT, assemblePostText, bodyBudget, checkXPost, composeXText,
  handleGazetteer, hashtagGazetteer, truncateHeadline, xLen,
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
});

describe("RuleComposer", () => {
  const composer = new RuleComposer({
    version: "rules-1",
    hashtagConfig: { script: "latin", fixed: ["#1stIndiaNews", "#Rajasthan"], max: 4 },
    hashtags: hashtagGazetteer([
      { id: "h1", matchType: "city", name: "जयपुर", aliases: ["Jaipur", "जयपुर शहर"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 10 },
      { id: "h2", matchType: "city", name: "कोटा", aliases: ["Kota"], hashtagLatin: "Kota", hashtagDevanagari: "कोटा", priority: 5 },
    ]),
    handles: handleGazetteer([
      { id: "m1", entityName: "भजनलाल शर्मा", aliases: ["Bhajanlal Sharma", "मुख्यमंत्री भजनलाल"], handle: "BhajanlalBjp", priority: 10 },
    ]),
  });

  it("builds the draft from rules only", async () => {
    const draft = await composer.compose({
      headline: "जयपुर मेट्रो फेज-2 को कैबिनेट की मंजूरी",
      body: "मुख्यमंत्री भजनलाल शर्मा ने कहा कि काम इसी साल शुरू होगा।",
    });
    expect(draft.hashtags).toEqual(["#Jaipur", "#1stIndiaNews", "#Rajasthan"]);
    expect(draft.mentionSuggestions).toEqual([{ handleId: "m1", entity: "भजनलाल शर्मा", handle: "@BhajanlalBjp", exact: true }]);
    expect(draft.bodyText).toBe("जयपुर मेट्रो फेज-2 को कैबिनेट की मंजूरी");
    expect(draft.composeMethod).toBe("rules");
    expect(draft.composeVersion).toBe("rules-1");
  });

  it("does not repeat a fixed tag that a city rule already gave", async () => {
    const c = new RuleComposer({
      version: "v",
      hashtagConfig: { script: "latin", fixed: ["#jaipur"], max: 4 },
      hashtags: hashtagGazetteer([{ id: "h", matchType: "city", name: "Jaipur", aliases: [], hashtagLatin: "Jaipur", hashtagDevanagari: null, priority: 1 }]),
      handles: handleGazetteer([]),
    });
    expect((await c.compose({ headline: "Jaipur news", body: "" })).hashtags).toEqual(["#Jaipur"]);
  });
});
