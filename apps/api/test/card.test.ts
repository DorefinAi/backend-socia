// The X desk's own card and hand-posted posts: upload an edited PNG, go back to the rendered card,
// approve while the rendered card redraws, and record a post made by hand on X. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { auditLog, createDb, orgs, postDrafts, publishedPosts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL = process.env.TEST_DATABASE_URL;

/** A PNG signature and IHDR chunk: all the API reads. */
function png(width: number, height: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, ihdr])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, type, ihdr, crc, Buffer.alloc(pad)]);
}

(URL ? describe : describe.skip)("custom card and mark-posted", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: LocalStorage;
  let orgId = "";
  let draftA = "";
  let draftB = "";
  const op = { cookie: "", csrf: "" };
  const other = { cookie: "", csrf: "" };

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 5).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(who: { cookie: string; csrf: string }, method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers: { cookie: who.cookie, "x-csrf": who.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function upload(who: { cookie: string; csrf: string }, id: string, version: number, body: Buffer, type = "image/png") {
    const res = await app.inject({ method: "PUT", url: `/drafts/${id}/card?version=${version}`, payload: body, headers: { cookie: who.cookie, "x-csrf": who.csrf, "content-type": type } });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function login(email: string, into: { cookie: string; csrf: string }) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    into.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    into.csrf = JSON.parse(res.body).csrfToken;
  }

  const auditFor = (id: string, action: string) =>
    h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const passwordHash = await hashPassword("correct horse battery");
    await h.db.insert(users).values([
      { orgId, name: "Op", email: "op@test", passwordHash, role: "operator" },
      { orgId, name: "Other", email: "other@test", passwordHash, role: "operator" },
    ]);
    store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-card-")), "http://localhost/dev-files");
    await store.put("cards/auto.png", png(1200, 675), "image/png");

    const ids: string[] = [];
    for (const slug of ["a", "b"]) {
      const [s] = await h.db.insert(stories).values({ orgId, slug, status: "composed", headline: `खबर ${slug}`, body: "" }).returning();
      const [d] = await h.db
        .insert(postDrafts)
        .values({ orgId, storyId: s!.id, status: "ready", bodyText: `खबर ${slug}`, cardHeadline: `खबर ${slug}`, hashtags: ["#Jaipur"], composeVersion: "t", cardRenderedRev: 1, cardKey: "cards/auto.png" })
        .returning();
      ids.push(d!.id);
    }
    [draftA, draftB] = ids as [string, string];

    app = await buildApp({ db: h.db, storage: store, config }, false);
    await login("op@test", op);
    await login("other@test", other);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("stores an edited card and refuses bad uploads", async () => {
    const claimed = await call(op, "POST", `/drafts/${draftA}/claim`);
    expect(claimed.body.card).toMatchObject({ custom: false, ready: true, url: "http://localhost/dev-files/cards/auto.png", autoUrl: "http://localhost/dev-files/cards/auto.png" });
    const v = claimed.body.version as number;

    // refusals first; none of them changes the draft
    expect(await upload(op, draftA, v, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toMatchObject({ status: 415, body: { error: "unsupported_type" } });
    expect(await upload(op, draftA, v, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]))).toMatchObject({ status: 415, body: { error: "unsupported_type" } });
    expect(await upload(op, draftA, v, png(1200, 675, 5 * 1024 * 1024))).toMatchObject({ status: 413, body: { error: "too_large" } });
    expect(await upload(op, draftA, v, png(200, 675))).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(await upload(op, draftA, v, png(1200, 5000))).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(await upload(other, draftA, v, png(1200, 675))).toMatchObject({ status: 409, body: { error: "lease_lost" } });
    const stale = await upload(op, draftA, v - 1, png(1200, 675));
    expect(stale).toMatchObject({ status: 409, body: { error: "stale_version", current: { id: draftA, version: v } } });
    const noCsrf = await app.inject({ method: "PUT", url: `/drafts/${draftA}/card?version=${v}`, payload: png(1200, 675), headers: { cookie: op.cookie, "content-type": "image/png" } });
    expect(JSON.parse(noCsrf.body).error).toBe("csrf");

    const file = png(1200, 675, 100);
    const up = await upload(op, draftA, v, file);
    expect(up.status).toBe(200);
    expect(up.body.version).toBe(v + 1);
    expect(up.body.card).toMatchObject({ custom: true, ready: true, autoUrl: "http://localhost/dev-files/cards/auto.png" });
    expect(up.body.card.url).not.toBe(up.body.card.autoUrl);
    expect(up.body.card.url).toMatch(new RegExp(`/cards/${draftA}/custom-[0-9a-f-]{36}\\.png$`));

    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, draftA));
    expect((await store.get(row!.customCardKey!)).equals(file)).toBe(true);
    const [a] = await auditFor(draftA, "draft.card_uploaded");
    expect(a!.after).toEqual({ key: row!.customCardKey, bytes: file.length, width: 1200, height: 675 });
    expect(a!.actorId).not.toBeNull();
  });

  it("goes back to the rendered card", async () => {
    const before = (await call(op, "GET", `/drafts/${draftA}`)).body;
    expect((await call(op, "DELETE", `/drafts/${draftA}/card?version=${before.version - 1}`)).body.error).toBe("stale_version");
    const reset = await call(op, "DELETE", `/drafts/${draftA}/card?version=${before.version}`);
    expect(reset.status).toBe(200);
    expect(reset.body.version).toBe(before.version + 1);
    expect(reset.body.card).toMatchObject({ custom: false, url: "http://localhost/dev-files/cards/auto.png", autoUrl: "http://localhost/dev-files/cards/auto.png" });
    expect(await auditFor(draftA, "draft.card_reset")).toHaveLength(1);
  });

  it("approves with a custom card while the rendered card redraws, and keeps it through edit and undo", async () => {
    let d = (await call(op, "GET", `/drafts/${draftA}`)).body;
    d = (await upload(op, draftA, d.version, png(1080, 1080))).body;
    const customUrl = d.card.url;

    // a headline edit re-renders the automatic card but does not drop the custom one
    d = (await call(op, "PATCH", `/drafts/${draftA}`, { version: d.version, cardHeadline: "नई हेडलाइन" })).body;
    expect(d.card).toMatchObject({ custom: true, ready: true, url: customUrl });
    const [row] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, draftA));
    expect(row!.cardRev).toBeGreaterThan(row!.cardRenderedRev);

    const approved = await call(op, "POST", `/drafts/${draftA}/approve`, { version: d.version });
    expect(approved.status).toBe(200);
    // queued: the card is fixed now
    const queued = (await call(op, "GET", `/drafts/${draftA}`)).body;
    expect(await upload(op, draftA, queued.version, png(1080, 1080))).toMatchObject({ status: 409, body: { error: "invalid_state", status: "queued" } });
    const undone = await call(op, "POST", `/jobs/${approved.body.jobId}/undo`);
    expect(undone.body).toMatchObject({ status: "claimed", card: { custom: true, url: customUrl } });

    // without a custom card the same draft must wait for the render
    const reset = await call(op, "DELETE", `/drafts/${draftA}/card?version=${undone.body.version}`);
    expect(reset.body.card.ready).toBe(false);
    expect((await call(op, "POST", `/drafts/${draftA}/approve`, { version: reset.body.version })).body.error).toBe("card_not_ready");
    // custom card back on for the next test
    const put = await upload(op, draftA, reset.body.version, png(1080, 1080));
    expect(put.status).toBe(200);
  });

  it("records a post made by hand on X", async () => {
    const d = (await call(op, "GET", `/drafts/${draftA}`)).body;
    const customKey = (await h.db.select().from(postDrafts).where(eq(postDrafts.id, draftA)))[0]!.customCardKey;

    for (const bad of ["https://x.com/someone", "http://x.com/a/status/1234567", "https://evil.com/a/status/1234567", "https://x.com/a/status/12345abc"]) {
      expect((await call(op, "POST", `/drafts/${draftA}/mark-posted`, { version: d.version, permalink: bad })).body.error).toBe("invalid");
    }
    expect((await call(other, "POST", `/drafts/${draftA}/mark-posted`, { version: d.version, permalink: "https://x.com/1stIndiaNews/status/1850000000000000001" })).body.error).toBe("lease_lost");

    const done = await call(op, "POST", `/drafts/${draftA}/mark-posted`, { version: d.version, permalink: "https://twitter.com/1stIndiaNews/status/1850000000000000001?s=20" });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ postId: expect.any(String), permalink: "https://twitter.com/1stIndiaNews/status/1850000000000000001?s=20" });

    const after = (await call(op, "GET", `/drafts/${draftA}`)).body;
    expect(after).toMatchObject({ status: "published", version: d.version + 1, claim: null });
    const [post] = await h.db.select().from(publishedPosts).where(eq(publishedPosts.id, done.body.postId));
    expect(post).toMatchObject({ platformPostId: "1850000000000000001", manual: true, cardKey: customKey, text: "खबर a\n\n#Jaipur" });

    const posts = (await call(op, "GET", "/posts")).body.items;
    expect(posts[0]).toMatchObject({ id: done.body.postId, manual: true, cardUrl: `http://localhost/dev-files/${customKey}`, publishedBy: "Op" });
    expect((await call(op, "GET", "/x/counts")).body.publishedToday).toBe(1);
    const [a] = await auditFor(draftA, "draft.mark_posted");
    expect(a!.after).toEqual({ permalink: "https://twitter.com/1stIndiaNews/status/1850000000000000001?s=20", cardKey: customKey });

    // the same X post cannot be recorded twice, from any draft
    const b = (await call(op, "POST", `/drafts/${draftB}/claim`)).body;
    const dup = await call(op, "POST", `/drafts/${draftB}/mark-posted`, { version: b.version, permalink: "https://x.com/1stIndiaNews/status/1850000000000000001" });
    expect(dup).toMatchObject({ status: 409, body: { error: "duplicate_post" } });
    expect((await call(op, "GET", `/drafts/${draftB}`)).body).toMatchObject({ status: "claimed", version: b.version });

    // only a claimed draft can be marked posted
    expect((await call(op, "POST", `/drafts/${draftA}/mark-posted`, { version: after.version, permalink: "https://x.com/a/status/1850000000000000002" })).body.error).toBe("lease_lost");
  });
});
