// What the dashboard reads: queue items with source, district and media counts; a draft with its
// media; counts per state; posts with their card; ingest health. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assets, createDb, ingestedFiles, orgs, postDrafts, publishedPosts, recordIngestPoll, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL = process.env.TEST_DATABASE_URL;

(URL ? describe : describe.skip)("dashboard API", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = "";
  let samvadiaDraft = "";
  let rejectedDraft = "";
  let orgId = "";

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 3).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  };

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    await h.db.insert(users).values({ orgId, name: "Op", email: "op@test", passwordHash: await hashPassword("correct horse battery"), role: "operator" });

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-dash-")), "http://localhost/dev-files");
    await store.put("cards/s.png", new Uint8Array([137, 80, 78, 71]), "image/png");
    await store.put("media/s/photo.jpg", new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");

    // A Samvadia story with a copied photo and a recorded-only video
    const [s] = await h.db
      .insert(stories)
      .values({
        orgId, source: "samvadia", externalId: "abc:v1", district: "Baran", slug: "271026_BRN_DHAN_AV_MUKESH", status: "composed", headline: "धान की आवक", body: "मंडी में आवक।",
        mediaState: "attached",
        external: { storyId: "abc", itemId: "item", version: 1, kind: "original", guid: "g", title: "t", reporter: "MUKESH", districtCode: "BRN", publishedAt: new Date().toISOString(), footagePath: "/BARAN/x/", footageStatus: "found", priority: "breaking", category: "राजनीति/Politics" },
      })
      .returning();
    await h.db.insert(assets).values([
      { orgId, storyId: s!.id, kind: "video", slug: s!.slug, storageKey: null, skipReason: "video_off", attachedBy: "footage", sourcePath: "/BARAN/x/clip.mp4", fileName: "clip.mp4", bytes: 300 },
      { orgId, storyId: s!.id, kind: "image", slug: s!.slug, storageKey: "media/s/photo.jpg", attachedBy: "footage", sourcePath: "/BARAN/x/photo.jpg", fileName: "photo.jpg", bytes: 3 },
    ]);
    const [d1] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: s!.id, status: "ready", bodyText: "धान की आवक", cardHeadline: "धान की आवक", hashtags: ["#Baran"], composeVersion: "t", cardRenderedRev: 1, cardKey: "cards/s.png" })
      .returning();
    samvadiaDraft = d1!.id;

    // A file story, published today
    const [file] = await h.db.insert(ingestedFiles).values({ orgId, sha256: "f", sourcePath: "/a.txt", fileName: "a.txt", bytes: 1, storageKey: "raw/a", kind: "text", slug: "a" }).returning();
    const [fs] = await h.db.insert(stories).values({ orgId, fileId: file!.id, slug: "a", status: "composed", headline: "पुरानी खबर", body: "" }).returning();
    const [d2] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: fs!.id, status: "published", bodyText: "पुरानी खबर", cardHeadline: "पुरानी खबर", composeVersion: "t", cardRenderedRev: 1, cardKey: "cards/s.png" })
      .returning();
    await h.db.insert(publishedPosts).values({ orgId, draftId: d2!.id, platform: "x", platformPostId: "123", permalink: "https://x.com/a/status/123", text: "पुरानी खबर" });

    // A rejected file story, with the operator's note; file stories carry no Samvadia priority
    const [rs] = await h.db.insert(stories).values({ orgId, slug: "r", status: "composed", headline: "दोहराई खबर", body: "" }).returning();
    const [d3] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: rs!.id, status: "rejected", rejectReason: "duplicate", rejectNote: "सुबह जा चुकी है", bodyText: "दोहराई खबर", cardHeadline: "दोहराई खबर", composeVersion: "t" })
      .returning();
    rejectedDraft = d3!.id;

    await recordIngestPoll(h.db, orgId, { mode: "samvadia", taken: 2, cursor: { publishedAt: new Date().toISOString(), storyId: "abc" } });

    app = await buildApp({ db: h.db, storage: store, config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: "correct horse battery" } });
    expect(JSON.parse(res.body).next).toBe("done");
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("queue items carry source, district, Samvadia priority and category, and media counts", async () => {
    const { body } = await get("/x/queue");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: samvadiaDraft, source: "samvadia", district: "Baran", priority: "breaking", category: "राजनीति/Politics",
      media: { images: 1, videos: 1, state: "attached" }, createdAt: expect.any(String), rejectReason: null, rejectNote: null,
    });
  });

  it("rejected items carry the reject note; a story without Samvadia labels is normal / null", async () => {
    const { body } = await get("/x/queue?view=rejected");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: rejectedDraft, rejectReason: "duplicate", rejectNote: "सुबह जा चुकी है", priority: "normal", category: null });
    expect((await get(`/drafts/${rejectedDraft}`)).body.story).toMatchObject({ priority: "normal", category: null });
  });

  it("pages the rejected news newest-rejected first, with a cursor", async () => {
    const [org] = await h.db.select().from(orgs);
    // Four more rejected drafts, rejected a minute apart; two share a time so the id breaks the tie
    const base = Date.now() - 3600_000;
    const times = [base + 60_000, base + 120_000, base + 120_000, base + 180_000];
    const made: string[] = [];
    for (const [i, at] of times.entries()) {
      const [s] = await h.db.insert(stories).values({ orgId: org!.id, slug: `rej${i}`, status: "composed", headline: `रद्द ${i}`, body: "" }).returning();
      const [d] = await h.db
        .insert(postDrafts)
        .values({ orgId: org!.id, storyId: s!.id, status: "rejected", rejectReason: "duplicate", bodyText: `रद्द ${i}`, cardHeadline: `रद्द ${i}`, composeVersion: "t", updatedAt: new Date(at) })
        .returning();
      made.push(d!.id);
    }
    const all = (await get("/x/queue?view=rejected")).body;
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { status: number; body: { items: { id: string }[]; nextCursor: string | null } } = await get(`/x/queue?view=rejected&limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((i) => i.id));
      cursor = page.body.nextCursor;
      if (cursor) expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/);
      pages++;
    } while (cursor && pages < 10);
    // Every rejected draft once, in the same order as the single page
    expect(seen).toEqual(all.items.map((i: { id: string }) => i.id));
    expect(seen.slice(1)).toEqual(expect.arrayContaining(made));
    expect(pages).toBe(3);

    expect((await get("/x/queue?view=rejected&before=yesterday")).status).toBe(400);
    expect((await get(`/x/queue?view=rejected&before=${encodeURIComponent(`${new Date().toISOString()}|not-a-uuid`)}`)).status).toBe(400);
    // A bare time still works (older clients)
    expect((await get(`/x/queue?view=rejected&before=${encodeURIComponent(new Date(base + 150_000).toISOString())}`)).body.items.map((i: { id: string }) => i.id))
      .toEqual(expect.arrayContaining([made[0], made[1], made[2]]));
    expect((await get("/x/queue?view=rejected&limit=201")).status).toBe(400);

    // Leave the shared fixture as the other tests expect it
    const storyIds = (await h.db.select({ s: postDrafts.storyId }).from(postDrafts).where(inArray(postDrafts.id, made))).map((r) => r.s);
    await h.db.delete(postDrafts).where(inArray(postDrafts.id, made));
    await h.db.delete(stories).where(inArray(stories.id, storyIds));
  });

  it("a draft carries its media (photos first) and where its story came from", async () => {
    const { body } = await get(`/drafts/${samvadiaDraft}`);
    expect(body.media.map((m: { kind: string }) => m.kind)).toEqual(["image", "video"]);
    expect(body.media[0]).toMatchObject({ fileName: "photo.jpg", copied: true, url: "http://localhost/dev-files/media/s/photo.jpg", skipReason: null });
    expect(body.media[1]).toMatchObject({ fileName: "clip.mp4", copied: false, url: null, skipReason: "video_off", bytes: 300 });
    expect(body.story).toMatchObject({ source: "samvadia", district: "Baran", priority: "breaking", category: "राजनीति/Politics", external: { footagePath: "/BARAN/x/", reporter: "MUKESH" } });
  });

  it("counts drafts per state and view, and posts today", async () => {
    const { body } = await get("/x/counts");
    expect(body.byStatus).toMatchObject({ ready: 1, published: 1, claimed: 0, failed: 0 });
    expect(body.byView).toEqual({ inbox: 1, sending: 0, rejected: 1, failed: 0 });
    expect(body.publishedToday).toBe(1);
    expect(body.cap).toMatchObject({ platform: "x", cap: 800 });
  });

  it("lists posts with their card and headline", async () => {
    const { body } = await get("/posts");
    expect(body.items[0]).toMatchObject({ headline: "पुरानी खबर", slug: "a", cardUrl: "http://localhost/dev-files/cards/s.png" });
  });

  it("reports ingest health", async () => {
    const { body } = await get("/ingest/status");
    expect(body).toMatchObject({ mode: "samvadia", lastError: null, cursor: { storyId: "abc" }, today: { stories: 3, mediaCopied: 1, mediaSkipped: 1 }, recentErrors: [] });
    expect(body.lastPollAt).toEqual(body.lastOkAt);
  });

  it("needs a session", async () => {
    const res = await app.inject({ method: "GET", url: "/ingest/status" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("signed_out");
  });

  it("serves copied media locally with the right type", async () => {
    const res = await app.inject({ method: "GET", url: "/dev-files/media/s/photo.jpg" });
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });
});
