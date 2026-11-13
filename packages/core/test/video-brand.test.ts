// A video post's channel label ("| Madhya Pradesh News") decides the fallback brand (13 Nov 2026).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_NATIONAL, BRAND_RAJASTHAN, composePostTags, parseDistricts, resolveBrand, videoLabelBrand,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const places = parseDistricts(cfg("districts.json"));

// ─── 2. video brand from the channel label ───────────────────────────────────

describe("2. a video post's channel label decides the fallback brand", () => {
  const brandOf = (text: string) => composePostTags(text, { places }).trail.filter((t) => t === BRAND_RAJASTHAN || t === BRAND_NATIONAL);

  it("reads the label after the last | or ।", () => {
    expect(videoLabelBrand("दिवाली मेले की धूम | Rajasthan News", places)).toBe(BRAND_RAJASTHAN);
    expect(videoLabelBrand("दिवाली मेले की धूम। Rajasthan News", places)).toBe(BRAND_RAJASTHAN);
    expect(videoLabelBrand("मतदान जारी | Rajasthan news", places)).toBe(BRAND_RAJASTHAN);
    expect(videoLabelBrand("जेडीए की कार्रवाई | Jaipur News", places)).toBe(BRAND_RAJASTHAN);
    expect(videoLabelBrand("चोरी का खुलासा | Sikar Crime News", places)).toBe(BRAND_RAJASTHAN);
    expect(videoLabelBrand("पर्यटन | Sawai Madhopur", places)).toBe(BRAND_RAJASTHAN);
    expect(videoLabelBrand("उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News", places)).toBe(BRAND_NATIONAL);
    expect(videoLabelBrand("संसद सत्र | India News", places)).toBe(BRAND_NATIONAL);
    expect(videoLabelBrand("प्रदूषण पर सख्ती | Delhi News", places)).toBe(BRAND_NATIONAL);
    expect(videoLabelBrand("किसानों को किस्त | Hindi News", places)).toBe(BRAND_NATIONAL);
    expect(videoLabelBrand("सियासी हलचल | BJP News https://t.co/x #FINVideo", places)).toBe(BRAND_NATIONAL);
  });

  it("no channel label: null, the caller's default stands", () => {
    expect(videoLabelBrand("पदयात्रा | BJP Padyatra", places)).toBeNull();
    expect(videoLabelBrand("बैठक हुई। अब आगे की तैयारी", places)).toBeNull();
    expect(videoLabelBrand("Jaipur Diwali Fair: मेले की धूम", places)).toBeNull();
  });

  it("the post: Rajasthan label → #RajasthanWithFirstIndia, any other → #FirstIndiaNews", () => {
    expect(brandOf("Govardhan Puja 2026 | Rajasthan News")).toEqual([BRAND_RAJASTHAN]);
    expect(brandOf("गोवर्धन पूजा की धूम। Rajasthan News")).toEqual([BRAND_RAJASTHAN]);
    expect(brandOf("उज्जैन में नई योजना का शुभारंभ | Madhya Pradesh News")).toEqual([BRAND_NATIONAL]);
    expect(brandOf("उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News")).toEqual([BRAND_NATIONAL]);
    expect(brandOf("संसद का शीतकालीन सत्र | India News")).toEqual([BRAND_NATIONAL]);
    expect(brandOf("प्रदूषण पर सख्ती | Delhi News")).toEqual([BRAND_NATIONAL]);
    // no label: the video default as before
    expect(brandOf("Jaipur Diwali Fair: मेले की धूम")).toEqual([BRAND_RAJASTHAN]);
    expect(brandOf("पदयात्रा | BJP Padyatra")).toEqual([BRAND_RAJASTHAN]);
  });

  it("a district tag in the post still decides first", () => {
    expect(brandOf("उज्जैन में नई योजना | Madhya Pradesh News\n\n#Kota")).toEqual([BRAND_RAJASTHAN]);
    expect(brandOf("राज्य स्तरीय समारोह | Rajasthan News\n\n#Bihar")).toEqual([BRAND_NATIONAL]);
    expect(resolveBrand({ trail: ["BarmerNews"], video: true, headline: "x | India News" }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 3 });
  });

  it("only the video default moves: a text post and an explicit fallback are as before", () => {
    expect(resolveBrand({ video: false, headline: "x | Rajasthan News" }, places)).toMatchObject({ brand: BRAND_NATIONAL, step: 6 });
    expect(resolveBrand({ video: true, headline: "x | India News", fallback: BRAND_RAJASTHAN }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 6 });
    expect(resolveBrand({ video: true }, places)).toMatchObject({ brand: BRAND_RAJASTHAN, step: 6 });
  });
});
