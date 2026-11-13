// Edit on Posted today (correcting a posted story): POST /drafts/:id/correction and /correction/done, edits and card
// uploads under the hold, the posted view's canCorrect / corrected, and counts that never move. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { istDayStart } from "@socia/core";
import { auditLog, createDb, hashtagStaging, orgs, postDecisions, postDrafts, publishedPosts, runMigrations, stories, userPermissionOverrides, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL_ = process.env.TEST_DATABASE_URL;

/** A PNG signature and IHDR chunk: all the API reads. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, ihdr])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, type, ihdr, crc]);
}

type Session = { cookie: string; csrf: string };

(URL_ ? describe : describe.skip)("Edit on Posted today", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  const who: Record<"op" | "plain" | "undoer" | "admin" | "viewer", Session> = {
    op: { cookie: "", csrf: "" }, plain: { cookie: "", csrf: "" }, undoer: { cookie: "", csrf: "" }, admin: { cookie: "", csrf: "" }, viewer: { cookie: "", csrf: "" },
  };
  const uid: Record<string, string> = {};

  const base: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 5).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(s: Session, method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  async function upload(s: Session, id: string, version: number) {
    const res = await app.inject({ method: "PUT", url: `/drafts/${id}/card?version=${version}`, payload: png(1080, 1080), headers: { cookie: s.cookie, "x-csrf": s.csrf, "content-type": "image/png" } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  async function signIn(s: Session, email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }

  /** A breaking draft (handle_pick set) posted with Copy & Posted by Op */
  async function postedDraft(key: string) {
    const [s] = await h.db.insert(stories).values({ orgId, slug: key, status: "composed", headline: key, body: "", layout: "breaking", mediaState: "none", district: "Jaipur" }).returning();
    const [d] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: s!.id, status: "ready", bodyText: `#Jaipur: ${key}`, cardHeadline: key, hashtags: ["#RajasthanWithFirstIndia", "#Desk"], composeVersion: "b1", cardRev: 0,
        handlePick: { cls: "other", why: "", warnings: [], handles: [] },
      })
      .returning();
    const res = await call(who.op, "POST", `/drafts/${d!.id}/copy-posted`, { version: d!.version });
    expect(res.status).toBe(200);
    return d!.id;
  }

  const draftRow = async (id: string) => (await h.db.select().from(postDrafts).where(eq(postDrafts.id, id)))[0]!;
  const postRows = async (id: string) => h.db.select().from(publishedPosts).where(eq(publishedPosts.draftId, id));
  const postedItem = async (s: Session, id: string) => (await call(s, "GET", "/x/queue?view=posted")).body.items.find((i: { id: string }) => i.id === id);

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
    const rows = await h.db
      .insert(users)
      .values([
        { orgId, name: "Op", email: "op@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Plain", email: "plain@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Undoer", email: "undoer@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Admin", email: "admin@test", passwordHash: pw, role: "admin" },
        { orgId, name: "Viewer", email: "viewer@test", passwordHash: pw, role: "viewer" },
      ])
      .returning();
    for (const u of rows) uid[u.name] = u.id;
    // A plain editor: Edit drafts, but not Undo (operators have Undo by default). The admin is allowed as an
    // admin even without Undo.
    await h.db.insert(userPermissionOverrides).values([
      { userId: uid["Plain"]!, permission: "post.undo", allowed: false },
      { userId: uid["Admin"]!, permission: "post.undo", allowed: false },
    ]);

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-correction-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config: { ...base, phase: 1 } }, false);
    await signIn(who.op, "op@test");
    await signIn(who.plain, "plain@test");
    await signIn(who.undoer, "undoer@test");
    await signIn(who.admin, "admin@test");
    await signIn(who.viewer, "viewer@test");
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("the poster corrects text and card; it stays published and in Posted today, and no count moves", async () => {
    const id = await postedDraft("galat-khabar");
    const before = await draftRow(id);
    const counts = (await call(who.op, "GET", "/x/counts")).body;
    const facets = (await call(who.op, "GET", "/x/queue/facets?view=posted")).body;
    const staged = await h.db.select().from(hashtagStaging);
    const [decision] = await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, id));

    // The row offers Edit to the poster only (and to those who may act on others' posts)
    expect(await postedItem(who.op, id)).toMatchObject({ status: "published", canCorrect: true, corrected: null, claim: null });
    expect((await postedItem(who.plain, id)).canCorrect).toBe(false);
    expect((await postedItem(who.undoer, id)).canCorrect).toBe(true);
    expect((await postedItem(who.admin, id)).canCorrect).toBe(true);
    // The draft view says the same, for the user asking
    expect((await call(who.op, "GET", `/drafts/${id}`)).body.canCorrect).toBe(true);
    expect((await call(who.plain, "GET", `/drafts/${id}`)).body.canCorrect).toBe(false);
    expect((await call(who.viewer, "GET", `/drafts/${id}`)).body.canCorrect).toBe(false);
    expect((await call(who.op, "GET", "/x/queue")).body.items.every((i: { canCorrect: boolean; corrected: unknown }) => !i.canCorrect && i.corrected === null)).toBe(true);

    const start = await call(who.op, "POST", `/drafts/${id}/correction`);
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({
      status: "published", claim: { userId: uid["Op"], name: "Op", mine: true },
      correction: { postedBy: { id: uid["Op"], name: "Op" }, correctedAt: null, correctedBy: null },
    });
    expect(Date.parse(start.body.correction.postedAt)).toBeGreaterThan(0);
    // Others see the hold on the posted row
    expect((await postedItem(who.undoer, id)).claim).toMatchObject({ name: "Op", mine: false });

    const beat = await call(who.op, "POST", `/drafts/${id}/heartbeat`);
    expect(beat.status).toBe(200);
    expect((await draftRow(id)).status).toBe("published");

    const patched = await call(who.op, "PATCH", `/drafts/${id}`, { version: before.version, bodyText: "#Jaipur: sahi khabar", hashtags: ["#RajasthanWithFirstIndia", "#Desk", "#NewTag"] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ status: "published", postText: "#Jaipur: sahi khabar\n\n#RajasthanWithFirstIndia #Desk #NewTag", correction: { correctedBy: { id: uid["Op"], name: "Op" } } });

    const card = await upload(who.op, id, patched.body.version);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ status: "published", card: { custom: true } });

    const [post] = await postRows(id);
    expect(post).toMatchObject({ text: "#Jaipur: sahi khabar\n\n#RajasthanWithFirstIndia #Desk #NewTag", correctedBy: uid["Op"], cardKey: expect.stringMatching(/custom-.*\.png$/) });
    expect(post!.correctedAt).toBeInstanceOf(Date);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "draft.correct_posted")));
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => (a.after as { text?: string }).text)).toMatchObject({ before: { bodyText: "#Jaipur: galat-khabar" }, after: { bodyText: "#Jaipur: sahi khabar" } });

    const done = await call(who.op, "POST", `/drafts/${id}/correction/done`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "published", claim: null });

    // Still in Posted today, in the same place, showing the corrected record
    const item = await postedItem(who.op, id);
    expect(item).toMatchObject({
      status: "published", canCorrect: true, claim: null,
      corrected: { at: expect.any(String), by: { id: uid["Op"], name: "Op" } },
      posted: { text: post!.text, by: { name: "Op" }, corrected: { by: { name: "Op" } } },
    });
    expect((await draftRow(id)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await postRows(id)).toHaveLength(1);
    expect((await call(who.op, "GET", "/x/counts")).body).toEqual(counts);
    expect((await call(who.op, "GET", "/x/queue/facets?view=posted")).body).toEqual(facets);
    // No new staging (#NewTag was added under the correction) and the decision log is as it was
    expect(await h.db.select().from(hashtagStaging)).toEqual(staged);
    const [decisionNow] = await h.db.select().from(postDecisions).where(eq(postDecisions.draftId, id));
    expect(decisionNow).toEqual(decision);
  });

  it("a plain editor gets 403; Undo holders and admins may; someone else's hold is 409", async () => {
    const id = await postedDraft("doosre-ki");
    expect(await call(who.plain, "POST", `/drafts/${id}/correction`)).toMatchObject({
      status: 403, body: { error: "forbidden", message: "Only the person who posted it or an admin can edit a posted story." },
    });
    expect((await call(who.undoer, "POST", `/drafts/${id}/correction`)).status).toBe(200);
    expect(await call(who.admin, "POST", `/drafts/${id}/correction`)).toMatchObject({ status: 409, body: { error: "held_by_other", heldBy: "Undoer", message: "Undoer is working on this." } });
    // The holder's release keeps it published and frees it
    expect((await call(who.undoer, "POST", `/drafts/${id}/release`)).status).toBe(200);
    expect(await draftRow(id)).toMatchObject({ status: "published", claimedBy: null });
    const admin = await call(who.admin, "POST", `/drafts/${id}/correction`);
    expect(admin).toMatchObject({ status: 200, body: { status: "published", claim: { mine: true, name: "Admin" } } });
    const patched = await call(who.admin, "PATCH", `/drafts/${id}`, { version: admin.body.version, bodyText: "#Jaipur: admin ne theek kiya" });
    expect(patched.status).toBe(200);
    expect((await postRows(id))[0]).toMatchObject({ publishedBy: uid["Op"], correctedBy: uid["Admin"] });
    expect((await call(who.admin, "POST", `/drafts/${id}/correction/done`)).body.status).toBe("published");
  });

  it("yesterday's post is too late, and its row offers no Edit", async () => {
    const id = await postedDraft("kal-ki");
    await h.db.update(publishedPosts).set({ publishedAt: new Date(istDayStart(new Date()).getTime() - 60_000) }).where(eq(publishedPosts.draftId, id));
    expect(await call(who.op, "POST", `/drafts/${id}/correction`)).toMatchObject({ status: 409, body: { error: "too_late", message: "Only today's posts can be edited." } });
    expect((await postedItem(who.op, id)).canCorrect).toBe(false);
  });

  it("only a Copy & Posted story: a draft in the queue is invalid_state, and an edit without the hold is refused", async () => {
    const [s] = await h.db.insert(stories).values({ orgId, slug: "queue", status: "composed", headline: "queue", body: "", layout: "breaking", mediaState: "none" }).returning();
    const [d] = await h.db.insert(postDrafts).values({ orgId, storyId: s!.id, status: "ready", bodyText: "x", cardHeadline: "x", hashtags: [], composeVersion: "b1", cardRev: 0 }).returning();
    expect(await call(who.op, "POST", `/drafts/${d!.id}/correction`)).toMatchObject({ status: 409, body: { error: "invalid_state" } });
    expect((await call(who.op, "POST", `/drafts/${d!.id}/correction/done`)).body.error).toBe("invalid_state");

    const id = await postedDraft("bina-hold");
    const v = (await draftRow(id)).version;
    expect((await call(who.op, "PATCH", `/drafts/${id}`, { version: v, bodyText: "x" })).body.error).toBe("lease_lost");
    expect((await upload(who.op, id, v)).body.error).toBe("lease_lost");
    expect((await call(who.op, "POST", `/drafts/${id}/heartbeat`)).body.error).toBe("lease_lost");
  });

  it("rules are re-checked on every save and on Done; Done needs Edit drafts; undo waits for the fixer; 404 for a missing story", async () => {
    const id = await postedDraft("phir-se-jaanch");
    const start = await call(who.undoer, "POST", `/drafts/${id}/correction`);
    expect(start.body.canCorrect).toBe(true);
    // The poster cannot take it back while Undoer fixes it
    expect(await call(who.op, "POST", `/drafts/${id}/copy-posted/undo`)).toMatchObject({ status: 409, body: { error: "held_by_other", message: "Undoer is fixing this post. Undo after they finish." } });
    // An empty post or one over 1000 is not saved; 300 characters is fine
    expect(await call(who.undoer, "PATCH", `/drafts/${id}`, { version: start.body.version, bodyText: "", hashtags: [] })).toMatchObject({ status: 422, body: { error: "post_invalid" } });
    expect((await call(who.undoer, "PATCH", `/drafts/${id}`, { version: start.body.version, bodyText: "क".repeat(300) })).status).toBe(200);

    // Undo and Edit drafts taken away mid-hold: the next save and card change are refused at once
    await h.db.insert(userPermissionOverrides).values([
      { userId: uid["Undoer"]!, permission: "post.undo", allowed: false },
      { userId: uid["Undoer"]!, permission: "draft.edit", allowed: false },
    ]);
    const v = (await draftRow(id)).version;
    expect(await call(who.undoer, "PATCH", `/drafts/${id}`, { version: v, bodyText: "#Jaipur: x" })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect((await upload(who.undoer, id, v)).body.error).toBe("forbidden");
    expect((await call(who.undoer, "GET", `/drafts/${id}`)).body.canCorrect).toBe(false);
    // ...but their Done still lets go of the hold. A closed tab's keepalive: no body, no content-type, cookie + x-csrf
    const keepalive = await app.inject({ method: "POST", url: `/drafts/${id}/correction/done`, headers: { cookie: who.undoer.cookie, "x-csrf": who.undoer.csrf } });
    expect(keepalive.statusCode).toBe(200);
    expect(JSON.parse(keepalive.body)).toMatchObject({ status: "published", claim: null });
    expect(await draftRow(id)).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null });
    const ended = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "draft.correction_ended")));
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ after: { rulesFailed: "forbidden" } });
    await h.db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, uid["Undoer"]!));

    // Someone not holding it needs Edit drafts to call Done (and then nothing changes)
    expect(await call(who.viewer, "POST", `/drafts/${id}/correction/done`)).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(await call(who.undoer, "POST", `/drafts/${id}/correction/done`)).toMatchObject({ status: 200, body: { status: "published", claim: null } });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "draft.correction_ended")))).toHaveLength(1);

    // Across midnight: the save is too late
    expect((await call(who.op, "POST", `/drafts/${id}/correction`)).status).toBe(200);
    await h.db.update(publishedPosts).set({ publishedAt: new Date(istDayStart(new Date()).getTime() - 60_000) }).where(eq(publishedPosts.draftId, id));
    expect(await call(who.op, "PATCH", `/drafts/${id}`, { version: (await draftRow(id)).version, bodyText: "#Jaipur: late" })).toMatchObject({
      status: 409, body: { error: "too_late", message: "This post is from yesterday and can't be edited." },
    });

    // An expired hold is cleared when the draft is read
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() - interval '1 second'` }).where(eq(postDrafts.id, id));
    expect((await call(who.op, "GET", `/drafts/${id}`)).body).toMatchObject({ status: "published", claim: null });
    expect(await draftRow(id)).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null });

    const missing = crypto.randomUUID();
    expect(await call(who.op, "POST", `/drafts/${missing}/correction`)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await call(who.op, "POST", `/drafts/${missing}/correction/done`)).toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});
