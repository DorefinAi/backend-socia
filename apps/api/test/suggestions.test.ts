// The breaking draft's suggestions as the desk receives them (reporter-prior UI contract): mentionSuggestions
// items may carry source, reason, score and n; hashtagSuggestions mixes plain strings and { tag, source, reason,
// score?, n? }. Old drafts keep working. The view test needs TEST_DATABASE_URL (the database is wiped).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { hashtagSuggestionsView, mentionSuggestionsView, setSuggestionLogger } from "../src/suggestions";

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
      expect(out).toEqual([good, { handleId: "y", handle: "@Y", exact: false, n: 3 }]);
      expect(out[0]).not.toBe(good);
      expect(warned).toEqual([expect.objectContaining({ obj: expect.objectContaining({ draftId: "draft-t3", view: "mention", kept: 2 }) })]);
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
    oldDraftId = await mk({ mentionSuggestions: [{ handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true }], hashtagSuggestions: ["#Kota"] });

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
    expect(d.mentionSuggestions).toEqual([{ handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true, source: "district.police", sourceDerived: true }]);
  });
});
