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

  it("looks at the points too: an unqualified mention there FOLLOWS an earlier qualified one (S3); another state's there does not add it", () => {
    // Was: kept the tag. User decision (13 Nov, S3): a later unqualified mention is the earlier qualified court
    expect(tags("इलाहाबाद हाईकोर्ट ने दी जमानत", ["उधर हाईकोर्ट में राज्य सरकार ने जवाब पेश किया"])).not.toContain(HC);
    expect(tags("जमानत पर फैसला", ["इलाहाबाद हाईकोर्ट ने सुनाया"])).not.toContain(HC);
  });

  it("S3: a later unqualified mention follows the earlier qualified one's state", () => {
    for (const [h, pts] of [
      ["दिल्ली हाईकोर्ट का बड़ा फैसला", ["हाईकोर्ट ने कहा कि याचिका सुनवाई योग्य नहीं"]],
      ["Delhi High Court का फैसला", ["High Court ने केंद्र से जवाब मांगा"]],
      ["हाईकोर्ट की लखनऊ बेंच का आदेश", ["हाई कोर्ट ने सरकार को फटकार लगाई"]],
    ] as const) {
      expect(tags(h, [...pts]), h).not.toContain(HC);
      expect(namesOnlyOtherHighCourts([h, ...pts].join("\n")), h).toBe(true);
    }
  });

  it("S3: an unqualified mention BEFORE the qualified one, a fully unqualified story, or a Rajasthan mention later keeps the tag", () => {
    expect(tags("हाईकोर्ट का बड़ा फैसला", ["दिल्ली हाईकोर्ट ने याचिका खारिज की"])).toContain(HC);
    expect(tags("हाईकोर्ट का बड़ा फैसला", ["हाईकोर्ट ने कहा कि याचिका सुनवाई योग्य नहीं"])).toContain(HC);
    expect(tags("इलाहाबाद हाईकोर्ट के फैसले का हवाला", ["राजस्थान हाईकोर्ट ने दी जमानत"])).toContain(HC);
    expect(tags("दिल्ली हाईकोर्ट का फैसला", ["उधर जोधपुर हाईकोर्ट ने भी सुनवाई की", "हाईकोर्ट ने कहा"])).toContain(HC);
    expect(tags("HIGH COURT OF RAJASTHAN grants bail")).toContain(HC);
  });

  it("S3: 'HIGH COURT OF DELHI' and other cases of the English name", () => {
    for (const h of ["HIGH COURT OF DELHI dismisses plea", "high court of delhi dismisses plea", "DELHI HIGH COURT refuses stay", "High court at Bombay"]) {
      expect(namesOnlyOtherHighCourts(h), h).toBe(true);
      expect(tags(h), h).not.toContain(HC);
    }
    // The short codes stay capitals: "up" is not Uttar Pradesh
    expect(namesOnlyOtherHighCourts("matter taken up High Court")).toBe(false);
  });

  it("whole words only: UP inside UPSC, MP inside MPs is not a state, so the tag stays", () => {
    expect(namesOnlyOtherHighCourts("UPSC High Court case")).toBe(false);
    expect(tags("UPSC High Court case")).toContain(HC);
    expect(namesOnlyOtherHighCourts("MPs High Court petition")).toBe(false);
    expect(tags("MPs High Court petition")).toContain(HC);
    // ...while the bare codes are states
    expect(namesOnlyOtherHighCourts("MP High Court petition")).toBe(true);
  });

  it("national stories still never get it, and other topic tags are untouched", () => {
    expect(tags("राजस्थान हाईकोर्ट ने दी जमानत", [], false)).not.toContain(HC);
    expect(tags("इलाहाबाद हाईकोर्ट ने हत्या के आरोपी को दी जमानत")).toEqual(["#RajasthanPolice"]);
  });
});
