// Phase 1 API (handoff/phase1-contract.md): the phase on /me, queue filters, the posted view and facets,
// Copy & Posted with its undo window, "Add card", X API routes refused, source health. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileTags } from "@socia/core";
import { createDb, orgs, postDrafts, publishedPosts, recordIngestPoll, runMigrations, stories, userPermissionOverrides, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL_ = process.env.TEST_DATABASE_URL;

const tags = (over: Partial<FileTags>): FileTags => ({
  districtCode: null, district: null, big: false, full: false, update: false, exclusive: false, photo: false, web: false, tv: false,
  desk: null, reporter: null, date: null, other: [], ...over,
});

(URL_ ? describe : describe.skip)("phase 1 API", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let app2: Awaited<ReturnType<typeof buildApp>>;
  const session = { cookie: "", csrf: "" };
  const session2 = { cookie: "", csrf: "" };
  let orgId = "";
  const ids: Record<string, string> = {};

  const base: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 3).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(method: string, url: string, payload?: unknown, s = session, a = app) {
    const res = await a.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function signIn(a: typeof app, s: typeof session, email: string) {
    const res = await a.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }

  async function draft(key: string, story: Partial<typeof stories.$inferInsert>, d: Partial<typeof postDrafts.$inferInsert> = {}) {
    const [s] = await h.db.insert(stories).values({ orgId, slug: key, status: "composed", headline: key, body: "", layout: "breaking", mediaState: "none", ...story }).returning();
    const [row] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: s!.id, status: "ready", bodyText: `#${story.district ?? "X"}: ${key}`, cardHeadline: key, hashtags: ["#RajasthanWithFirstIndia"], composeVersion: "b1", cardRev: 0, ...d })
      .returning();
    ids[key] = row!.id;
  }

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const pw = await hashPassword("correct horse battery");
    await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash: pw, role: "operator" },
      { orgId, name: "Op Two", email: "op2@test", passwordHash: pw, role: "operator" },
      { orgId, name: "Admin", email: "admin@test", passwordHash: pw, role: "admin" },
    ]);

    await draft("jodhpur-big", { district: "Jodhpur", town: "पीपाड़", fileTags: tags({ big: true, desk: "NDR", reporter: "REPORTER" }), deskNote: "नोट-: फुलस्क्रीन करावें", needsCheck: ["desk_note"] });
    await draft("jaipur-update", { district: "Jaipur", fileTags: tags({ update: true, desk: "VKS" }) });
    await draft("no-district", { district: null, fileTags: tags({ desk: "VKS" }), needsCheck: ["no_district"] });
    await draft("too-long", { district: "Kota", fileTags: tags({}) }, { bodyText: "क".repeat(300) });

    await recordIngestPoll(h.db, orgId, {
      mode: "folder", taken: 1, cursor: null,
      source: { kind: "breaking", reachable: true, expectedFolder: "30_OCTOBER_2026", todayFolder: "OCTOBER_2026/30_OCTOBER_2026", alsoScanning: null, filesToday: 4, lastFileAt: new Date().toISOString(), lastFileName: "BTN_RAJ_BREAKING_1_30OCT.txt", checkedAt: new Date().toISOString(), lastError: null },
    });

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-p1api-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config: { ...base, phase: 1 } }, false);
    app2 = await buildApp({ db: h.db, storage: store, config: base }, false);
    await signIn(app, session, "op@test");
    await signIn(app2, session2, "op2@test");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await app2?.close();
    await h?.close();
  });

  it("tells the desk the phase and what is on", async () => {
    expect((await call("GET", "/me")).body).toMatchObject({ phase: 1, features: { xApiPosting: false, copyPosted: true, cardOnDemand: true, samvadia: false, webScraper: true, platforms: ["x"] } });
    expect((await call("GET", "/me", undefined, session2, app2)).body).toMatchObject({ phase: 2, features: { xApiPosting: true, cardOnDemand: false } });
  });

  it("queue items carry the breaking fields and the text to copy", async () => {
    const { body } = await call("GET", "/x/queue?district=Jodhpur");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: ids["jodhpur-big"], district: "Jodhpur", town: "पीपाड़", desk: "NDR", reporter: "REPORTER", deskNoteRemoved: true, needsCheck: ["desk_note"],
      tags: { big: true }, postText: "#Jodhpur: jodhpur-big\n\n#RajasthanWithFirstIndia", length: 47, card: { state: "none" }, posted: null,
    });
  });

  it("filters by district, BIG, UPDATE, desk and needs-check, and counts for the dropdowns", async () => {
    const names = async (q: string) => (await call("GET", `/x/queue?${q}`)).body.items.map((i: { headline: string }) => i.headline).sort();
    expect(await names("big=true")).toEqual(["jodhpur-big"]);
    expect(await names("update=true")).toEqual(["jaipur-update"]);
    expect(await names("desk=vks")).toEqual(["jaipur-update", "no-district"]);
    expect(await names("district=none")).toEqual(["no-district"]);
    expect(await names("needsCheck=true")).toEqual(["jodhpur-big", "no-district"]);
    expect(await names("desk=VKS&update=false")).toEqual(["no-district"]);
    expect((await call("GET", "/x/queue?desk=no%20way")).status).toBe(400);

    const { body } = await call("GET", "/x/queue/facets");
    expect(body).toMatchObject({ total: 4, big: 1, update: 1, needsCheck: 2 });
    expect(body.desks).toEqual(expect.arrayContaining([{ code: "VKS", n: 2 }, { code: "NDR", n: 1 }]));
    expect(body.districts).toEqual(expect.arrayContaining([{ name: null, n: 1 }, { name: "Jodhpur", n: 1 }]));
  });

  it("Copy & Posted records who and when, shows in the posted view and /posts, and can be undone", async () => {
    const id = ids["jaipur-update"]!;
    expect((await call("POST", `/drafts/${id}/copy-posted`, { version: 99 })).body.error).toBe("stale_version");
    const done = await call("POST", `/drafts/${id}/copy-posted`, { version: 1 });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ draftId: id, text: "#Jaipur: jaipur-update\n\n#RajasthanWithFirstIndia", postedBy: { name: "Op" } });
    expect(Date.parse(done.body.undoUntil) - Date.parse(done.body.postedAt)).toBe(5 * 60 * 1000);

    const posted = await call("GET", "/x/queue?view=posted");
    expect(posted.body.items).toHaveLength(1);
    expect(posted.body.items[0]).toMatchObject({ id, status: "published", posted: { by: { name: "Op" } } });
    const posts = await call("GET", "/posts");
    expect(posts.body.items[0]).toMatchObject({ draftId: id, permalink: null, copied: true, manual: true, publishedBy: "Op" });
    expect((await call("GET", `/drafts/${id}`)).body.posted).toMatchObject({ by: { name: "Op" } });

    // Pasted by hand, so Socia cannot recall it; in phase 1 the X API routes are off anyway
    expect((await call("POST", `/posts/${done.body.postId}/recall`, { reason: "wrong" }, session2, app2)).body.error).toBe("invalid_state");
    expect((await call("POST", `/posts/${done.body.postId}/recall`, { reason: "wrong" })).body.error).toBe("phase_off");

    const undo = await call("POST", `/drafts/${id}/copy-posted/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ status: "ready", posted: null });
    expect(await h.db.select().from(publishedPosts)).toHaveLength(0);
    expect((await call("POST", `/drafts/${id}/copy-posted/undo`)).body.error).toBe("invalid_state");
  });

  it("refuses after the undo window, an over-long post, and a draft someone else holds", async () => {
    const id = ids["jodhpur-big"]!;
    const done = await call("POST", `/drafts/${id}/copy-posted`, { version: 1 });
    await h.db.update(publishedPosts).set({ publishedAt: sql`now() - interval '6 minutes'` }).where(eq(publishedPosts.id, done.body.postId));
    expect((await call("POST", `/drafts/${id}/copy-posted/undo`)).body.error).toBe("too_late");

    expect((await call("POST", `/drafts/${ids["too-long"]}/copy-posted`, { version: 1 })).body).toMatchObject({ error: "post_invalid", problems: [expect.stringContaining("over")] });

    const held = ids["no-district"]!;
    expect((await call("POST", `/drafts/${held}/claim`, undefined, session2, app2)).status).toBe(200);
    expect((await call("POST", `/drafts/${held}/copy-posted`, { version: 1 })).body).toMatchObject({ error: "held_by_other", heldBy: "Op Two" });
  });

  it("Add card asks the render worker for a card, once", async () => {
    const id = ids["too-long"]!;
    const res = await call("POST", `/drafts/${id}/card/render`);
    expect(res.status).toBe(202);
    expect(res.body.card).toMatchObject({ state: "rendering", requested: true, url: null });
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, id));
    expect([row!.cardRev, row!.cardRenderedRev]).toEqual([1, 0]);
    await call("POST", `/drafts/${id}/card/render`);
    const [again] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, id));
    expect(again!.cardRev).toBe(1);
  });

  it("refuses the X API routes in phase 1 only", async () => {
    const id = ids["too-long"]!;
    expect((await call("POST", `/drafts/${id}/approve`, { version: 1 })).body).toMatchObject({ error: "phase_off" });
    expect((await call("POST", `/drafts/${id}/retry`)).body).toMatchObject({ error: "phase_off" });
    expect((await call("POST", `/drafts/${id}/approve`, { version: 1 }, session2, app2)).body.error).not.toBe("phase_off");
  });

  it("reports the share's health with the phase; paths and file names only with the Settings permission", async () => {
    const { body } = await call("GET", "/ingest/status");
    expect(body).toMatchObject({
      phase: 1, state: "ok", mode: "folder", recentErrors: [],
      source: { kind: "breaking", reachable: true, todayFolderFound: true, todayFolder: null, lastFileName: null, filesToday: 4, lastFileAgeSeconds: expect.any(Number) },
    });
    const admin = { cookie: "", csrf: "" };
    await signIn(app, admin, "admin@test");
    expect((await call("GET", "/ingest/status", undefined, admin)).body.source).toMatchObject({ todayFolder: "OCTOBER_2026/30_OCTOBER_2026", lastFileName: "BTN_RAJ_BREAKING_1_30OCT.txt" });

    // The share down: everyone sees the state, only Settings users the errno
    const health = { kind: "breaking" as const, reachable: false, expectedFolder: "30_OCTOBER_2026", todayFolder: null, alsoScanning: null, filesToday: 0, lastFileAt: null, lastFileName: null, checkedAt: new Date().toISOString(), lastError: { at: new Date().toISOString(), message: "The breaking-news share cannot be read (EIO).", code: "EIO" } };
    await recordIngestPoll(h.db, orgId, { mode: "folder", taken: 0, error: health.lastError.message, cursor: null, source: health, quietRepeats: true });
    const op = (await call("GET", "/ingest/status")).body;
    expect(op).toMatchObject({ state: "share_unreachable", lastError: { message: "The source could not be read." }, source: { reachable: false, lastError: { message: "The share cannot be read." } } });
    expect(JSON.stringify(op)).not.toContain("EIO");
    expect((await call("GET", "/ingest/status", undefined, admin)).body.source.lastError).toMatchObject({ code: "EIO" });
  });

  it("two people pressing Copy & Posted at once: one records it, the other is told who did", async () => {
    await draft("race", { district: "Ajmer", fileTags: tags({}) });
    const id = ids["race"]!;
    const [a, b] = await Promise.all([call("POST", `/drafts/${id}/copy-posted`, { version: 1 }), call("POST", `/drafts/${id}/copy-posted`, { version: 1 }, session2, app2)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? "Op" : "Op Two";
    expect(loser.body).toMatchObject({ error: "already_posted", postedBy: winner, postedAt: expect.any(String) });
    expect(await h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, id))).toHaveLength(1);
    // Even with the old version, a posted draft says "already posted", never "copy again"
    expect((await call("POST", `/drafts/${id}/copy-posted`, { version: 99 })).body.error).toBe("already_posted");
  });

  it("only the person who marked it, or someone with Undo, can take a Copy & Posted back", async () => {
    await draft("undo-other", { district: "Ajmer", fileTags: tags({}) });
    const id = ids["undo-other"]!;
    expect((await call("POST", `/drafts/${id}/copy-posted`, { version: 1 })).status).toBe(200);
    const [two] = await h.db.select().from(users).where(eq(users.email, "op2@test"));
    await h.db.insert(userPermissionOverrides).values({ userId: two!.id, permission: "post.undo", allowed: false });
    const res = await call("POST", `/drafts/${id}/copy-posted/undo`, undefined, session2, app2);
    expect(res).toMatchObject({ status: 403, body: { error: "forbidden" } });
    await h.db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, two!.id));
    expect((await call("POST", `/drafts/${id}/copy-posted/undo`, undefined, session2, app2)).status).toBe(200);
  });

  it("Add card waits ~30 s after a failed render (429) and keeps the attempt count", async () => {
    await draft("card-fail", { district: "Ajmer", fileTags: tags({}) });
    const id = ids["card-fail"]!;
    await h.db
      .update(postDrafts)
      .set({ cardRev: 1, cardRenderedRev: 0, renderError: "boom", renderAttempts: 3, renderLeaseUntil: sql`now() + interval '30 seconds'` })
      .where(eq(postDrafts.id, id));
    const res = await call("POST", `/drafts/${id}/card/render`);
    expect(res).toMatchObject({ status: 429, body: { error: "cooldown", retryAfter: expect.any(Number) } });
    await h.db.update(postDrafts).set({ renderLeaseUntil: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, id));
    expect((await call("POST", `/drafts/${id}/card/render`)).status).toBe(202);
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, id));
    expect([row!.renderError, row!.renderAttempts]).toEqual([null, 3]);
  });

  it("the posted view and its facets cover today (IST) unless asked for more days", async () => {
    const posted = (await call("GET", "/x/queue?view=posted")).body.items.map((i: { id: string }) => i.id);
    expect(posted).toContain(ids["race"]);
    await h.db.update(postDrafts).set({ updatedAt: sql`now() - interval '3 days'` }).where(eq(postDrafts.id, ids["race"]!));
    expect((await call("GET", "/x/queue?view=posted")).body.items.map((i: { id: string }) => i.id)).not.toContain(ids["race"]);
    expect((await call("GET", "/x/queue?view=posted&days=5")).body.items.map((i: { id: string }) => i.id)).toContain(ids["race"]);
    expect((await call("GET", "/x/queue?view=posted&days=31")).status).toBe(400);
    expect((await call("GET", "/x/queue/facets?view=posted")).body.total).toBe((await call("GET", "/x/queue?view=posted")).body.items.length);
  });
});
