// Step 5: the composer's rules, on a small test directory (test/fixtures/directory), so step 6's learning can rebuild
// the real one without breaking these. Its parity with directory/eval.py on the real directory was checked on the 55
// posts of 21 and 27 Nov (README §5); the last test only checks the real directory loads cleanly.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { XvComposer, XvTerms, xvCompose, xvLoadDirectory } from "../src/compose/compose";

const FIX = fileURLToPath(new URL("./fixtures/directory/", import.meta.url));
const VIDEO = `${FIX}video/`;
const SHARED = `${FIX}shared/`;
const dir = xvLoadDirectory(VIDEO, SHARED);
const on = (parts: { value: string; on: boolean }[]) => parts.filter((p) => p.on).map((p) => p.value);
const off = (parts: { value: string; on: boolean }[]) => parts.filter((p) => !p.on).map((p) => p.value);
const compose = (headline: string, more: { fileTitle?: string; day?: string | null; model?: { district: string; state: string; topicHashtags: string[] } } = {}) =>
  xvCompose({ headline, fileTitle: more.fileTitle ?? "", day: more.day === undefined ? "2026-11-27" : more.day, model: more.model }, dir);

describe("terms", () => {
  it("match Devanagari words whole and Latin words in any case, with the nukta or without", () => {
    const t = new XvTerms(["जयपुर", "Jaipur", "पड़ा", "C++"]);
    expect(t.test("जयपुर में हादसा")).toBe(true);
    expect(t.test("जयपुरिया अस्पताल")).toBe(false);
    expect(t.test("JAIPUR airport")).toBe(true);
    expect(t.test("Jaipuria")).toBe(false);
    expect(t.test("पडा भारी")).toBe(true);
    expect(t.test("C++ class")).toBe(true);
    expect(t.test("Cxx")).toBe(false);
    expect(new XvTerms([]).empty).toBe(true);
    expect(new XvTerms([null, 5, " "]).empty).toBe(true);
  });
});

describe("loading the directory", () => {
  it("skips what it cannot use and says so", () => {
    expect(dir.tags.map((t) => t.tag)).toEqual(["#Election2026", "#RoadAccident", "#CppNews"]);
    expect(dir.problems.join(" ")).toMatch(/#Broken: pattern skipped/);
    expect(dir.problems.join(" ")).toMatch(/a district without a tag/);
    expect(dir.places.map((p) => p.tag)).toEqual(["Tonk", "Kota", "Jodhpur"]);
  });

  it("the real directory loads with nothing skipped", () => {
    const real = xvLoadDirectory();
    expect(real.problems).toEqual([]);
    expect(real.places.length).toBeGreaterThan(40);
    // Tags still waiting for keywords (needs_keywords) are left out: about 30 have keywords or patterns
    expect(real.tags.length).toBeGreaterThan(20);
  });
});

describe("the composer", () => {
  it("a crime story in a district: the place tag and the district's police on, the rest offered", () => {
    const c = compose("NH-52 पर भीषण सड़क हादसा, बुजुर्ग की मौत | Tonk News", { fileTitle: "tonk hadsa" });
    expect([c.district, c.region, c.channelLabel]).toEqual(["Tonk", "rajasthan", "Tonk News"]);
    expect(on(c.hashtags)).toEqual(["#Tonk"]);
    expect(off(c.hashtags)).toEqual(["#RajasthanNews", "#RoadAccident"]);
    expect(on(c.mentions)).toEqual(["@TonkPolice"]);
    expect(c.hashtags.some((h) => /^#(FINVideo|RajasthanWithFirstIndia|FirstIndiaNews)$/i.test(h.value))).toBe(false);
  });

  it("a town finds its district", () => {
    expect(compose("निवाई में बड़ा फैसला").district).toBe("Tonk");
  });

  it("the collector is offered on an administration story, on whole words only", () => {
    expect(off(compose("टोंक में कांग्रेस की प्रत्याशी निर्विरोध प्रधान बनीं").mentions)).toEqual(["@DMTonk"]);
    expect(compose("टोंक पहुंचे प्रधानमंत्री, ADM ने किया स्वागत").mentions.map((m) => m.value)).toEqual([]);
  });

  it("a campaign pattern counts inside its own dates, nukta or not", () => {
    expect(off(compose("जयपुर में पंचायत चुनाव की मतगणना शुरू").hashtags)).toContain("#Election2026");
    expect(compose("जयपुर में पंचायत चुनाव की मतगणना शुरू", { day: "2026-12-05" }).hashtags.map((h) => h.value)).not.toContain("#Election2026");
    expect(compose("पंचायत चुनाव", { day: null }).hashtags.map((h) => h.value)).not.toContain("#Election2026");
    expect(off(compose("कांग्रेस को बढ़त, भाजपा पीछे").hashtags)).toContain("#Election2026");
    expect(off(compose("कांग्रेस को बढत, भाजपा पीछे").hashtags)).toContain("#Election2026");
  });

  it("people and parties are offered by name or keyword", () => {
    expect(off(compose("राम कुमार ने भाजपा छोड़ी").mentions)).toEqual(["@PersonA", "@BJP4Test"]);
  });

  it("a story outside Rajasthan: no district, region india, the state the model named", () => {
    const c = compose("बिहार में अपराधियों के खिलाफ कार्रवाई की मांग");
    expect([c.district, c.region, c.channelLabel]).toEqual([null, "india", "India News"]);
    expect(c.hashtags.map((h) => h.value)).not.toContain("#RajasthanNews");
    const m = compose("अपराधियों के खिलाफ कार्रवाई की मांग", { model: { district: "", state: "Bihar", topicHashtags: [] } });
    expect([m.region, m.channelLabel]).toEqual(["india", "Bihar News"]);
    expect(compose("नई घोषणा", { model: { district: "", state: "  ", topicHashtags: [] } }).channelLabel).toBe("Rajasthan News");
  });

  it("the model's place when the title names none, and its topic tags offered", () => {
    const c = compose("हॉस्टल की 5वीं मंजिल से युवक ने की आत्महत्या", { model: { district: "kota", state: "Rajasthan", topicHashtags: ["#KotaSuicide", "#FINVideo", "not a tag"] } });
    expect([c.district, c.channelLabel]).toEqual(["Kota", "Kota News"]);
    expect(on(c.hashtags)).toEqual(["#Kota"]);
    expect(c.hashtags.find((h) => h.value === "#KotaSuicide")).toMatchObject({ on: false, why: "model" });
    expect(c.hashtags.map((h) => h.value)).not.toContain("#FINVideo");
  });

  it("a title naming a place wins over the model's; a model field missing does no harm", () => {
    expect(compose("जोधपुर में सड़क हादसा", { model: { district: "Kota", state: "Rajasthan", topicHashtags: [] } }).district).toBe("Jodhpur");
    const broken = { district: undefined, state: null, topicHashtags: [5] } as unknown as { district: string; state: string; topicHashtags: string[] };
    expect(compose("नई घोषणा", { model: broken }).channelLabel).toBe("Rajasthan News");
  });

  it("no place: Rajasthan News; the file name's own ending is kept", () => {
    expect(compose("प्रदेश में नए नियम लागू", { day: null }).channelLabel).toBe("Rajasthan News");
    expect(compose("नई भर्ती का ऐलान | Jodhpur | Rajasthan News").channelLabel).toBe("Jodhpur | Rajasthan News");
  });

  it("a reporter's handle only from the file's own name, even when another list has the handle", () => {
    expect(off(compose("प्रदेश में नए नियम", { fileTitle: "rituraj cm visit" }).mentions)).toEqual(["@reporterone"]);
    expect(compose("rituraj ने बताया", { fileTitle: "cm visit" }).mentions).toEqual([]);
    expect(off(compose("प्रदेश में नए नियम", { fileTitle: "alsoreporter clip" }).mentions)).toEqual(["@ReporterAlso"]);
  });

  it("#RajasthanNews is offered only while the desk uses it on half its posts", () => {
    expect(xvCompose({ headline: "टोंक में बैठक", fileTitle: "", day: null }, { ...dir, offerStateTag: false }).hashtags.map((h) => h.value)).toEqual(["#Tonk"]);
  });
});

describe("the composer's directory", () => {
  const tmp = mkdtempSync(join(tmpdir(), "xv-dir-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const copy = () => {
    const video = join(tmp, `video-${Math.random()}`) + "/";
    const shared = join(tmp, `shared-${Math.random()}`) + "/";
    mkdirSync(video);
    mkdirSync(shared);
    for (const f of ["format.json", "tags.json"]) copyFileSync(`${VIDEO}${f}`, `${video}${f}`);
    for (const f of ["rajasthan-places.json", "subject-handles.json", "party-handles.json", "district-handles.json", "reporter-handles.json"]) copyFileSync(`${SHARED}${f}`, `${shared}${f}`);
    return { video, shared };
  };
  const touch = (path: string) => utimesSync(path, new Date(), new Date(Date.now() + Math.round(Math.random() * 100_000) + 5000));
  const input = { headline: "नई सौगात टेस्टकीवर्ड", fileTitle: "", day: null };

  it("reloads when a file changes, and caches per clip state", () => {
    const { video, shared } = copy();
    const composer = new XvComposer(video, shared, 10, 0);
    expect(composer.compose(input)?.hashtags.map((h) => h.value)).not.toContain("#TestTag");
    expect(composer.compose(input)).toBe(composer.compose(input));
    const tags = JSON.parse(readFileSync(`${video}tags.json`, "utf8")) as { entries: object[] };
    tags.entries.push({ tag: "#TestTag", kind: "topic", rule: "suggest", keywords_hi: ["टेस्टकीवर्ड"], keywords_en: [] });
    writeFileSync(`${video}tags.json`, JSON.stringify(tags));
    touch(`${video}tags.json`);
    expect(composer.compose(input)?.hashtags.map((h) => h.value)).toContain("#TestTag");
  });

  it("keeps the last good directory when a file breaks, and composes nothing before one loads", () => {
    const { video, shared } = copy();
    const told: string[] = [];
    const composer = new XvComposer(video, shared, 10, 0, (m) => told.push(m));
    expect(composer.compose(input)).not.toBeNull();
    writeFileSync(`${video}tags.json`, "{ half written");
    touch(`${video}tags.json`);
    expect(composer.compose(input)).not.toBeNull();
    composer.compose(input);
    expect(told.filter((m) => /not reloaded \(the last good one stays\)/.test(m))).toHaveLength(1);

    const empty = copy();
    rmSync(`${empty.shared}district-handles.json`);
    const none: string[] = [];
    const cold = new XvComposer(empty.video, empty.shared, 10, 0, (m) => none.push(m));
    expect(cold.compose(input)).toBeNull();
    expect(none[0]).toMatch(/nothing is composed until it loads/);
  });

  it("follows a folder given as a function (learn's current build) and reloads when it switches", () => {
    const first = copy();
    const second = copy();
    const tags = JSON.parse(readFileSync(`${second.video}tags.json`, "utf8")) as { entries: object[] };
    tags.entries.push({ tag: "#SwitchTag", kind: "topic", rule: "suggest", keywords_hi: ["टेस्टकीवर्ड"], keywords_en: [] });
    writeFileSync(`${second.video}tags.json`, JSON.stringify(tags));
    let folder = first.video;
    const composer = new XvComposer(() => folder, first.shared, 10, 0);
    expect(composer.compose(input)?.hashtags.map((h) => h.value)).not.toContain("#SwitchTag");
    folder = second.video;
    expect(composer.compose(input)?.hashtags.map((h) => h.value)).toContain("#SwitchTag");
  });

  it("drops the least recently used compose when full", () => {
    const { video, shared } = copy();
    const composer = new XvComposer(video, shared, 2, 60_000);
    const a = composer.compose({ ...input, headline: "a" })!;
    const b = composer.compose({ ...input, headline: "b" })!;
    composer.compose({ ...input, headline: "a" });
    composer.compose({ ...input, headline: "c" });
    expect(composer.compose({ ...input, headline: "a" })).toBe(a);
    expect(composer.compose({ ...input, headline: "b" })).not.toBe(b);
  });
});
