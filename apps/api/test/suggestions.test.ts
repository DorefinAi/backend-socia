// The breaking draft's suggestions as the desk receives them (reporter-prior UI contract): mentionSuggestions
// items may carry source, reason, score and n; hashtagSuggestions mixes plain strings and { tag, source, reason,
// score?, n? }. Old drafts keep working. The view test needs TEST_DATABASE_URL (the database is wiped).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { hashtagSuggestionsView, mentionSuggestionsView, officeSourcesFrom, resetOfficeSources, setSuggestionLogger } from "../src/suggestions";

const URL_ = process.env.TEST_DATABASE_URL;

/** As the compose stage stores them since the rule ids (reporter-prior contract) */
const MENTIONS = [
  { handleId: "rule:police:JaipurPolice", entity: "police", handle: "@JaipurPolice", exact: true, source: "district.police", reason: "district.police" },
  { handleId: "suggest:prior:RajGovOfficial", entity: "prior", handle: "@RajGovOfficial", exact: false, source: "reporter_prior", reason: "rituraj files @RajGovOfficial stories 62% of the time (102 posts)", score: 0.62, n: 102 },
  { handleId: "suggest:beat:EduDeptRaj", entity: "beat", handle: "@EduDeptRaj", exact: false, source: "reporter_beat", reason: "rituraj's declared beat: education" },
  { handleId: "suggest:office:CMOfficeRajasthan", entity: "office", handle: "@CMOfficeRajasthan", exact: false, source: "office_alias.rajasthan_cm", reason: "CM mentioned without a name" },
];
const PICK = {
  cls: "government", why: "w", warnings: [], handles: [],
  tagSuggestions: [
    { tag: "#Jaipur", source: "reporter_policy", reason: "rituraj's videos go out as #Jaipur when the post names no district" },
    { tag: "#RoadAccident", source: "topic_rule", reason: "the org's topic rule matched the copy" },
    { tag: "#Prior", source: "reporter_prior", reason: "r", score: 0.4, n: 30 },
  ],
};

describe("suggestion views (no database)", () => {
  it("passes mention suggestions through with source, reason, score and n", () => {
    expect(mentionSuggestionsView(MENTIONS)).toEqual(MENTIONS);
  });

  it("reports unusable or malformed items once per draft, and never throws", () => {
    const warned: { obj: Record<string, unknown>; msg: string }[] = [];
    setSuggestionLogger({ warn: (obj, msg) => void warned.push({ obj, msg }) });
    try {
      const bad = [null, { handleId: "x", handle: "@X", exact: true, score: "high" }];
      expect(mentionSuggestionsView(bad, "draft-1")).toEqual([{ handleId: "x", handle: "@X", exact: true }]);
      mentionSuggestionsView(bad, "draft-1");
      expect(warned).toHaveLength(1);
      expect(warned[0]!.obj).toMatchObject({ draftId: "draft-1", dropped: 1, malformedFields: expect.arrayContaining(["item", "score"]) });
      // Not a list at all
      expect(mentionSuggestionsView({ not: "a list" }, "draft-2")).toEqual([]);
      expect(warned).toHaveLength(2);
      // A stored value that blows up while being read: only well-formed items go out (here none)
      const hostile = [new Proxy({}, { get: () => { throw new Error("boom"); } })];
      expect(mentionSuggestionsView(hostile, "draft-3")).toEqual([]);
      const pick = { get tagSuggestions(): never { throw new Error("boom"); } };
      expect(hashtagSuggestionsView(["#A"], pick as never, "draft-4")).toEqual(["#A"]);
      expect(warned.map((w) => w.obj.draftId)).toEqual(["draft-1", "draft-2", "draft-3", "draft-4"]);
    } finally {
      setSuggestionLogger({ warn: () => {} });
    }
  });

  it("reports the mention and the hashtag view of one draft each once (T2), and every problem of a draft with no id", () => {
    const warned: { obj: Record<string, unknown>; msg: string }[] = [];
    setSuggestionLogger({ warn: (obj, msg) => void warned.push({ obj, msg }) });
    try {
      const badMentions = [null];
      const badPick = { cls: "x", why: "", warnings: [], handles: [], tagSuggestions: [5] };
      mentionSuggestionsView(badMentions, "draft-t2");
      hashtagSuggestionsView(["#A"], badPick as never, "draft-t2");
      // Opened again: neither is reported twice
      mentionSuggestionsView(badMentions, "draft-t2");
      hashtagSuggestionsView(["#A"], badPick as never, "draft-t2");
      expect(warned.map((w) => [w.obj.draftId, w.obj.view])).toEqual([["draft-t2", "mention"], ["draft-t2", "hashtag"]]);
      // No draft id: nothing to tell drafts apart by, so each is reported, and none hides a draft id'd "?"
      warned.length = 0;
      mentionSuggestionsView(badMentions);
      mentionSuggestionsView(badMentions);
      hashtagSuggestionsView(["#A"], badPick as never);
      mentionSuggestionsView(badMentions, "?");
      expect(warned.map((w) => [w.obj.draftId, w.obj.view])).toEqual([[null, "mention"], [null, "mention"], [null, "hashtag"], ["?", "mention"]]);
    } finally {
      setSuggestionLogger({ warn: () => {} });
    }
  });

  it("falls back to the well-formed items only when mapping breaks (T3), and never throws", () => {
    const warned: { obj: Record<string, unknown>; msg: string }[] = [];
    setSuggestionLogger({ warn: (obj, msg) => void warned.push({ obj, msg }) });
    try {
      const boom = new Proxy({}, { get: () => { throw new Error("boom"); } });
      const good = { handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true, source: "district.police", reason: "r" };
      const stored = [good, boom, null, 7, "x", { handle: 1, handleId: "h" }, { handle: "@X" }, { handleId: "y", handle: "@Y", exact: "yes", score: "high", n: 3, source: "", extra: { raw: true } }];
      const out = mentionSuggestionsView(stored, "draft-t3");
      // Each item on its own (D-b): the one that blows up costs only itself, the others keep their fields
      expect(out).toEqual([good, { handleId: "y", handle: "@Y", exact: false, n: 3, extra: { raw: true } }]);
      expect(out[0]).not.toBe(good);
      expect(warned).toEqual([expect.objectContaining({ obj: expect.objectContaining({ draftId: "draft-t3", view: "mention", dropped: 6, malformedFields: expect.arrayContaining(["item", "handle", "score", "source"]) }) })]);
      // A list that cannot even be walked: nothing, not the raw value
      const unwalkable = new Proxy([good], { get: (t, k) => { if (k === "length" || k === Symbol.iterator) throw new Error("boom"); return Reflect.get(t, k); } });
      expect(mentionSuggestionsView(unwalkable, "draft-t3b")).toEqual([]);

      // Hashtags: the stored strings only, as plain tags; [] when the tags are not a list
      const pick = { get tagSuggestions(): never { throw new Error("boom"); } };
      expect(hashtagSuggestionsView(["#A", 5, null, { tag: "#B" }, "#C"] as never, pick as never, "draft-t3")).toEqual(["#A", "#C"]);
      expect(hashtagSuggestionsView(null as never, pick as never, "draft-t3c")).toEqual([]);
      expect(hashtagSuggestionsView({ length: 2 } as never, null, "draft-t3d")).toEqual([]);
      expect(hashtagSuggestionsView(new Proxy([], { get: () => { throw new Error("boom"); } }) as never, null, "draft-t3e")).toEqual([]);
    } finally {
      setSuggestionLogger({ warn: () => {} });
    }
  });

  it("gives an old office suggestion the rule id of the office listing its handle, never a guessed CM (S5)", () => {
    resetOfficeSources();
    const old = (handle: string) => ({ handleId: `suggest:office:${handle.slice(1)}`, entity: "office", handle, exact: false });
    // The worker's subject-handles.json: the Chief Secretary's account is not the CM's
    expect(mentionSuggestionsView([old("@svoruganti1466")])).toEqual([{ ...old("@svoruganti1466"), source: "office_alias.rajasthan_cs", sourceDerived: true }]);
    expect(mentionSuggestionsView([old("@BhajanlalBjp"), old("@rajcmo")])).toEqual([
      { ...old("@BhajanlalBjp"), source: "office_alias.rajasthan_cm", sourceDerived: true },
      { ...old("@rajcmo"), source: "office_alias.rajasthan_cm", sourceDerived: true },
    ]);
    // An office handle no office lists: no rule id rather than the CM's
    expect(mentionSuggestionsView([old("@SomeCollectorOffice")])).toEqual([old("@SomeCollectorOffice")]);
    // A stored source always wins
    expect(mentionSuggestionsView([{ ...old("@svoruganti1466"), source: "office_alias.rajasthan_cm" }])).toEqual([{ ...old("@svoruganti1466"), source: "office_alias.rajasthan_cm" }]);
  });

  it("reads the offices leniently, and a handle two offices list belongs to neither", async () => {
    expect([...officeSourcesFrom({ offices: { _note: "x", a: { handles: ["@One", " two ", 3] }, b: { handles: ["@ONE", "@Three"] }, c: null, d: { handles: "@Four" } } })]).toEqual([
      ["one", null], ["two", "office_alias.a"], ["three", "office_alias.b"],
    ]);
    expect(officeSourcesFrom(null).size).toBe(0);
    expect(officeSourcesFrom({ offices: [] }).size).toBe(0);
    // SUBJECT_HANDLES_FILE points elsewhere (as for the desk handles); an unreadable file means no office known
    const dir = await mkdtemp(join(tmpdir(), "socia-offices-"));
    const before = process.env.SUBJECT_HANDLES_FILE;
    try {
      await writeFile(join(dir, "s.json"), JSON.stringify({ offices: { rajasthan_cm: { handles: ["@Shared"] }, rajasthan_cs: { handles: ["@shared", "@CsOnly"] } } }));
      process.env.SUBJECT_HANDLES_FILE = join(dir, "s.json");
      resetOfficeSources();
      const old = (handle: string) => ({ handleId: `suggest:office:${handle.slice(1)}`, handle, exact: false });
      expect(mentionSuggestionsView([old("@Shared"), old("@CsOnly")])).toEqual([old("@Shared"), { ...old("@CsOnly"), source: "office_alias.rajasthan_cs", sourceDerived: true }]);
      process.env.SUBJECT_HANDLES_FILE = join(dir, "missing.json");
      resetOfficeSources();
      expect(mentionSuggestionsView([old("@CsOnly")])).toEqual([old("@CsOnly")]);
    } finally {
      if (before === undefined) delete process.env.SUBJECT_HANDLES_FILE;
      else process.env.SUBJECT_HANDLES_FILE = before;
      resetOfficeSources();
    }
  });

  it("passes core's detail through and drops a malformed score or n", () => {
    const m = { handleId: "suggest:prior:X", entity: "prior", handle: "@X", exact: false, source: "reporter_prior", reason: "r", detail: "rituraj files @X 40% (30 posts)", score: "high", n: 30 };
    expect(mentionSuggestionsView([m])).toEqual([{ handleId: "suggest:prior:X", entity: "prior", handle: "@X", exact: false, source: "reporter_prior", reason: "r", detail: "rituraj files @X 40% (30 posts)", n: 30 }]);
  });

  it("gives an older stored suggestion its rule id from the reason code in its handleId, and adds nothing else", () => {
    const old = { handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true };
    expect(mentionSuggestionsView([old])).toEqual([{ ...old, source: "district.police", sourceDerived: true }]);
    // Not a rule's suggestion (Samvadia composer, a desk handle id): left exactly as stored
    const other = { handleId: "h1", entity: "JDA", handle: "@JDAJaipur", exact: true };
    expect(mentionSuggestionsView([other])).toEqual([other]);
    expect(mentionSuggestionsView(null)).toEqual([]);
    expect(mentionSuggestionsView([null, 5, { handle: 1 }])).toEqual([]);
    // No entity stored: none invented
    expect(mentionSuggestionsView([{ handleId: "h2", handle: "@A", exact: false }])).toEqual([{ handleId: "h2", handle: "@A", exact: false }]);
  });

  it("makes a hashtag suggestion an object when its rule is known, a plain string otherwise, in stored order", () => {
    expect(hashtagSuggestionsView(["#RoadAccident", "#Jaipur", "#Unknown", "#Prior"], PICK as never)).toEqual([
      { tag: "#RoadAccident", source: "topic_rule", reason: "the org's topic rule matched the copy" },
      { tag: "#Jaipur", source: "reporter_policy", reason: "rituraj's videos go out as #Jaipur when the post names no district" },
      "#Unknown",
      { tag: "#Prior", source: "reporter_prior", reason: "r", score: 0.4, n: 30 },
    ]);
    // Drafts from before: strings, as they always were
    expect(hashtagSuggestionsView(["#Kota"], null)).toEqual(["#Kota"]);
    expect(hashtagSuggestionsView(["#Kota"], { cls: "other", why: "", warnings: [], handles: [] } as never)).toEqual(["#Kota"]);
  });

  it("shows a Hindi tag stored in two Unicode forms once, in NFC, with its rule (D-a)", () => {
    // "ख़बर": the precomposed letter (U+0959) and ख + nukta (U+0916 U+093C); NFC is the second. "Café" both ways too.
    const pre = "#ख़बर";
    const dec = "#ख़बर";
    expect(pre).not.toBe(dec);
    expect(pre.normalize("NFC")).toBe(dec);
    const pick = { ...PICK, tagSuggestions: [
      { tag: pre, source: "topic_rule", reason: "the org's topic rule matched the copy" },
      { tag: "#CAFÉ", source: "reporter_policy", reason: "p" },
    ] };
    const out = hashtagSuggestionsView([pre, "#Café", dec, "#Café", "#Other"], pick as never);
    expect(out).toEqual([
      { tag: dec, source: "topic_rule", reason: "the org's topic rule matched the copy" },
      { tag: "#Café", source: "reporter_policy", reason: "p" },
      "#Other",
    ]);
    // A rule stored in the other form still finds the tag
    expect(hashtagSuggestionsView([pre], { ...PICK, tagSuggestions: [{ tag: dec, source: "topic_rule", reason: "r" }] } as never)).toEqual([{ tag: dec, source: "topic_rule", reason: "r" }]);
    // The fallback (a list that breaks while being walked) also sends NFC, each tag once
    const breaks = new Proxy([pre, dec, "#X"], { get: (t, k) => { if (k === "2") throw new Error("boom"); return Reflect.get(t, k); } });
    expect(hashtagSuggestionsView(breaks as never, null)).toEqual([dec]);
  });

  it("lets one malformed tag or rule hide only its own reason line (D-b)", () => {
    const warned: { obj: Record<string, unknown>; msg: string }[] = [];
    setSuggestionLogger({ warn: (obj, msg) => void warned.push({ obj, msg }) });
    try {
      const pick = { ...PICK, tagSuggestions: [
        { tag: "#A", source: "topic_rule", reason: "a" },
        { tag: "#B", get source(): never { throw new Error("boom"); } },
        { get tag(): never { throw new Error("boom"); } },
        { tag: 7, source: "topic_rule" },
        { tag: "#C", source: "reporter_policy", reason: "c" },
      ] };
      expect(hashtagSuggestionsView(["#A", 5, "#B", null, { tag: "#X" }, "#C"] as never, pick as never, "draft-db")).toEqual([
        { tag: "#A", source: "topic_rule", reason: "a" },
        "#B",
        { tag: "#C", source: "reporter_policy", reason: "c" },
      ]);
      expect(warned).toEqual([expect.objectContaining({ obj: expect.objectContaining({ draftId: "draft-db", view: "hashtag" }) })]);

      // Mentions: an item that breaks while being mapped goes out from its well-formed fields; the others untouched
      warned.length = 0;
      const good = { handleId: "suggest:prior:X", entity: "prior", handle: "@X", exact: false, source: "reporter_prior", reason: "r", score: 0.5, n: 20 };
      const odd = new Proxy({ handleId: "rule:police:KotaPolice", handle: "@KotaPolice", exact: true, reason: "kota" }, { ownKeys: () => { throw new Error("boom"); } });
      expect(mentionSuggestionsView([good, odd, null], "draft-db")).toEqual([good, { handleId: "rule:police:KotaPolice", handle: "@KotaPolice", exact: true, reason: "kota" }]);
      expect(warned).toEqual([expect.objectContaining({ obj: expect.objectContaining({ draftId: "draft-db", view: "mention", dropped: 1, malformedFields: expect.arrayContaining(["item", "unreadable"]) }) })]);
    } finally {
      setSuggestionLogger({ warn: () => {} });
    }
  });
});

(URL_ ? describe : describe.skip)("GET /drafts/:id carries the suggestion rule ids", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let draftId = "";
  let oldDraftId = "";
  const s = { cookie: "", csrf: "" };

  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 5).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    const orgId = org!.id;
    await h.db.insert(users).values({ orgId, name: "Op", email: "op@test", passwordHash: await hashPassword("correct horse battery"), role: "operator" });
    const mk = async (values: Partial<typeof postDrafts.$inferInsert>) => {
      const [story] = await h.db.insert(stories).values({ orgId, slug: "s", status: "composed", headline: "h", body: "", layout: "breaking", mediaState: "none" }).returning();
      const [d] = await h.db
        .insert(postDrafts)
        .values({ orgId, storyId: story!.id, status: "ready", bodyText: "h", cardHeadline: "h", hashtags: ["#RajasthanWithFirstIndia"], composeVersion: "b7", cardRev: 0, ...values })
        .returning();
      return d!.id;
    };
    draftId = await mk({ mentionSuggestions: MENTIONS, hashtagSuggestions: ["#Jaipur", "#RoadAccident", "#Kota"], handlePick: PICK as never });
    oldDraftId = await mk({
      mentionSuggestions: [
        { handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true },
        { handleId: "suggest:office:svoruganti1466", entity: "office", handle: "@svoruganti1466", exact: false },
      ],
      hashtagSuggestions: ["#Kota"],
    });

    app = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-sugg-")), "http://localhost/dev-files"), config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  const get = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/drafts/${id}`, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  };

  it("reporter, beat and office handles come through mentionSuggestions with their source and reason", async () => {
    const d = await get(draftId);
    expect(d.mentionSuggestions).toEqual(MENTIONS);
    expect(d.hashtagSuggestions).toEqual([
      { tag: "#Jaipur", source: "reporter_policy", reason: "rituraj's videos go out as #Jaipur when the post names no district" },
      { tag: "#RoadAccident", source: "topic_rule", reason: "the org's topic rule matched the copy" },
      "#Kota",
    ]);
  });

  it("an older draft keeps its shape, plus the rule id its reason code implies", async () => {
    const d = await get(oldDraftId);
    expect(d.hashtagSuggestions).toEqual(["#Kota"]);
    expect(d.mentionSuggestions).toEqual([
      { handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true, source: "district.police", sourceDerived: true },
      { handleId: "suggest:office:svoruganti1466", entity: "office", handle: "@svoruganti1466", exact: false, source: "office_alias.rajasthan_cs", sourceDerived: true },
    ]);
  });
});
