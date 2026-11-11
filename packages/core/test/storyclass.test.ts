// The story class every handle rule hangs off (storyclass.ts), the party handles (parties.ts) and the
// shape each class produces (handles.ts). The expectations here are the counted behaviour of 1,002
// published @1stIndiaNews posts, not a preference: where a rule and the corpus disagreed, the corpus won,
// and the comment says by how much.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EMPTY_HANDLE_RULES, PlaceBook, classify, isIncident, namesAnyParty, parseHandleRules, parsePartyHandles, parsePlacesData, parseSubjectHandles,
  pickHandlesExplained, pickParty,
} from "../src";

const json = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const book = new PlaceBook(parsePlacesData(json("../../../apps/worker/config/rajasthan-places.json")));
const rules = parseHandleRules(json("../../../apps/worker/config/district-handles.json"));
const subjects = parseSubjectHandles(json("../../../apps/worker/config/subject-handles.json"));
const parties = parsePartyHandles(json("../../../apps/worker/config/party-handles.json"));
void book;

const cls = (headline: string, points: string[] = [], namedPolitical = false) => classify({ headline, points, leaderPost: false, namedPolitical }).cls;

describe("story class", () => {
  it("sorts the shapes the desk uses", () => {
    expect(cls("जयपुर में युवक की हत्या, आरोपी गिरफ्तार")).toBe("incident");
    expect(cls("जिला कलेक्टर ने किया निरीक्षण")).toBe("administration");
    expect(cls("मुख्यमंत्री भजनलाल शर्मा का दौरा")).toBe("political");
    expect(cls("मुख्य सचिव ने जारी की अधिसूचना")).toBe("government");
    expect(cls("हाईकोर्ट में सुनवाई टली")).toBe("judicial");
    expect(cls("गोवर्धन पूजा की तैयारी, मंदिर में श्रद्धालुओं की भीड़")).toBe("soft");
    expect(cls("बाजार में रौनक")).toBe("other");
    expect(classify({ headline: "पुलिस ने किया गिरफ्तार", points: [], leaderPost: true }).cls).toBe("leader_post");
  });

  it("lets the headline decide, and reads the body only when the headline is silent", () => {
    // Diwali week: half the political posts mention a temple below the fold. Testing both together cost
    // 31 of them.
    expect(cls("मुख्यमंत्री भजनलाल शर्मा जैसलमेर दौरे पर", ["मंदिर में पूजा की", "श्रद्धालुओं से मिले"])).toBe("political");
    expect(cls("बाजार में रौनक", ["पुलिस ने चोरी के आरोपी को पकड़ा"])).toBe("incident");
    expect(classify({ headline: "बाजार में रौनक", points: ["पुलिस ने चोरी के आरोपी को पकड़ा"], leaderPost: false }).why).toMatch(/from the body/);
  });

  it("keeps the measured order: judicial over incident, result over political, political over mourning", () => {
    // Court copy is full of आरोपी and जमानत and the desk tagged no police on it (16 of 22 reporter-only)
    expect(cls("हाईकोर्ट में फर्जी जमानत आदेश अपलोड करने के मामले में बड़ी कार्रवाई, आरोपी गिरफ्तार")).toBe("judicial");
    // A bulletin that names the winner is still a bulletin: 18 of 23 result posts tagged nobody
    expect(cls("सरपंच चुनाव का परिणाम घोषित, प्रत्याशी बनवारी लाल 827 मतों से विजयी")).toBe("soft");
    // A leader's condolence message is political copy: 18 of 37 mourning posts tagged a politician
    expect(cls("मुख्यमंत्री ने जताया शोक, दिवंगत के परिवार से मिले")).toBe("political");
    expect(cls("समाजसेवी का निधन, आज होगी अंत्येष्टि")).toBe("soft");
    // "विधायक के घर चोरी" is a police story, the cheaper of the two errors
    expect(cls("विधायक के घर चोरी, पुलिस जांच में जुटी")).toBe("incident");
  });

  it("splits administration: a named officer ranks high, a bare body below the soft rules", () => {
    // One list tagged a collector on every panchayat bulletin; the split took recall 26.5% -> 58.0%
    expect(cls("SDM-ERO रजत विजयवर्गीय ने जारी किया मतदान बुलेटिन")).toBe("administration");
    expect(cls("जिला निर्वाचन अधिकारी ने संभाला मोर्चा")).toBe("administration");
    expect(cls("पंचायत समिति रेवदर का सरपंच परिणाम जारी")).toBe("soft");
    expect(cls("नगर परिषद की बैठक में हुआ फैसला")).toBe("administration");
  });

  it("needs an election for a bare result word, so an exam result is not a bulletin", () => {
    expect(cls("आरपीएससी ने जारी किया परिणाम")).not.toBe("soft");
    expect(cls("बोर्ड परीक्षा का परिणाम जारी")).not.toBe("soft");
    expect(cls("पंचायत चुनाव का परिणाम जारी")).toBe("soft");
    expect(cls("मतदान हुआ संपन्न")).toBe("soft");
  });

  it("holds the guards that measurement reversed, and the four words that look safe and are not", () => {
    // A near miss is still a police matter: the desk tagged district police on 4 of 5
    expect(isIncident("हादसा टल गया, चालक बाल-बाल बचा")).toBe(true);
    // A close contest is not a collision; a bail order is not a crime report
    expect(isIncident("दोनों प्रत्याशियों में कांटे की टक्कर")).toBe(false);
    expect(isIncident("आरोपी की जमानत याचिका पर सुनवाई")).toBe(false);
    // "आंधी" is a TOWN in Jaipur Rural, not a storm: a weather word list that holds it tags its police
    expect(cls("आंधी में बारिश से फसल खराब")).not.toBe("incident");
    // "कार्यकर्ता" means "worker" generally — it made an obituary political
    expect(cls("सामाजिक कार्यकर्ता संजीत बंकर रॉय का निधन")).toBe("soft");
    // "बहिष्कार" means any boycott; only an election boycott is election machinery
    expect(cls("कर्मचारियों ने किया कामकाज का बहिष्कार")).not.toBe("soft");
    expect(cls("ग्रामीणों ने किया मतदान बहिष्कार")).toBe("soft");
    // A gossip column is tagged BY SUBJECT, not left untagged
    expect(cls("ब्यूरोक्रेटिक गपशप: सचिवालय में चर्चा")).toBe("government");
  });

  it("tokenises on punctuation, so a key word before a comma still counts", () => {
    expect(cls("युवक की हत्या, पेट में मारा चाकू")).toBe("incident");
    expect(cls("भीषण हादसा; तीन की मौत")).toBe("incident");
  });

  it("takes the named-political hint, because Devanagari gives a name no orthographic cue", () => {
    // Political recall is 92.5% with the hint and 84.4% without
    expect(cls("अशोक गहलोत जयपुर पहुंचे")).toBe("other");
    expect(cls("अशोक गहलोत जयपुर पहुंचे", [], true)).toBe("political");
  });
});

describe("party handles", () => {
  it("prefers the state handle on Rajasthan copy and the national one outside it", () => {
    expect(pickParty("भाजपा प्रत्याशी ने किया जनसंपर्क", parties, true)?.handle).toBe("BJP4Rajasthan");
    expect(pickParty("भाजपा मुख्यालय में बैठक", parties, false)?.handle).toBe("BJP4India");
    expect(pickParty("कांग्रेस की बैठक", parties, true)?.handle).toBe("INCRajasthan");
  });

  it("tags neither party on a clash story, and nobody when none is named", () => {
    expect(pickParty("कांग्रेस ने भाजपा पर साधा निशाना", parties, true)).toBeNull();
    expect(namesAnyParty("कांग्रेस ने भाजपा पर साधा निशाना", parties)).toBe(true); // still political copy
    expect(pickParty("जयपुर में बारिश", parties, true)).toBeNull();
    expect(namesAnyParty("जयपुर में बारिश", parties)).toBe(false);
  });

  it("matches a keyword as a whole word, so INC does not fire on 'since' or 'incident'", () => {
    expect(pickParty("The incident happened since morning", parties, true)).toBeNull();
    expect(pickParty("INC leaders met", parties, true)?.handle).toBe("INCRajasthan");
  });

  it("refuses a malformed file and skips a bad entry", () => {
    expect(() => parsePartyHandles({ version: 1 })).toThrow(/entries/);
    const problems: string[] = [];
    const r = parsePartyHandles({ version: 1, entries: [{ handle: "not a handle!", party: "x", verified: true }, { handle: "@Ok", party: "y", verified: true }] }, (m) => problems.push(m));
    expect(r.count).toBe(0); // @Ok has no keywords to match on
    expect(problems).toHaveLength(2);
  });
});

describe("what each class tags", () => {
  const story = (headline: string, extra: Record<string, unknown> = {}) => ({
    headline, points: [], district: "Jaipur", rajasthan: true, leaderPost: false, ...extra,
  });
  const pick = (headline: string, extra: Record<string, unknown> = {}) =>
    pickHandlesExplained(story(headline, extra), rules, { subjects, parties }).handles.map((h) => `${h.reason}:${h.handle}`);

  it("gives an incident the district police and an administration story the collector, alone", () => {
    expect(pick("जयपुर में बेकाबू कार ने मारी टक्कर, दो घायल")).toEqual(["police:jaipur_police"]);
    expect(pick("जिला कलेक्टर ने ली बैठक")).toEqual(["collector:DcDmJaipur"]);
  });

  it("gives political copy the leader, then the party", () => {
    expect(pick("मुख्यमंत्री भजनलाल शर्मा ने भाजपा प्रत्याशी के लिए किया जनसंपर्क")).toEqual(["cm:BhajanlalBjp", "party:BJP4Rajasthan"]);
  });

  it("gives a court story our reporter and no institution, and a festival nobody", () => {
    expect(pick("हाईकोर्ट में आरोपी की जमानत याचिका पर सुनवाई")).toEqual([]);
    expect(pick("गोवर्धन पूजा में उमड़े श्रद्धालु")).toEqual([]);
  });

  it("keeps every guard that a wrong tag would cost us", () => {
    // A leader's own post tags nobody, not even the reporter
    expect(pick("पुलिस ने किया गिरफ्तार", { leaderPost: true })).toEqual([]);
    // No police handle and no collector ever appears beside a party
    const withParty = pick("भाजपा प्रत्याशी के समर्थन में जनसंपर्क, पुलिस ने संभाला मोर्चा");
    expect(withParty.some((h) => h.startsWith("police:") || h.startsWith("collector:"))).toBe(false);
    expect(withParty).toContain("party:BJP4Rajasthan");
    // Copy from outside Rajasthan tags no state institution
    expect(pick("दिल्ली में हत्या का आरोपी गिरफ्तार", { rajasthan: false, district: "Delhi" })).toEqual([]);
    // An empty handles file tags nobody
    expect(pickHandlesExplained(story("जयपुर में चोरी"), EMPTY_HANDLE_RULES, { subjects, parties }).handles).toEqual([]);
    // Never more than 3
    const many = pickHandlesExplained(
      story("मुख्यमंत्री भजनलाल शर्मा और अशोक गहलोत ने भाजपा और कांग्रेस पर की टिप्पणी, वासुदेव देवनानी भी रहे मौजूद"),
      rules, { subjects, parties },
    ).handles;
    expect(many.length).toBeLessThanOrEqual(3);
  });

  it("does not tag our police when the officer the copy names is another district's", () => {
    const other = pickHandlesExplained(
      story("जयपुर में चोरी का खुलासा", { points: ["बूंदी एसपी ने आरोपी को पकड़ा"], elsewhere: (w: string) => /बूंदी/.test(w) }),
      rules, { subjects, parties },
    );
    expect(other.handles).toEqual([]);
    // ...but an incident with no officer named at all still tags the district's own force
    expect(pick("जयपुर में चोरी का खुलासा")).toEqual(["police:jaipur_police"]);
  });

  it("says which force it used where a district has two of them", () => {
    // Jaipur, Jodhpur, Kota and Khairthal-Tijara each have a city and a rural force, and which one a
    // story belongs to needs a town list the desk has not confirmed. The draft carries the ambiguity.
    const jaipur = pickHandlesExplained(story("जयपुर में युवक की हत्या"), rules, { subjects, parties });
    expect(jaipur.handles.map((h) => h.handle)).toEqual(["jaipur_police"]);
    expect(jaipur.warnings.join(" ")).toMatch(/Jaipur has 2 police handles/);
    // A district with one force says nothing
    expect(pickHandlesExplained(story("युवक की हत्या", { district: "Sirohi" }), rules, { subjects, parties }).warnings).toEqual([]);
  });

  it("carries the class, the reason and the warnings for the draft's audit line", () => {
    const out = pickHandlesExplained(story("युवक की हत्या", { district: "Sirohi" }), rules, { subjects, parties });
    expect(out.cls).toBe("incident");
    expect(out.why).toMatch(/crime/);
    expect(out.warnings).toEqual([]);
    const odd = pickHandlesExplained(story("जयपुर में बारिश", { unknownBureauCode: "XYZ", fileDistrict: "Kota" }), rules, { subjects, parties });
    expect(odd.warnings.join(" ")).toMatch(/XYZ/);
    expect(odd.warnings.join(" ")).toMatch(/the copy decides/);
  });
});
