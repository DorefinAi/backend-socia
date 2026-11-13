// The Chief Secretary named without a name: offered, never tagged (13 Nov 2026).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PlaceBook, composeBreaking, namesOffice, parseBreaking, parseHandleRules, parsePartyHandles, parsePlacesData, parseReporterHandles, parseSubjectHandles, slotFromTags, type BreakingDraft,
} from "../src";

const cfg = (f: string) => JSON.parse(readFileSync(new URL(`../../../apps/worker/config/${f}`, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(cfg("rajasthan-places.json")));
const rules = parseHandleRules(cfg("district-handles.json"));
const subjects = parseSubjectHandles(cfg("subject-handles.json"));
const reporters = parseReporterHandles(cfg("reporter-handles.json"));
const parties = parsePartyHandles(cfg("party-handles.json"));

// ─── 3. the Chief Secretary ───────────────────────────────────────────────────

/** A breaking file as the desk saves it: the name on line 1, then the headline and the points */
const fileText = (name: string, lines: string[]) => `${name.replace(/\.txt$/, "")}\r\n\r\n${lines.join("\r\n")}\r\n`;
const FILE = "BTN_RJ_BREAKING_6001_13NOV_US_CONTROL_JPR3_BIG.txt";
function draft(lines: string[], name = FILE): BreakingDraft {
  const p = parseBreaking(fileText(name, lines), name, book);
  const slot = slotFromTags(p.tags);
  return composeBreaking(
    { ...p, rawHeadline: p.rawHeadline, reporterToken: slot.reporterToken, fileDistrict: slot.district, unknownBureauCode: slot.unknownCode },
    rules, book, { subjects, reporters, parties },
  );
}
const officeOffers = (d: BreakingDraft) => d.handleSuggestions.filter((h) => h.reason === "office").map((h) => h.handle);

describe("3. the Chief Secretary named without a name: offered, never tagged", () => {
  const cs = subjects.offices!.find((o) => o.key === "rajasthan_cs")!;

  it("is configured in the offices block beside the CM, through the file's own entry", () => {
    expect(cs).toBeDefined();
    expect(cs.handles).toEqual(["svoruganti1466"]);
    expect(cs.source).toBe("office_alias.rajasthan_cs");
    expect(subjects.handles!.has("svoruganti1466")).toBe(true);
  });

  it("मुख्य सचिव, CS, Chief Secretary: named", () => {
    expect(namesOffice(cs, "मुख्य सचिव ने ली अधिकारियों की बैठक")).toBe(true);
    expect(namesOffice(cs, "CS ने दिए निर्देश")).toBe(true);
    expect(namesOffice(cs, "Chief Secretary reviews flood relief")).toBe(true);
    expect(namesOffice(cs, "बैठक में CS, DGP और कलेक्टर मौजूद")).toBe(true);
  });

  it("CS only as a whole word: not ACS, CSR, CSIR; not the Hindi ACS", () => {
    expect(namesOffice(cs, "ACS अभय कुमार ने किया निरीक्षण")).toBe(false);
    expect(namesOffice(cs, "CSR फंड से बना स्कूल")).toBe(false);
    expect(namesOffice(cs, "CSIR की टीम पहुंची")).toBe(false);
    expect(namesOffice(cs, "अतिरिक्त मुख्य सचिव अभय कुमार ने किया निरीक्षण")).toBe(false);
    expect(namesOffice(cs, "Additional Chief Secretary visits hospital")).toBe(false);
    expect(namesOffice(cs, "प्रमुख सचिव ने ली बैठक")).toBe(false);
  });

  it("a former holder or another state's CS in the same sentence: not ours", () => {
    expect(namesOffice(cs, "MP के पूर्व CS का निधन")).toBe(false);
    expect(namesOffice(cs, "पूर्व मुख्य सचिव ने साधा निशाना")).toBe(false);
    expect(namesOffice(cs, "Former Chief Secretary joins BJP")).toBe(false);
    expect(namesOffice(cs, "Ex CS writes to the CM")).toBe(false);
    expect(namesOffice(cs, "रिटायर्ड मुख्य सचिव की किताब का विमोचन")).toBe(false);
    expect(namesOffice(cs, "उत्तर प्रदेश के मुख्य सचिव पहुंचे जयपुर")).toBe(false);
    expect(namesOffice(cs, "दिल्ली के मुख्य सचिव का तबादला")).toBe(false);
    expect(namesOffice(cs, "CS परीक्षा का परिणाम जारी, ICSI ने बताया")).toBe(false);
    // an exclusion in another sentence does not stop it
    expect(namesOffice(cs, "पूर्व सरपंच ने की शिकायत। मुख्य सचिव ने दिए जांच के निर्देश")).toBe(true);
  });

  it("on a draft: offered as office_alias.rajasthan_cs, never on the post", () => {
    const d = draft(["मुख्य सचिव ने ली जिला कलेक्टरों की बैठक", "बारिश से हुए नुकसान का आकलन करने के निर्देश"]);
    expect(d.mentions).not.toContain("@svoruganti1466");
    expect(d.handles.map((h) => h.handle)).not.toContain("svoruganti1466");
    expect(officeOffers(d)).toContain("svoruganti1466");
    expect(d.handleSuggestions.find((h) => h.handle === "svoruganti1466")).toMatchObject({ reason: "office", source: "office_alias.rajasthan_cs", detail: "Chief Secretary mentioned without a name" });
  });

  it("ACS अभय कुमार on a draft: no CS suggestion", () => {
    const d = draft(["ACS अभय कुमार ने किया अस्पताल का निरीक्षण", "व्यवस्थाओं पर जताई नाराजगी"]);
    expect(d.handleSuggestions.map((h) => h.handle)).not.toContain("svoruganti1466");
    expect(d.handles.map((h) => h.handle)).not.toContain("svoruganti1466");
  });

  it("outside Rajasthan: nothing", () => {
    const d = composeBreaking({ headline: "मुख्य सचिव ने ली बैठक", points: ["बाढ़ राहत की समीक्षा"], district: null, town: null, rajasthan: false, leaderPost: false }, rules, book, { subjects, reporters, parties });
    expect(officeOffers(d)).not.toContain("svoruganti1466");
  });

  it("the CM office is unchanged beside it", () => {
    const d = draft(["CM ने भी स्वयं दी आहुतियां", "मुख्य सचिव भी रहे मौजूद"]);
    expect(officeOffers(d)).toEqual(["BhajanlalBjp", "RajCMO", "svoruganti1466"]);
  });
});
