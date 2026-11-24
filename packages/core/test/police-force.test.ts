// P4 (owner, 25 Nov 2026): the police force of a district with two. On 23-24 Nov the desk removed @jaipur_police 12
// times, 8 of them on Jaipur-rural towns (चौमूं, कालाडेरा, जोबनेर, जमवारामगढ़…) where it added @JprRuralPolice, and a
// "कोटा ग्रामीण" story went out with @KotaPolice (city). A story about the force itself tags it whatever the class.
// Fixtures: the desk's breaking files of 22-24 Nov (first lines only).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, choosePoliceForce, composeBreaking, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles,
  parseSubjectHandles, parseSuggestRules, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));
const suggestRules = parseSuggestRules(cfg("campaigns.json"));

function draft(name: string, lines: string[], at: string): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties, suggestRules, at: new Date(at) },
  );
}
const tagged = (d: BreakingDraft) => d.handles.map((h) => h.handle.toLowerCase());
const offered = (d: BreakingDraft) => d.handleSuggestions.map((h) => h.handle.toLowerCase());

describe("P4: the police force of a district with two", () => {
  it("Jamwaramgarh (JPR9, 24 Nov): a Jaipur-rural town tags @JprRuralPolice, not @jaipur_police", () => {
    const d = draft("BTN_RJ_BREAKING_24NOV_2799_AM_CONTROL_JPR9_BIG_.txt", [
      "जमवारामगढ़ से खबर", "जयपुर-जमवारामगढ़ स्टेट हाईवे पर भीषण सड़क हादसा", "तेज रफ्तार डंपर ने मारी बाइक को टक्कर", "हादसे में दो लोग हुए गंभीर घायल",
    ], "2026-11-24T12:43:47Z");
    expect(d.cls).toBe("incident");
    expect(tagged(d)).toContain("jprruralpolice");
    expect(tagged(d)).not.toContain("jaipur_police");
  });

  it("'कोटा ग्रामीण की मंडाना थाना पुलिस' (24 Nov) tags @spkotarural, not @KotaPolice", () => {
    const d = draft("BTN_RJ_BREAKING_1029_24NOV_MS_CONTROL_Gul_big_FULL.txt", [
      "कोटा से खबर", "कोटा ग्रामीण की मंडाना थाना पुलिस ने दिल्ली-मुंबई एक्सप्रेसवे पर नाकाबंदी की", "नारकोटिक्स कंट्रोल ब्यूरो चंडीगढ़ के तीन वांछित इनामी आरोपियों को दबोचा",
    ], "2026-11-24T12:06:14Z");
    expect(tagged(d)).toContain("spkotarural");
    expect(tagged(d)).not.toContain("kotapolice");
  });

  it("Kalwar (24 Nov): a town the data does not place offers both forces and tags neither", () => {
    const d = draft("BTN_RJ_BREAKING_2076_24NOV_mh_CONTROL_JPR13_big.txt", [
      "कालवाड़ से खबर", "कालवाड़ में किराना दुकान का शटर काटकर लाखों का सामान चोरी", "मेगा मेट्रो स्टोर को देर रात चोरों ने बनाया निशाना",
    ], "2026-11-24T04:40:17Z");
    expect(tagged(d)).not.toContain("jaipur_police");
    expect(tagged(d)).not.toContain("jprruralpolice");
    expect(offered(d)).toEqual(expect.arrayContaining(["jaipur_police", "jprruralpolice"]));
    expect(d.warnings.join(" ")).toMatch(/two police forces/);
  });

  it("an offered force still holds the police slot: no body subject takes it (Harmara underpass, 19 Nov)", () => {
    const d = draft("BTN_RJ_BREAKING_19NOV_2740_AM_CONTROL_JPR9_BIG_.txt", [
      "हरमाड़ा से खबर", "बैनाड़ रोड सितावाली फाटक (RUB) अंडरपास का लोकार्पण आज", "डिप्टी CM  दीया कुमारी करेंगी अंडरपास का लोकार्पण",
      "डिप्टी CM अपने निर्वाचन क्षेत्र विद्याधर नगर में बैनाड़ रोड पहुंचेंगी शाम 4 बजे", "दीया कुमारी जनता को समर्पित करेंगी अंडरपास",
      "लोगों को ट्रैफिक जाम से मिलेगी राहत", "सीतावली फाटक व नाड़ी के फाटक के कारण लगने वाले ट्रैफिक जाम से राहत",
    ], "2026-11-19T08:22:02Z");
    expect(d.cls).toBe("incident");
    expect(offered(d)).toEqual(expect.arrayContaining(["jaipur_police", "jprruralpolice"]));
    expect(tagged(d)).not.toContain("kumaridiya");
  });

  it("a Jaipur city story with no town keeps @jaipur_police (MI Road, 23 Nov)", () => {
    const d = draft("BTN_RJ_BREAKING_2129_23NOV_mh_CONTROL_satya_big.txt", [
      "जयपुर: अनियंत्रित कार जा घुसी दुकान के शटर में", "एमआई रोड पर आज सुबह हुआ हादसा", "घटना में कार चालक को आई चोट",
    ], "2026-11-23T06:53:47Z");
    expect(tagged(d)).toContain("jaipur_police");
    expect(tagged(d)).not.toContain("jprruralpolice");
  });

  it("choosePoliceForce: words beat towns, two forces' words are unclear, no town is the HQ force", () => {
    const forces = rules.districts.jaipur!.forces!;
    expect(forces.map((f) => f.handle)).toEqual(["jaipur_police", "JprRuralPolice"]);
    expect(choosePoliceForce(forces, { headline: "जयपुर ग्रामीण पुलिस की कार्रवाई", points: [] }).handle).toBe("JprRuralPolice");
    expect(choosePoliceForce(forces, { headline: "चौमूं में चोरी", points: [], town: null }).handle).toBe("JprRuralPolice");
    expect(choosePoliceForce(forces, { headline: "हादसा", points: [], town: "चौमू" }).handle).toBe("JprRuralPolice");
    const both = choosePoliceForce(forces, { headline: "पुलिस कमिश्नरेट और जयपुर ग्रामीण पुलिस की संयुक्त कार्रवाई", points: [] });
    expect(both).toMatchObject({ handle: null, offer: ["jaipur_police", "JprRuralPolice"] });
    expect(choosePoliceForce(forces, { headline: "चोरी की वारदात", points: [] }).handle).toBe("jaipur_police");
  });
});

describe("P4: a story about the force itself tags it whatever the class", () => {
  it("'जोधपुर पुलिस कमिश्नरेट में कांस्टेबल प्रमोशन…' (24 Nov) tags @CP_Jodhpur (the desk added it on X; Socia only offered it)", () => {
    const d = draft("BTN_RJ_BREAKING_24NOV_2792_AM_CONTROL_RAJEEV_JDR_BIG_.txt", [
      "जोधपुर पुलिस कमिश्नरेट में कांस्टेबल प्रमोशन के लिए हुए साक्षात्कार", "पुलिस कमिश्नर अंशुमन भोमिया ने खुद लिए सभी अभ्यर्थियों के इंटरव्यू",
      "साक्षात्कार प्रक्रिया पूरी होने के बाद परीक्षार्थियों से की मुलाकात",
    ], "2026-11-24T12:17:21Z");
    expect(d.cls).not.toBe("incident");
    expect(tagged(d)).toContain("cp_jodhpur");
  });

  it("another force or another district's SP in the headline does not tag ours", () => {
    const acb = draft("BTN_RJ_BREAKING_2129_23NOV_mh_CONTROL_satya_big.txt", ["जयपुर: ACB एसपी ने ली बैठक", "भ्रष्टाचार के मामलों की समीक्षा"], "2026-11-23T06:53:47Z");
    expect(tagged(acb)).not.toContain("jaipur_police");
    const bundi = draft("BTN_RJ_BREAKING_2129_23NOV_mh_CONTROL_satya_big.txt", ["जयपुर: बूंदी SP का तबादला", "आदेश जारी"], "2026-11-23T06:53:47Z");
    expect(tagged(bundi)).not.toContain("jaipur_police");
  });
});

describe("P4: district-handles.json towns and words", () => {
  it("only a police entry may carry towns or words, and they must be names", () => {
    const base = { version: 2, state: [], districts: { Kota: [{ handle: "@KotaPolice", handle_type: "district", role: "collector", verified: true, towns: ["कोटा"] }] } };
    expect(() => parseHandleRules(base)).toThrow(/only a police entry/);
    const bad = { version: 2, state: [], districts: { Kota: [{ handle: "@KotaPolice", handle_type: "district", role: "police", verified: true, words: [7] }] } };
    expect(() => parseHandleRules(bad)).toThrow(/list of names/);
  });
  it("Jaipur, Jodhpur, Kota and Khairthal-Tijara each have both forces' lists; one-force districts have none", () => {
    for (const k of ["jaipur", "jodhpur", "kota", "khairthaltijara"]) expect(rules.districts[k]!.forces, k).toHaveLength(2);
    expect(rules.districts.ajmer!.forces).toBeUndefined();
    // Harmara and Kalwar sit inside the commissionerate's map but the desk splits on them: neither list names them
    for (const town of ["हरमाड़ा", "कालवाड़", "बगरू", "बस्सी"]) {
      expect(choosePoliceForce(rules.districts.jaipur!.forces!, { headline: "चोरी की वारदात", points: [], town }), town).toMatchObject({ handle: null });
    }
  });
  it("two spellings of one district merge their forces before the list is judged", () => {
    const r = parseHandleRules({ version: 2, state: [], districts: {
      "Sawai Madhopur": [{ handle: "@SPsawaimadhopur", handle_type: "district", role: "police", verified: true, towns: ["गंगापुर"] }],
      SawaiMadhopur: [{ handle: "@GangapurPolice", handle_type: "district", role: "police", verified: true, words: ["गंगापुर सिटी पुलिस"] }],
    } });
    expect(r.districts.sawaimadhopur!.forces?.map((f) => f.handle)).toEqual(["SPsawaimadhopur", "GangapurPolice"]);
  });
  it("choosePoliceForce with no forces tags and offers nothing", () => {
    expect(choosePoliceForce([], { headline: "चोरी", points: [] })).toMatchObject({ handle: null, offer: [] });
  });
});
