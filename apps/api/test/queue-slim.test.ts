// GET /x/queue?fields=list (the New list's light rows), card link reuse, and ETag / 304 on the desk's polled reads
// (queue, facets, counts). The DB-backed part needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, orgs, postDrafts, publishedPosts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage, type Storage } from "@socia/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { etagMatches, weakEtag } from "../src/etag";
import { CARD_URL_CACHE_MAX, cardUrl } from "../src/views";

const URL_ = process.env.TEST_DATABASE_URL;

/** A storage that signs like S3: every mint is a new link */
function signingStorage() {
  let minted = 0;
  const storage: Storage = {
    put: async () => {},
    get: async () => Buffer.alloc(0),
    delete: async () => {},
    url: async (key, seconds) => `https://r2.test/${key}?expires=${seconds}&sig=${++minted}`,
  };
  return { storage, minted: () => minted };
}

describe("cardUrl", () => {
  it("hands out the same link for a key for 5 minutes, then mints a new 10-minute one", async () => {
    const { storage, minted } = signingStorage();
    const t0 = 1_000_000;
    const first = await cardUrl(storage, "cards/a/r1.jpg", t0);
    expect(first).toBe("https://r2.test/cards/a/r1.jpg?expires=600&sig=1");
    expect(await cardUrl(storage, "cards/a/r1.jpg", t0 + 299_999)).toBe(first);
    expect(minted()).toBe(1);
    // Another key gets its own link
    expect(await cardUrl(storage, "cards/b/r1.jpg", t0)).not.toBe(first);
    // 5 minutes on: a fresh link, kept for the next 5 minutes
    const second = await cardUrl(storage, "cards/a/r1.jpg", t0 + 300_000);
    expect(second).not.toBe(first);
    expect(await cardUrl(storage, "cards/a/r1.jpg", t0 + 400_000)).toBe(second);
    expect(minted()).toBe(3);
    expect(await cardUrl(storage, null, t0)).toBeNull();
  });

  it("keeps each storage's links apart and drops the oldest past the limit", async () => {
    const a = signingStorage();
    const b = signingStorage();
    const t0 = 2_000_000;
    await cardUrl(a.storage, "k", t0);
    await cardUrl(b.storage, "k", t0);
    // Each storage minted its own link for the same key
    expect([a.minted(), b.minted()]).toEqual([1, 1]);
    for (let i = 0; i < CARD_URL_CACHE_MAX; i++) await cardUrl(a.storage, `fill-${i}`, t0);
    const before = a.minted();
    // "k" was the oldest, so it was dropped and is minted again; the newest is still kept
    await cardUrl(a.storage, `fill-${CARD_URL_CACHE_MAX - 1}`, t0);
    expect(a.minted()).toBe(before);
    await cardUrl(a.storage, "k", t0);
    expect(a.minted()).toBe(before + 1);
  });

  it("local /dev-files links are the same every time", async () => {
    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-cardurl-")), "http://localhost/dev-files");
    expect(await cardUrl(store, "cards/x/r1.jpg")).toBe("http://localhost/dev-files/cards/x/r1.jpg");
    expect(await cardUrl(store, "cards/x/r1.jpg", Date.now() + 3_600_000)).toBe("http://localhost/dev-files/cards/x/r1.jpg");
  });
});

describe("etagMatches", () => {
  const tag = weakEtag("{\"a\":1}");
  it("compares weakly, in a list, and takes *", () => {
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(etagMatches(tag, tag)).toBe(true);
    expect(etagMatches(tag.slice(2), tag)).toBe(true);
    expect(etagMatches(`W/"other", ${tag}`, tag)).toBe(true);
    expect(etagMatches("*", tag)).toBe(true);
    expect(etagMatches(undefined, tag)).toBe(false);
    expect(etagMatches(weakEtag("{\"a\":2}"), tag)).toBe(false);
  });
});

(URL_ ? describe : describe.skip)("queue light rows and ETag / 304", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const session = { cookie: "", csrf: "" };
  let orgId = "";
  let opId = "";

  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 3).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };

  async function call(url: string, headers: Record<string, string> = {}) {
    const res = await app.inject({ method: "GET", url, headers: { cookie: session.cookie, "x-csrf": session.csrf, ...headers } });
    return { status: res.statusCode, raw: res.body, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
  }

  async function draft(key: string, status: "ready" | "published") {
    const [s] = await h.db
      .insert(stories)
      .values({ orgId, slug: key, status: "composed", headline: key, body: `${key} point one\n${key} point two`, layout: "breaking", mediaState: "none", district: "Jaipur", needsCheck: ["district_unknown"] })
      .returning();
    const [row] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: s!.id, status, bodyText: `${key} tweet`, cardHeadline: key, hashtags: ["#Jaipur"], composeVersion: "b1", cardRev: 1, cardRenderedRev: 1, cardKey: `cards/${key}/r1.jpg` })
      .returning();
    if (status === "published") await h.db.insert(publishedPosts).values({ orgId, draftId: row!.id, platform: "x", text: `${key} tweet`, manual: true, publishedBy: opId });
    return row!.id;
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
    const [op] = await h.db.insert(users).values({ orgId, name: "Op", email: "op@test", passwordHash: await hashPassword("correct horse battery"), role: "operator" }).returning();
    opId = op!.id;
    await draft("new-one", "ready");
    await draft("new-two", "ready");
    await draft("went-out", "published");

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-qslim-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: "correct horse battery" } });
    session.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    session.csrf = JSON.parse(res.body).csrfToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  const DROPPED = ["postText", "bodyText", "storyBody", "cardUrl", "length"];

  it("fields=list on New drops the text and card link, and keeps everything else as the full row has it", async () => {
    const full = (await call("/x/queue")).body.items as Record<string, unknown>[];
    const slim = await call("/x/queue?fields=list");
    expect(slim.status).toBe(200);
    const items = slim.body.items as Record<string, unknown>[];
    expect(items.map((i) => i.headline)).toEqual(full.map((i) => i.headline));
    for (const [i, row] of items.entries()) {
      for (const k of DROPPED) expect(row, k).not.toHaveProperty(k);
      expect(row).toMatchObject({ id: expect.any(String), status: "ready", version: expect.any(Number), claim: null, needsCheck: ["district_unknown"], tags: null, card: { state: expect.any(String) } });
      // The same row, less the dropped fields, in the same order
      const want = Object.fromEntries(Object.entries(full[i]!).filter(([k]) => !DROPPED.includes(k)));
      expect(Object.keys(row)).toEqual(Object.keys(want));
      expect(row).toEqual(want);
    }
    expect(slim.raw.length).toBeLessThan(JSON.stringify((await call("/x/queue")).body).length);
  });

  it("without fields the New rows are full, as before", async () => {
    const [row] = (await call("/x/queue")).body.items as Record<string, unknown>[];
    expect(row).toMatchObject({ bodyText: expect.stringMatching(/tweet$/), storyBody: expect.stringContaining("point one"), postText: expect.stringContaining("#Jaipur"), length: expect.any(Number), cardUrl: expect.stringContaining("/dev-files/cards/") });
  });

  it("every other view ignores fields=list and stays full", async () => {
    const posted = (await call("/x/queue?view=posted&fields=list")).body.items as Record<string, unknown>[];
    expect(posted).toHaveLength(1);
    for (const k of DROPPED) expect(posted[0], k).toHaveProperty(k);
    expect(posted[0]).toMatchObject({ headline: "went-out", postText: expect.stringContaining("went-out tweet"), cardUrl: expect.stringContaining("/dev-files/") });
    expect((await call("/x/queue?view=rejected&fields=list")).status).toBe(200);
  });

  it("refuses an unknown fields value", async () => {
    expect((await call("/x/queue?fields=all")).status).toBe(400);
  });

  for (const url of ["/x/queue", "/x/queue?fields=list", "/x/queue?view=posted", "/x/queue/facets", "/x/counts", "/posts?limit=50"]) {
    it(`${url}: the same body gets the same weak ETag, and If-None-Match answers 304 with no body`, async () => {
      const a = await call(url);
      const b = await call(url);
      expect(a.status).toBe(200);
      expect(a.headers.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
      expect(b.headers.etag).toBe(a.headers.etag);
      expect(b.raw).toBe(a.raw);
      expect(a.headers["cache-control"]).toBe("private, no-cache");
      const again = await call(url, { "if-none-match": String(a.headers.etag) });
      expect(again.status).toBe(304);
      expect(again.raw).toBe("");
      expect(again.headers.etag).toBe(a.headers.etag);
      // A stale tag gets the whole body
      const stale = await call(url, { "if-none-match": 'W/"stale"' });
      expect(stale.status).toBe(200);
      expect(stale.raw).toBe(a.raw);
    });
  }

  it("a change gives a new ETag; errors and other routes carry none", async () => {
    const before = await call("/x/counts");
    await draft("new-three", "ready");
    const after = await call("/x/counts", { "if-none-match": String(before.headers.etag) });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    const bad = await call("/x/queue?day=nope");
    expect(bad.status).toBe(400);
    expect(bad.headers.etag).toBeUndefined();
    const signedOut = await app.inject({ method: "GET", url: "/x/counts" });
    expect(signedOut.statusCode).toBe(401);
    expect(signedOut.headers.etag).toBeUndefined();
    expect((await call("/caps")).headers.etag).toBeUndefined();
  });
});
