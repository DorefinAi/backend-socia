// Copy & Posted through the API learns the desk's handles and hashtags (tag-learning.ts, packages/db learn.ts): the
// route builds the learner from the worker's data files and passes it to the posting call. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog, createDb, handleDirectory, hashtagRules, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { PostedTagLearning } from "../src/tag-learning";

const URL_ = process.env.TEST_DATABASE_URL;
const silent = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => silent, level: "silent", silent: () => {} } as never;

describe("PostedTagLearning", () => {
  it("builds a learner from the worker's data files, and none while one cannot be read", async () => {
    expect(await new PostedTagLearning(silent).learner()).not.toBeNull();
    expect(await new PostedTagLearning(silent, { ...process.env, PLACES_FILE: join(tmpdir(), "no-such-places.json") }).learner()).toBeNull();
  });
});

(URL_ ? describe : describe.skip)("learning on Copy & Posted", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let draftId = "";
  const op = { cookie: "", csrf: "" };
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
    await h.db.insert(handleDirectory).values({ orgId, entityName: "ChaksuNews", aliases: [], handle: "ChaksuNews", source: "desk", verifiedAt: new Date() });
    const [story] = await h.db
      .insert(stories)
      .values({ orgId, slug: "chaksu", status: "composed", headline: "चाकसू में हादसा", body: "", district: "Jaipur", layout: "breaking", mediaState: "none" })
      .returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status: "ready", bodyText: "#Jaipur: चाकसू में हादसा", cardHeadline: "चाकसू में हादसा", hashtags: ["#RajasthanWithFirstIndia", "#Jaisalmer"],
        mentions: ["@ChaksuNews"], composeVersion: "b2", cardRev: 0, handlePick: { cls: "other", why: "", warnings: [], handles: [] },
      })
      .returning();
    draftId = draft!.id;
    app = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-learn-")), "http://localhost/dev-files"), config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: "correct horse battery" } });
    op.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    op.csrf = JSON.parse(res.body).csrfToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("the desk handle learns the story's names and the typed tag becomes a rule", async () => {
    const res = await app.inject({ method: "POST", url: `/drafts/${draftId}/copy-posted`, payload: { version: 1 }, headers: { cookie: op.cookie, "x-csrf": op.csrf } });
    expect(res.statusCode).toBe(200);
    const [row] = await h.db.select().from(handleDirectory).where(eq(handleDirectory.handle, "ChaksuNews"));
    expect(row!.aliases).toEqual(["Jaipur", "जयपुर", "चाकसू"]);
    const [rule] = await h.db.select().from(hashtagRules).where(eq(hashtagRules.hashtagLatin, "Jaisalmer"));
    expect(rule).toMatchObject({ matchType: "entity", name: "Jaisalmer", aliases: ["जैसलमेर"], active: true });
    const actions = (await h.db.select({ action: auditLog.action }).from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["handle.keywords_learned", "hashtag.rule_learned", "hashtag.staged", "draft.copy_posted"]));
  });
});
