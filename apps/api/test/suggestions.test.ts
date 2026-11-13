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
import { hashtagSuggestionsView, mentionSuggestionsView } from "../src/suggestions";

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

  it("passes core's detail through and drops a malformed score or n", () => {
    const m = { handleId: "suggest:prior:X", entity: "prior", handle: "@X", exact: false, source: "reporter_prior", reason: "r", detail: "rituraj files @X 40% (30 posts)", score: "high", n: 30 };
    expect(mentionSuggestionsView([m])).toEqual([{ handleId: "suggest:prior:X", entity: "prior", handle: "@X", exact: false, source: "reporter_prior", reason: "r", detail: "rituraj files @X 40% (30 posts)", n: 30 }]);
  });

  it("gives an older stored suggestion its rule id from the reason code in its handleId, and adds nothing else", () => {
    const old = { handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true };
    expect(mentionSuggestionsView([old])).toEqual([{ ...old, source: "district.police" }]);
    // Not a rule's suggestion (Samvadia composer, a desk handle id): left exactly as stored
    const other = { handleId: "h1", entity: "JDA", handle: "@JDAJaipur", exact: true };
    expect(mentionSuggestionsView([other])).toEqual([other]);
    expect(mentionSuggestionsView(null)).toEqual([]);
    expect(mentionSuggestionsView([null, 5, { handle: 1 }])).toEqual([]);
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
    expect(d.mentionSuggestions).toEqual([{ handleId: "rule:police:KotaPolice", entity: "police", handle: "@KotaPolice", exact: true, source: "district.police" }]);
  });
});
