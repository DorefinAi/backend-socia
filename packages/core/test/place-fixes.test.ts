// Place, heading and card fixes of 25 Nov 2026 (owner-approved): national detection (P3), merged districts' desk tags
// (P5), one place rule for the caption and the card (P6/P10), two-line files and desk instructions (P8), file codes (P9)
// and statewide list stories (P11). Cases from the desk's posts of 15–24 Nov (minimal snippets, no full files).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRAND_RAJASTHAN, PlaceBook, composeBreaking, parseBreaking, parseHandleRules, parseHashtagNormalise, parsePartyHandles, parsePlacesData,
  parseReporterHandles, parseSubjectHandles, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const opts = {
  subjects: parseSubjectHandles(cfg("subject-handles.json")), reporters, parties: parsePartyHandles(cfg("party-handles.json")),
  normaliser: parseHashtagNormalise(cfg("hashtag-normalise.json"), undefined, book.districts.map((d) => d.tag)),
};
const fileFor = (token: string | null, code = "") => `BTN_RJ_BREAKING_6001_24NOV_US_CONTROL_${[token, code].filter(Boolean).join("_")}_BIG.txt`;
function draft(name: string, lines: string[]): BreakingDraft {
  const p = parseBreaking(`${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`, name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking({ ...p, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode }, rules, book, opts);
}
const line1 = (d: BreakingDraft) => d.bodyText.split("\n")[0]!;
const police = (d: BreakingDraft) => d.handles.filter((h) => h.reason === "police");
const POINTS = ["पुलिस मौके पर पहुंची", "मामले की जांच शुरू"];

describe("P5: a merged district's desk tag", () => {
  it("Khairthal-Tijara: '#Khairthal: …', never '#KhairthalTijara #खैरथल:' (the desk's own line 1)", () => {
    const d = draft(fileFor(null, "ALW15"), ["खैरथल से खबर", "कोटकासिम में पंचायत समिति सदस्य के अपहरण का मामला गर्माया", ...POINTS]);
    expect(line1(d)).toBe("#Khairthal: कोटकासिम में पंचायत समिति सदस्य के अपहरण का मामला गर्माया");
    expect(d.headingPlace).toMatchObject({ tags: ["#Khairthal"], district: "Khairthal-Tijara", town: null, placement: "lead" });
    // The handle lookup still keys on the district's own tag: its police are picked as before
    expect(police(d).length).toBeGreaterThan(0);
    expect(d.proposals.find((p) => p.item === "#Khairthal")).toMatchObject({ layer: "emit", source: "district.place_line" });
    expect(d.proposals.some((p) => p.item === "#खैरथल" || p.item === "#KhairthalTijara")).toBe(false);
  });

  it("Didwana-Kuchaman: '#Didwana: मकराना शहर के…' (desk)", () => {
    const d = draft(fileFor(null, "NGR11"), ["डीडवाना से खबर", "मकराना शहर के बाइपास आरओबी पर बाइक-बस की आमने-सामने हुई भिड़ंत", ...POINTS]);
    expect(line1(d)).toBe("#Didwana: मकराना शहर के बाइपास आरओबी पर बाइक-बस की आमने-सामने हुई भिड़ंत");
  });

  it("Kotputli-Behror: the owner's '#Kotputli-Behror', and either town it names takes no tag of its own", () => {
    for (const town of ["कोटपूतली", "बहरोड़"]) {
      const d = draft(fileFor(null), [`${town} से खबर`, "नीमराना में फैक्ट्री में लगी आग", ...POINTS]);
      expect(line1(d)).toBe("#Kotputli-Behror: नीमराना में फैक्ट्री में लगी आग");
      expect(d.headingPlace.tags).toEqual(["#Kotputli-Behror"]);
    }
  });

  it("any other town of the district keeps its own tag ('#Khairthal #तिजारा:')", () => {
    const d = draft(fileFor(null), ["तिजारा से खबर", "पंचायत समिति की बैठक में हंगामा", ...POINTS]);
    expect(line1(d)).toBe("#Khairthal #तिजारा: पंचायत समिति की बैठक में हंगामा");
  });

  it("a district's own tag elsewhere is unchanged ('#Jodhpur')", () => {
    const d = draft(fileFor(null), ["जोधपुर से खबर", "बासनी में फर्जी कॉल सेंटर पकड़ा", ...POINTS]);
    expect(line1(d)).toBe("#Jodhpur: बासनी में फर्जी कॉल सेंटर पकड़ा");
  });

  it("the desk tag reads back as its district ('#Khairthal', '#Kotputli-Behror')", () => {
    expect(book.hashtag("Khairthal")?.districts[0]?.name).toBe("Khairthal-Tijara");
    expect(book.hashtag("#Kotputli-Behror")?.districts[0]?.name).toBe("Kotputli-Behror");
    expect(book.hashtag("KhairthalTijara")?.districts[0]?.name).toBe("Khairthal-Tijara");
    expect(book.district("Khairthal-Tijara")).toMatchObject({ tag: "KhairthalTijara", deskTag: "Khairthal" });
  });

  it("a malformed desk tag is reported and ignored; the district stays", () => {
    const problems: string[] = [];
    const data = parsePlacesData({ version: 1, districts: [{ tag: "KhairthalTijara", desk_tag: "खैरथल", hi: ["खैरथल-तिजारा"], codes: [], towns: [] }] }, (m) => problems.push(m));
    expect(data.districts[0]).toMatchObject({ tag: "KhairthalTijara" });
    expect(data.districts[0]!.desk_tag).toBeUndefined();
    expect(problems.join(" ")).toMatch(/desk_tag/);
  });

  it(`still a Rajasthan story (${BRAND_RAJASTHAN})`, () => {
    const d = draft(fileFor(null), ["खैरथल से खबर", "कोटकासिम में बैठक", ...POINTS]);
    expect(d.hashtags[0]).toBe(`#${BRAND_RAJASTHAN}`);
  });
});
