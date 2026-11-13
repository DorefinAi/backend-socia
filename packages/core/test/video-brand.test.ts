// A video post's channel label ("| Madhya Pradesh News") decides the fallback brand (13 Nov 2026).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_NATIONAL, BRAND_RAJASTHAN, PlaceBook, bookPlaceKind, composeBreaking, composePostTags, parseBreaking, parseDistricts,
  parseHandleRules, parsePlacesData, resolveBrand, slotFromTags, videoLabelBrand,
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

// ─── V1 / R1: one implementation, on the live path ───────────────────────────

const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
/** A breaking file as the desk saves it, through the live path: parseBreaking → composeBreaking */
const fileFor = (code = "") => `BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_NARESH${code ? `_${code}` : ""}_BIG.txt`;
function live(lines: string[], name = fileFor()) {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book);
}
const replayCtx = { places };
const replayBrand = (text: string) => composePostTags(text, replayCtx).trail.filter((t) => t === BRAND_RAJASTHAN || t === BRAND_NATIONAL);

describe("R1: the live composer takes a video post's brand from its channel label", () => {
  it("'| Madhya Pradesh News', '| India News', '| Delhi News' (and the danda form) → #FirstIndiaNews", () => {
    for (const h of [
      "उज्जैन में नई योजना का शुभारंभ | Madhya Pradesh News", "उज्जैन में नई योजना का शुभारंभ। Madhya Pradesh News",
      "संसद का शीतकालीन सत्र | India News", "संसद का शीतकालीन सत्र। India News", "प्रदूषण पर सख्ती | Delhi News", "प्रदूषण पर सख्ती। Delhi News",
    ]) {
      expect(live([h, "मुख्यमंत्री ने किया लोकार्पण"]).hashtags, h).toEqual([`#${BRAND_NATIONAL}`]);
    }
  });

  it("'| Rajasthan News' and '| <Rajasthan district> News' → #RajasthanWithFirstIndia, NWS desk file included", () => {
    for (const h of ["गोवर्धन पूजा की धूम | Rajasthan News", "गोवर्धन पूजा की धूम। Rajasthan News", "जेडीए की कार्रवाई | Jaipur News", "पर्यटन सीजन शुरू | Sawai Madhopur News"]) {
      expect(live([h, "लोगों ने भाग लिया"]).hashtags, h).toEqual([`#${BRAND_RAJASTHAN}`]);
      const nws = composeBreaking({ headline: h, points: ["लोगों ने भाग लिया"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book);
      expect(nws.hashtags, h).toEqual([`#${BRAND_RAJASTHAN}`]);
    }
  });

  it("a place or district TAG still decides first", () => {
    expect(live(["उज्जैन में नई योजना | Madhya Pradesh News", "मुख्यमंत्री ने किया लोकार्पण #Kota"]).hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    expect(live(["राज्य स्तरीय समारोह | Rajasthan News", "नेताओं ने भाग लिया #Bihar"]).hashtags).toEqual([`#${BRAND_NATIONAL}`]);
    // A stated district (here a place before the colon) decides over the label too
    expect(live(["#किशनगढ़: मेले की धूम | India News", "लोगों ने भाग लिया"]).hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
  });

  it("a non-channel ending keeps the existing default", () => {
    expect(live(["पदयात्रा | PM Kisan Yojana", "किसानों को किस्त"]).hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
    const nws = composeBreaking({ headline: "पदयात्रा | PM Kisan Yojana", points: ["किसानों को किस्त"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book);
    expect(nws.hashtags).toEqual([`#${BRAND_NATIONAL}`]);
    // Not a video headline: the label is not read at all
    expect(live(["Breaking News: चमोली में भूस्खलन", "राहत कार्य जारी"]).hashtags).toEqual([`#${BRAND_RAJASTHAN}`]);
  });

  it("live and replay agree on the label brand: both call videoLabelBrand", () => {
    for (const h of [
      "उज्जैन में नई योजना का शुभारंभ | Madhya Pradesh News", "संसद सत्र। India News", "प्रदूषण पर सख्ती | Delhi News", "मेले की धूम | Rajasthan News",
      "जेडीए की कार्रवाई | Jaipur News", "चोरी का खुलासा | Sikar Crime News", "पर्यटन | Sawai Madhopur", "किसानों को किस्त | Hindi News",
    ]) {
      expect(live([h, "विवरण"]).hashtags.map((t) => t.slice(1)), h).toEqual(replayBrand(h));
      expect(videoLabelBrand(h, bookPlaceKind(book)), h).toBe(videoLabelBrand(h, places));
    }
  });
});
