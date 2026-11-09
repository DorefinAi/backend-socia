// Story links instead of draft ids: linkSlug / fileStem on queue items and the draft view, and
// GET /drafts/resolve?story=<linkSlug> → { id }. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storyLinkName } from "@socia/core";
import { createDb, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL_ = process.env.TEST_DATABASE_URL;
const DAY = 24 * 60 * 60 * 1000;
const HINDI = "जयपुर: SMS अस्पताल में नए ट्रॉमा वार्ड का लोकार्पण";

(URL_ ? describe : describe.skip)("story links", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let otherApp: Awaited<ReturnType<typeof buildApp>>;
  const session = { cookie: "", csrf: "" };
  const otherSession = { cookie: "", csrf: "" };
  let orgId = "";
  let otherOrgId = "";
  const ids: Record<string, string> = {};
  // Two hours ago, on a whole minute plus 10 s
  const T = new Date(Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 60_000) * 60_000 + 10_000);

  const base: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 3).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };
  const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

  async function call(url: string, s = session, a = app) {
    const res = await a.inject({ method: "GET", url, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function signIn(a: typeof app, s: typeof session, email: string) {
    const res = await a.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }

  async function draft(key: string, org: string, story: { district: string | null; headline: string; createdAt: Date }, status = "ready") {
    const [s] = await h.db.insert(stories).values({ orgId: org, slug: key, status: "composed", body: "", layout: "breaking", mediaState: "none", ...story }).returning();
    const [row] = await h.db
      .insert(postDrafts)
      .values({ orgId: org, storyId: s!.id, status, bodyText: key, cardHeadline: key, hashtags: [], composeVersion: "b1", cardRev: 0, ...(status === "rejected" && { rejectReason: "duplicate" }) })
      .returning();
    ids[key] = row!.id;
  }

  const nameOf = (story: { district: string | null; headline: string; createdAt: Date }) =>
    storyLinkName({ district: story.district, headline: story.headline, receivedAt: story.createdAt });

  const jaipur = { district: "Jaipur", headline: HINDI, createdAt: T };
  const jaipurYesterday = { district: "Jaipur", headline: HINDI, createdAt: new Date(T.getTime() - DAY) };
  const noDistrict = { district: null, headline: "Breaking: PM to visit Jodhpur on Friday", createdAt: T };
  const tooOld = { district: "Kota", headline: "कोटा में बारिश से हालात बिगड़े", createdAt: new Date(T.getTime() - 31 * DAY) };
  const otherOrgStory = { district: "Ajmer", headline: "दरगाह में उर्स शुरू", createdAt: T };

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db.insert(orgs).values({ name: "1st India", settings }).returning();
    const [other] = await h.db.insert(orgs).values({ name: "Other newsroom", settings }).returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    const pw = await hashPassword("correct horse battery");
    await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash: pw, role: "operator" },
      { orgId: otherOrgId, name: "Other Op", email: "other@test", passwordHash: pw, role: "operator" },
    ]);

    await draft("jaipur", orgId, jaipur);
    await draft("jaipur-yesterday", orgId, jaipurYesterday, "rejected");
    await draft("no-district", orgId, noDistrict);
    await draft("too-old", orgId, tooOld);
    await draft("other-org", otherOrgId, otherOrgStory);
    // The other org has the very same story, received seconds later: never ours
    await draft("other-org-same", otherOrgId, { ...jaipur, createdAt: new Date(T.getTime() + 20_000) });

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-storylink-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config: base }, false);
    otherApp = await buildApp({ db: h.db, storage: store, config: base }, false);
    await signIn(app, session, "op@test");
    await signIn(otherApp, otherSession, "other@test");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await otherApp?.close();
    await h?.close();
  });

  it("the example story's name", () => {
    const hhmm = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16).replace(":", "");
    expect(nameOf(jaipur).linkSlug).toBe(`jaipur-sms-aspatal-men-naye-trauma-vard-ka-lokarpan-${hhmm(T)}`);
    // Same story a day earlier: the same link name (resolve picks the newest)
    expect(nameOf(jaipurYesterday).linkSlug).toBe(nameOf(jaipur).linkSlug);
    expect(nameOf(jaipurYesterday).fileStem).not.toBe(nameOf(jaipur).fileStem);
  });

  it("queue items carry linkSlug and fileStem in every view", async () => {
    const inbox = (await call("/x/queue")).body.items as { id: string; linkSlug: string; fileStem: string }[];
    expect(inbox.find((i) => i.id === ids.jaipur)).toMatchObject(nameOf(jaipur));
    expect(inbox.find((i) => i.id === ids["no-district"])).toMatchObject({ linkSlug: expect.stringMatching(/^news-pm-to-visit-jodhpur-on-friday-\d{4}$/), fileStem: nameOf(noDistrict).fileStem });
    for (const i of inbox) {
      expect(i.linkSlug).toMatch(/^[a-z0-9-]{3,120}$/);
      expect(i.fileStem).toMatch(/^[A-Za-z0-9-]+$/);
    }
    const rejected = (await call("/x/queue?view=rejected")).body.items as { id: string }[];
    expect(rejected.find((i) => i.id === ids["jaipur-yesterday"])).toMatchObject(nameOf(jaipurYesterday));
  });

  it("the draft view carries them at the top level", async () => {
    const { status, body } = await call(`/drafts/${ids.jaipur}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: ids.jaipur, ...nameOf(jaipur) });
  });

  it("resolve finds the newest draft of the org with that name", async () => {
    expect(await call(`/drafts/resolve?story=${nameOf(jaipur).linkSlug}`)).toEqual({ status: 200, body: { id: ids.jaipur } });
    expect(await call(`/drafts/resolve?story=${nameOf(noDistrict).linkSlug}`)).toEqual({ status: 200, body: { id: ids["no-district"] } });
    // The other org gets its own copy of the same story, never ours
    expect(await call(`/drafts/resolve?story=${nameOf(jaipur).linkSlug}`, otherSession, otherApp)).toEqual({ status: 200, body: { id: ids["other-org-same"] } });
    // Once today's is gone, yesterday's (same name) is the newest
    await h.db.update(stories).set({ createdAt: new Date(T.getTime() - 40 * DAY) }).where(sql`${stories.slug} = 'jaipur' AND ${stories.orgId} = ${orgId}`);
    expect(await call(`/drafts/resolve?story=${nameOf(jaipur).linkSlug}`)).toEqual({ status: 200, body: { id: ids["jaipur-yesterday"] } });
    await h.db.update(stories).set({ createdAt: T }).where(sql`${stories.slug} = 'jaipur' AND ${stories.orgId} = ${orgId}`);
  });

  it("404 for another org's story, an unknown name or a story older than 30 days", async () => {
    const notFound = { status: 404, body: expect.objectContaining({ error: "not_found" }) };
    expect(await call(`/drafts/resolve?story=${nameOf(otherOrgStory).linkSlug}`)).toEqual(notFound);
    expect(await call(`/drafts/resolve?story=${nameOf(tooOld).linkSlug}`)).toEqual(notFound);
    expect(await call(`/drafts/resolve?story=${nameOf(jaipur).linkSlug.replace("sms", "smx")}`)).toEqual(notFound);
    expect(await call("/drafts/resolve?story=jaipur-sms-aspatal")).toEqual(notFound);
    expect(await call("/drafts/resolve?story=jaipur-2461")).toEqual(notFound);
    // The other org can resolve its own
    expect(await call(`/drafts/resolve?story=${nameOf(otherOrgStory).linkSlug}`, otherSession, otherApp)).toEqual({ status: 200, body: { id: ids["other-org"] } });
  });

  it("400 for a malformed name, 401 without a session", async () => {
    for (const bad of ["", "ab", "Jaipur-2241", "jaipur_2241", "jaipur%202241", "a".repeat(121), "%E0%A4%9C-2241"]) {
      const res = await call(`/drafts/resolve?story=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toBe("invalid");
    }
    expect((await call("/drafts/resolve")).status).toBe(400);
    const anon = await app.inject({ method: "GET", url: `/drafts/resolve?story=${nameOf(jaipur).linkSlug}` });
    expect(anon.statusCode).toBe(401);
  });
});
