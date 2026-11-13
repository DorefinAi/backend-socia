// Another state's High Court never gets #RajasthanHighCourt (13 Nov 2026).

import { describe, expect, it } from "vitest";
import { CATEGORY_SEED_RULES, hashtagGazetteer, namesOnlyOtherHighCourts, pickCategoryTags } from "../src";

// ─── 1. High Court ────────────────────────────────────────────────────────────

describe("1. #RajasthanHighCourt is Rajasthan's High Court only", () => {
  const topics = hashtagGazetteer(
    CATEGORY_SEED_RULES.map((r, i) => ({
      id: `seed${i}`, matchType: "entity" as const, name: r.name, aliases: [...r.aliases], hashtagLatin: r.tag, hashtagDevanagari: null,
      priority: r.priority, negativePhrases: [...(r.negativePhrases ?? [])],
    })),
  );
  const tags = (headline: string, points: string[] = [], rajasthan = true) => pickCategoryTags({ headline, points, rajasthan }, topics, ["#RajasthanWithFirstIndia"]);
  const HC = "#RajasthanHighCourt";

  it("another state's High Court: no tag", () => {
    for (const h of [
      "इलाहाबाद हाईकोर्ट ने दी जमानत",
      "Allahabad High Court का बड़ा फैसला",
      "दिल्ली हाई कोर्ट ने याचिका खारिज की",
      "बॉम्बे हाईकोर्ट से अभिनेता को राहत",
      "मुंबई उच्च न्यायालय में सुनवाई टली",
      "Bombay High Court grants bail",
      "MP हाईकोर्ट का आदेश",
      "मध्य प्रदेश हाईकोर्ट ने सरकार से जवाब मांगा",
      "मध्यप्रदेश के हाईकोर्ट में याचिका",
      "पंजाब-हरियाणा हाईकोर्ट ने लगाई फटकार",
      "पंजाब एवं हरियाणा हाईकोर्ट का निर्देश",
      "गुजरात हाईकोर्ट ने खारिज की अर्जी",
      "पटना हाईकोर्ट में सुनवाई",
      "कलकत्ता हाईकोर्ट का फैसला",
      "मद्रास हाईकोर्ट ने कहा",
      "कर्नाटक हाईकोर्ट से झटका",
      "केरल हाईकोर्ट की टिप्पणी",
      "हाईकोर्ट की लखनऊ बेंच ने दिया आदेश",
      "हाई कोर्ट की इंदौर खंडपीठ में सुनवाई",
      "High Court of Delhi dismisses plea",
      "Delhi's High Court refuses stay",
    ]) {
      expect(tags(h), h).not.toContain(HC);
      expect(namesOnlyOtherHighCourts(h), h).toBe(true);
    }
  });

  it("the Supreme Court alone: no tag", () => {
    expect(tags("सुप्रीम कोर्ट ने दी जमानत")).not.toContain(HC);
    expect(tags("Supreme Court का फैसला")).not.toContain(HC);
  });

  it("Rajasthan's High Court, its benches, or an unqualified one on a Rajasthan story: the tag", () => {
    for (const h of [
      "राजस्थान हाईकोर्ट ने दी जमानत",
      "Rajasthan High Court का फैसला",
      "हाईकोर्ट की जयपुर बेंच ने दिया आदेश",
      "जोधपुर हाईकोर्ट में सुनवाई",
      "हाईकोर्ट से मुकेश गहलोत को राहत",
      "उच्च न्यायालय ने मांगा जवाब",
      // a place in the sentence that does not qualify the court
      "हाईकोर्ट ने दिल्ली पुलिस से मांगा जवाब",
      "हाईकोर्ट ने MP के युवक को दी जमानत",
      // one Rajasthan mention is enough
      "राजस्थान हाईकोर्ट ने इलाहाबाद हाईकोर्ट के फैसले का हवाला दिया",
    ]) {
      expect(tags(h), h).toContain(HC);
      expect(namesOnlyOtherHighCourts(h), h).toBe(false);
    }
  });

  it("looks at the points too: an unqualified mention there keeps the tag, another state's there does not add it", () => {
    expect(tags("इलाहाबाद हाईकोर्ट ने दी जमानत", ["उधर हाईकोर्ट में राज्य सरकार ने जवाब पेश किया"])).toContain(HC);
    expect(tags("जमानत पर फैसला", ["इलाहाबाद हाईकोर्ट ने सुनाया"])).not.toContain(HC);
  });

  it("whole words only: UP inside UPSC, MP inside MPs is not a state", () => {
    expect(namesOnlyOtherHighCourts("UPSC High Court case")).toBe(false);
  });

  it("national stories still never get it, and other topic tags are untouched", () => {
    expect(tags("राजस्थान हाईकोर्ट ने दी जमानत", [], false)).not.toContain(HC);
    expect(tags("इलाहाबाद हाईकोर्ट ने हत्या के आरोपी को दी जमानत")).toEqual(["#RajasthanPolice"]);
  });
});
