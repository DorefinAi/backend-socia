// Ops status for the Sentry control centre (dev-docs/ops-status-contract.md): GET /owner/ops/summary, /stories,
// /story/{slug} and /logins, plus the sign-in recording (§5). The pure parts (IST days, where a story is, stuck limits)
// and the routes against a stub database always run; the numbers against a real Postgres when TEST_DATABASE_URL is
// set (the database is wiped).

import { auditLog, createDb, ingestedFiles, loginEvent, orgs, postDrafts, publishedPosts, pruneLoginEvents, recordLoginEvent, runMigrations, setKv, stories, users, type Db, type DbHandle } from "@socia/db";
import type { Storage } from "@socia/providers";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { DIGITAL_STAGES, STUCK_LIMIT_MINUTES, likePattern, opsDay, storyPosition, type StoryRow } from "../src/ops-status";

const KEY = "k".repeat(40);
const URL = process.env.TEST_DATABASE_URL;
const config: ApiConfig = {
  databaseUrl: URL ?? "", port: 0, corsOrigins: [], cookieSecure: false, sessionHours: 12, requireTotp: false,
  secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, ownerApiKey: KEY, phase: 1,
};
const headers = { authorization: `Bearer ${KEY}`, "x-owner-actor": "sentry-sync" };
const ENDPOINTS = ["/owner/ops/summary", "/owner/ops/stories", "/owner/ops/story/ANY_SLUG", "/owner/ops/logins"];

// ─── Pure parts ──────────────────────────────────────────────────────────────

describe("opsDay", () => {
  it("a date is the IST day, 00:00–24:00 +05:30", () => {
    expect(opsDay("2026-11-20")).toEqual({ date: "2026-11-20", start: new Date("2026-11-19T18:30:00.000Z"), end: new Date("2026-11-20T18:30:00.000Z") });
  });

  it("no date is today in IST (just after midnight IST is already the next day)", () => {
    expect(opsDay(undefined, new Date("2026-11-20T18:31:00Z")).date).toBe("2026-11-21");
    expect(opsDay(undefined, new Date("2026-11-20T18:29:00Z")).date).toBe("2026-11-20");
  });

  it.each(["2026-02-30", "2026-13-01", "20261120", "2026-1-2", ""])("refuses %j with 400 invalid", (d) => {
    expect(() => opsDay(d)).toThrowError(expect.objectContaining({ status: 400, code: "invalid" }));
  });
});

describe("likePattern", () => {
  it("makes % _ and \\ literal", () => {
    expect(likePattern("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
  });
});

describe("storyPosition", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  const base: StoryRow = {
    id: "s", slug: "X", headline: "h", status: "composed", source: "file", lastError: null,
    createdAt: ago(200), updatedAt: ago(200), receivedAt: ago(200),
    draftId: "d", draftStatus: "ready", cardRev: 0, cardRenderedRev: 0, renderError: null, draftCreatedAt: ago(5), draftUpdatedAt: ago(1),
  };
  const at = (patch: Partial<StoryRow>) => storyPosition({ ...base, ...patch }, now);

  it("waiting stages and their stuck limits (contract §1.2)", () => {
    expect(STUCK_LIMIT_MINUTES).toEqual({ ingest: 10, convert: 10, compose: 10, render: 10, operator: 60 });
    expect(at({ status: "ingested", updatedAt: ago(10) })).toMatchObject({ stage: "convert", state: "on_track", minutes: 10 });
    expect(at({ status: "ingested", updatedAt: ago(11) })).toMatchObject({ stage: "convert", state: "stuck", minutes: 11 });
    expect(at({ status: "converted", updatedAt: ago(11) })).toMatchObject({ stage: "compose", state: "stuck" });
    expect(at({ draftStatus: "rendering", draftUpdatedAt: ago(3) })).toMatchObject({ stage: "render", state: "on_track" });
    // A card asked for and not drawn waits in render, since the ask
    expect(at({ cardRev: 2, cardRenderedRev: 1, draftUpdatedAt: ago(12) })).toMatchObject({ stage: "render", state: "stuck" });
    // The desk queue: since the draft arrived, not since its last edit
    expect(at({ draftCreatedAt: ago(60), draftUpdatedAt: ago(1) })).toMatchObject({ stage: "operator", state: "on_track", minutes: 60 });
    expect(at({ draftStatus: "claimed", draftCreatedAt: ago(61) })).toMatchObject({ stage: "operator", state: "stuck", since: ago(61) });
    // publish has no limit
    expect(at({ draftStatus: "queued", draftUpdatedAt: ago(500) })).toMatchObject({ stage: "publish", state: "on_track" });
  });

  it("failed and done", () => {
    expect(at({ status: "failed", lastError: "The file has no text." })).toEqual({ stage: "convert", state: "failed", since: null, minutes: null });
    expect(at({ status: "failed", lastError: "Could not compose this file: boom" })).toMatchObject({ stage: "compose", state: "failed" });
    expect(at({ draftStatus: "render_failed" })).toMatchObject({ stage: "render", state: "failed" });
    expect(at({ draftStatus: "failed", renderError: "The file was saved again and can't be used: empty" })).toMatchObject({ stage: "convert", state: "failed" });
    expect(at({ draftStatus: "failed", renderError: "X said no" })).toMatchObject({ stage: "publish", state: "failed" });
    expect(at({ draftStatus: "published" })).toMatchObject({ stage: "publish", state: "done" });
    expect(at({ draftStatus: "recalled" })).toMatchObject({ stage: "publish", state: "done" });
    expect(at({ draftStatus: "rejected" })).toMatchObject({ stage: "operator", state: "done" });
  });
});

describe("recordLoginEvent", () => {
  it("never throws: a failed insert is logged and the sign-in goes on", async () => {
    const warned: string[] = [];
    const db = { insert: () => ({ values: async () => Promise.reject(new Error("relation \"login_event\" does not exist")) }) } as unknown as Db;
    await expect(recordLoginEvent(db, { username: "a@b", result: "success" }, { warn: (_o, m) => void warned.push(m) })).resolves.toBeUndefined();
    expect(warned).toEqual(["could not record the sign-in attempt; the sign-in went on"]);
    const throwingLog = { warn: () => { throw new Error("log broken"); } };
    await expect(recordLoginEvent(db, { username: "a@b", result: "success" }, throwingLog)).resolves.toBeUndefined();
  });

  it("clips the typed name and user agent to 200 characters", async () => {
    const values: Record<string, unknown>[] = [];
    const db = { insert: () => ({ values: async (v: Record<string, unknown>) => void values.push(v) }) } as unknown as Db;
    await recordLoginEvent(db, { username: `  ${"u".repeat(300)} `, userAgent: "a".repeat(300), ip: "10.0.0.1", result: "bad_password" });
    expect(values[0]).toMatchObject({ app: "digital-desk", userId: null, ip: "10.0.0.1", result: "bad_password" });
    expect((values[0]!.username as string).length).toBe(200);
    expect((values[0]!.userAgent as string).length).toBe(200);
  });
});

// ─── The routes on a stub database ───────────────────────────────────────────

describe("owner ops routes (stub database)", () => {
  const dialect = new PgDialect();
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: SQL) => {
      seen.push(dialect.sqlToQuery(q));
      return { rows: [] };
    },
    // getKv (ingest status, heartbeat, data files): nothing recorded
    select: () => ({ from: () => ({ where: async () => [] }) }),
  } as unknown as Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ db, storage: {} as Storage, config }, false);
  });
  afterAll(async () => app?.close());
  const get = (url: string, h: Record<string, string> = headers) => app.inject({ method: "GET", url, headers: h });

  it.each(ENDPOINTS)("%s refuses a missing or wrong key, and wants the actor", async (url) => {
    expect((await get(url, {})).statusCode).toBe(401);
    expect((await get(url, { authorization: `Bearer ${"x".repeat(40)}`, "x-owner-actor": "a" })).json()).toMatchObject({ error: "unauthorized" });
    expect((await get(url, { authorization: `Bearer ${KEY}` })).json()).toMatchObject({ error: "invalid_actor" });
  });

  it.each([
    "/owner/ops/summary?date=2026-02-30", "/owner/ops/summary?date=20261120", "/owner/ops/summary?date=", "/owner/ops/summary?other=1",
    "/owner/ops/stories?limit=0", "/owner/ops/stories?limit=51", "/owner/ops/stories?limit=x", "/owner/ops/stories?date=2026-13-01",
    `/owner/ops/stories?q=${"a".repeat(201)}`, "/owner/ops/logins?date=2026-11-31", "/owner/ops/logins?date=yesterday",
  ])("400 invalid for %s", async (url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid" });
  });

  it("summary: every stage in order, 24 hours, zeros and nulls when nothing happened; never cached", async () => {
    const res = await get("/owner/ops/summary?date=2026-11-20");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ date: "2026-11-20", phase: 1, processes: [], stuck: [], failures: [] });
    expect(typeof body.generatedAt).toBe("string");
    expect(body.stages.map((s: { id: string }) => s.id)).toEqual([...DIGITAL_STAGES]);
    for (const s of body.stages) expect(s).toMatchObject({ count: 0, waiting: 0, oldestWaitingAt: null, failed: 0 });
    expect(body.stages.find((s: { id: string }) => s.id === "publish").note).toMatch(/auto publish is off/);
    expect(body.hourly).toEqual(Array.from({ length: 24 }, (_, hour) => ({ hour, storiesIn: 0, errors: 0 })));
    expect(body.flow).toEqual({
      storiesIn: 0, bySource: { portal: 0, outlook: 0, whatsapp: 0, share: 0 }, approved: 0, rejected: 0, inFeed: 0, collected: 0, medianMinutesToFeed: null, posts: 0, recalled: 0,
    });
    expect(body.checks.map((c: { id: string }) => c.id)).toEqual(["db", "share", "worker", "data-files"]);
    // Never checked: ok null
    expect(body.checks.slice(1).map((c: { ok: unknown }) => c.ok)).toEqual([null, null, null]);
    expect(body.queues).toEqual([{ name: "publish", pending: 0, running: 0, failed: 0, oldestPendingSec: null }]);
  });

  it("summary: the day asked for is read as 00:00–24:00 IST", async () => {
    seen.length = 0;
    await get("/owner/ops/summary?date=2026-11-20");
    const params = seen.flatMap((q) => q.params);
    expect(params).toContain("2026-11-19T18:30:00.000Z");
    expect(params).toContain("2026-11-20T18:30:00.000Z");
  });

  it("stories: empty list; date and limit reach the query", async () => {
    seen.length = 0;
    const res = await get("/owner/ops/stories?q=ab%25&date=2026-11-01&limit=7");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ items: [] });
    const q = seen.at(-1)!;
    expect(q.sql).toContain("ILIKE");
    expect(q.params).toEqual(expect.arrayContaining(["%ab\\%%", "2026-10-31T18:30:00.000Z", "2026-11-01T18:30:00.000Z", 7]));
  });

  it("story: 404 not_found for an unknown slug, not cached", async () => {
    const res = await get("/owner/ops/story/NO_SUCH_SLUG");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "not_found" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("logins: empty lists", async () => {
    const res = await get("/owner/ops/logins?date=2026-11-20");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], activeSessions: [] });
  });
});

// ─── The numbers on a real Postgres ──────────────────────────────────────────

(URL ? describe : describe.skip)("owner ops (Postgres)", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  let userId = "";
  const ids: Record<string, { story: string; draft?: string }> = {};
  // Day D = 1 Nov 2026 IST, which starts at 2026-10-31T18:30Z; ist(9, 5) = 09:05 IST on D
  const D = "2026-11-01";
  const ist = (hour: number, min = 0, day = D) => new Date(new Date(`${day}T00:00:00+05:30`).getTime() + (hour * 60 + min) * 60_000);
  const owner = async (url: string) => {
    const res = await app.inject({ method: "GET", url, headers });
    return { status: res.statusCode, body: res.json() };
  };

  async function story(slug: string, o: {
    status: string; at: Date; updatedAt?: Date; receivedAt?: Date; source?: string; lastError?: string;
    draft?: { status: string; at: Date; updatedAt?: Date; cardRev?: number; cardRenderedRev?: number };
  }) {
    const [file] = await h.db
      .insert(ingestedFiles)
      .values({ orgId, sha256: `${slug}-${Math.random()}`, sourcePath: `/share/${slug}.txt`, fileName: `${slug}.txt`, bytes: 2048, storageKey: `raw/${slug}`, kind: "text", slug, ingestedAt: o.at })
      .returning();
    const [s] = await h.db
      .insert(stories)
      .values({
        orgId, fileId: o.source === "trend" ? null : file!.id, source: (o.source ?? "file") as "file", slug, status: o.status as "composed", layout: "breaking",
        headline: `Headline ${slug}`, lastError: o.lastError ?? null, town: "Kota", fileTags: { reporter: "RAMESH" } as never,
        createdAt: o.at, updatedAt: o.updatedAt ?? o.at, receivedAt: o.receivedAt ?? o.at,
      })
      .returning();
    let draft: string | undefined;
    if (o.draft) {
      const [d] = await h.db
        .insert(postDrafts)
        .values({
          orgId, storyId: s!.id, platform: "x", status: o.draft.status, bodyText: "b", cardHeadline: "c", composeVersion: "t",
          cardRev: o.draft.cardRev ?? 0, cardRenderedRev: o.draft.cardRenderedRev ?? 0, createdAt: o.draft.at, updatedAt: o.draft.updatedAt ?? o.draft.at,
        })
        .returning();
      draft = d!.id;
    }
    ids[slug] = { story: s!.id, draft };
    return ids[slug]!;
  }

  beforeAll(async () => {
    h = createDb(URL!, 3);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    app = await buildApp({ db: h.db, storage: {} as Storage, config }, false);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const [u] = await h.db.insert(users).values({ orgId, name: "Op One", email: "op@test", passwordHash: await hashPassword("correct horse battery"), role: "operator" }).returning();
    userId = u!.id;

    // On D: one waiting for convert, one for compose, one in the desk queue, one posted, one rejected, one failed in compose
    await story("OPS_CONVERT_WAIT", { status: "ingested", at: ist(9) });
    await story("OPS_COMPOSE_WAIT", { status: "converted", at: ist(9, 5) });
    await story("OPS_READY", { status: "composed", at: ist(9, 10), draft: { status: "ready", at: ist(9, 10), updatedAt: ist(12) } });
    const posted = await story("OPS_POSTED", { status: "composed", at: ist(9, 20), draft: { status: "published", at: ist(9, 21) } });
    const rejected = await story("OPS_REJECTED", { status: "composed", at: ist(9, 30), draft: { status: "rejected", at: ist(9, 31) } });
    await story("OPS_FAILED", { status: "failed", at: ist(9, 40), lastError: "Could not compose this file: boom" });
    // An older day: a card asked for and not drawn (waits in render whatever its day), and a draft nobody took (not D's queue)
    await story("OLD_RENDER", { status: "composed", at: ist(12, 0, "2026-10-25"), draft: { status: "ready", at: ist(12, 0, "2026-10-25"), cardRev: 1 } });
    await story("OLD_READY", { status: "composed", at: ist(12, 5, "2026-10-25"), draft: { status: "ready", at: ist(12, 5, "2026-10-25") } });
    // The Web Scraper is not this pipeline
    await story("OPS_TREND", { status: "composed", source: "trend", at: ist(9, 50), draft: { status: "ready", at: ist(9, 50) } });
    // The same slug twice: the newer story is the one shown
    await story("OPS_DUP", { status: "failed", at: ist(8, 0, "2026-10-30"), lastError: "The file has no text." });
    await story("OPS_DUP", { status: "composed", at: ist(8, 0, "2026-10-31"), draft: { status: "rejected", at: ist(8, 1, "2026-10-31") } });

    await h.db.insert(publishedPosts).values({ orgId, draftId: posted.draft!, platform: "x", text: "t", publishedAt: ist(11), publishedBy: userId, manual: true });
    await h.db.insert(auditLog).values([
      { orgId, actorId: userId, action: "draft.copy_posted", entityType: "post_draft", entityId: posted.draft!, at: ist(11) },
      { orgId, actorId: userId, action: "draft.reject", entityType: "post_draft", entityId: rejected.draft!, at: ist(11, 30) },
      // Not an action on the queue
      { orgId, actorId: userId, action: "draft.edit", entityType: "post_draft", entityId: rejected.draft!, at: ist(11, 20) },
    ]);
    const line = (at: Date, level: string, message: string, itemId: string | null = null) =>
      h.db.execute(sql`INSERT INTO ops_log (at, system, level, message, item_id) VALUES (${at.toISOString()}::timestamptz, 'socia-ingest', ${level}, ${message}, ${itemId})`);
    await line(ist(9, 20, D), "info", "breaking file converted", posted.story);
    await line(ist(10, 5), "info", "card rendered");
    await line(ist(10, 15), "error", "card render failed: font missing");
    await line(ist(10, 20), "error", "could not ingest file; will try again next scan: EIO");
    await h.db.execute(sql`INSERT INTO ops_heartbeat (process, system, host, pid, started_at, beat_at) VALUES ('worker:ingest', 'socia-ingest', 'PC', 7, now() - interval '1 hour', now())`);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("summary: the day's numbers per stage", async () => {
    const { status, body } = await owner(`/owner/ops/summary?date=${D}`);
    expect(status).toBe(200);
    const stage = (id: string) => body.stages.find((s: { id: string }) => s.id === id);
    expect(stage("ingest")).toMatchObject({ count: 6, waiting: 0, oldestWaitingAt: null, failed: 1 });
    expect(stage("convert")).toMatchObject({ count: 5, waiting: 1, oldestWaitingAt: ist(9).toISOString(), failed: 0 });
    expect(stage("compose")).toMatchObject({ count: 3, waiting: 1, oldestWaitingAt: ist(9, 5).toISOString(), failed: 1 });
    expect(stage("render")).toMatchObject({ count: 1, waiting: 1, oldestWaitingAt: ist(12, 0, "2026-10-25").toISOString(), failed: 1 });
    // D's queue only (OLD_READY is another day's); since the draft arrived
    expect(stage("operator")).toMatchObject({ count: 2, waiting: 1, oldestWaitingAt: ist(9, 10).toISOString(), failed: 0 });
    expect(stage("publish")).toMatchObject({ count: 1, waiting: 0, failed: 0 });
    expect(body.flow).toEqual({
      storiesIn: 6, bySource: { portal: 0, outlook: 0, whatsapp: 0, share: 6 }, approved: 1, rejected: 1, inFeed: 0, collected: 0, medianMinutesToFeed: null, posts: 1, recalled: 0,
    });
    expect(body.hourly).toHaveLength(24);
    expect(body.hourly[9]).toEqual({ hour: 9, storiesIn: 6, errors: 0 });
    expect(body.hourly[10]).toEqual({ hour: 10, storiesIn: 0, errors: 2 });
    expect(body.failures).toEqual([
      { label: "File could not be taken in", count: 1 },
      { label: "Compose", count: 1 },
      { label: "Card render", count: 1 },
    ]);
    expect(body.processes).toEqual([{ process: "worker:ingest", system: "socia-ingest", host: "PC", startedAt: expect.any(String), beatAt: expect.any(String) }]);
  });

  it("summary: stuck items past their stage's limit, oldest first, with minutes", async () => {
    const { body } = await owner(`/owner/ops/summary?date=${D}`);
    expect(body.stuck.map((s: { slug: string; stage: string }) => [s.slug, s.stage])).toEqual([
      ["OLD_RENDER", "render"],
      ["OPS_CONVERT_WAIT", "convert"],
      ["OPS_COMPOSE_WAIT", "compose"],
      ["OPS_READY", "operator"],
    ]);
    const ready = body.stuck.find((s: { slug: string }) => s.slug === "OPS_READY");
    expect(ready).toMatchObject({ headline: "Headline OPS_READY", since: ist(9, 10).toISOString() });
    expect(ready.minutes).toBe(Math.floor((Date.now() - ist(9, 10).getTime()) / 60_000));
  });

  it("summary: a quiet day still has every stage and hour; waiting is what waits now", async () => {
    const { body } = await owner("/owner/ops/summary?date=2020-01-01");
    expect(body.date).toBe("2020-01-01");
    expect(body.stages.map((s: { count: number }) => s.count)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(body.hourly.every((x: { storiesIn: number; errors: number }) => x.storiesIn === 0 && x.errors === 0)).toBe(true);
    // The worker stages' backlog is the same whatever the day; the desk queue is that day's
    expect(body.stages.map((s: { waiting: number }) => s.waiting)).toEqual([0, 1, 1, 1, 0, 0]);
  });

  it("summary: checks from what the worker recorded", async () => {
    const now = new Date();
    await setKv(h.db, "ingest.status", {
      mode: "folder", lastPollAt: now.toISOString(), lastOkAt: now.toISOString(), lastError: null, cursor: null, recentErrors: [],
      source: { kind: "breaking", reachable: true, expectedFolder: "20_NOVEMBER_2026", todayFolder: "NOVEMBER_2026/20_NOVEMBER_2026", alsoScanning: null, filesToday: 3, lastFileAt: null, lastFileName: null, checkedAt: now.toISOString(), lastError: null },
    });
    await setKv(h.db, "ingest.heartbeat", { at: now.toISOString(), pid: 1 });
    await setKv(h.db, "phase1.data_files", [
      { file: "places", ok: true, at: "2026-11-20T01:00:00.000Z" },
      { file: "handles", ok: false, at: "2026-11-20T02:00:00.000Z", message: "The file is not valid JSON." },
    ]);
    const { body } = await owner("/owner/ops/summary");
    const check = (id: string) => body.checks.find((c: { id: string }) => c.id === id);
    expect(check("db")).toMatchObject({ ok: true, lastError: null });
    expect(check("share")).toMatchObject({ ok: true, lastOkAt: now.toISOString(), lastError: null, detail: "3 files today; today's folder found" });
    expect(check("worker")).toMatchObject({ ok: true, lastOkAt: now.toISOString(), lastError: null });
    expect(check("data-files")).toMatchObject({ ok: false, lastOkAt: "2026-11-20T01:00:00.000Z", lastError: "handles: The file is not valid JSON.", detail: "1 of 2 files read" });
    // No server path goes out
    expect(JSON.stringify(body.checks)).not.toContain("NOVEMBER_2026/");
  });

  it("stories: search by slug or headline, newest first, the Web Scraper left out", async () => {
    const { body } = await owner("/owner/ops/stories?q=ops_");
    expect(body.items.map((i: { slug: string }) => i.slug)).toEqual(["OPS_FAILED", "OPS_REJECTED", "OPS_POSTED", "OPS_READY", "OPS_COMPOSE_WAIT", "OPS_CONVERT_WAIT", "OPS_DUP", "OPS_DUP"]);
    const by = (slug: string) => body.items.find((i: { slug: string }) => i.slug === slug);
    expect(by("OPS_CONVERT_WAIT")).toEqual({ slug: "OPS_CONVERT_WAIT", headline: "Headline OPS_CONVERT_WAIT", receivedAt: ist(9).toISOString(), stage: "convert", state: "stuck" });
    expect(by("OPS_POSTED")).toMatchObject({ stage: "publish", state: "done" });
    expect(by("OPS_REJECTED")).toMatchObject({ stage: "operator", state: "done" });
    expect(by("OPS_FAILED")).toMatchObject({ stage: "compose", state: "failed" });
    // A headline matches too, case-insensitively; % and _ are literal
    expect((await owner("/owner/ops/stories?q=headline%20old_r")).body.items.map((i: { slug: string }) => i.slug)).toEqual(["OLD_READY", "OLD_RENDER"]);
    expect((await owner("/owner/ops/stories?q=%25")).body.items).toEqual([]);
    expect((await owner("/owner/ops/stories?q=OPS%5FTREND")).body.items).toEqual([]);
  });

  it("stories: date and limit", async () => {
    expect((await owner("/owner/ops/stories?date=2026-10-25")).body.items.map((i: { slug: string }) => i.slug)).toEqual(["OLD_READY", "OLD_RENDER"]);
    expect((await owner("/owner/ops/stories?limit=1")).body.items.map((i: { slug: string }) => i.slug)).toEqual(["OPS_FAILED"]);
    expect((await owner("/owner/ops/stories")).body.items).toHaveLength(10);
  });

  it("story: a posted story's whole trace", async () => {
    const { status, body } = await owner("/owner/ops/story/OPS_POSTED");
    expect(status).toBe(200);
    expect(body).toMatchObject({ slug: "OPS_POSTED", headline: "Headline OPS_POSTED", reporter: "RAMESH", city: "Kota", source: "share", state: "done", stuckAt: null });
    expect(body.steps).toEqual([
      { stage: "ingest", label: "Taken in from the breaking-news share", system: "socia-ingest", state: "done", at: ist(9, 20).toISOString(), detail: "1 file, 2 KB" },
      { stage: "convert", label: "Text read and converted", system: "socia-ingest", state: "done", at: ist(9, 20).toISOString(), detail: null },
      { stage: "compose", label: "Post drafted", system: "socia-ingest", state: "done", at: ist(9, 21).toISOString(), detail: null },
      { stage: "render", label: "Card drawn", system: "socia-render", state: "skipped", at: null, detail: "No card was asked for." },
      { stage: "operator", label: "Copied and marked posted", system: "socia-api", state: "done", at: ist(11).toISOString(), detail: null },
      { stage: "publish", label: "Marked posted on X", system: "socia-api", state: "done", at: ist(11).toISOString(), detail: "Posted by hand." },
    ]);
  });

  it("story: stuck, failed and rejected traces", async () => {
    const stuck = (await owner("/owner/ops/story/OPS_CONVERT_WAIT")).body;
    expect(stuck).toMatchObject({ state: "stuck", stuckAt: "convert" });
    expect(stuck.steps.map((s: { state: string }) => s.state)).toEqual(["done", "waiting", "waiting", "waiting", "waiting", "waiting"]);

    const failed = (await owner("/owner/ops/story/OPS_FAILED")).body;
    expect(failed).toMatchObject({ state: "failed", stuckAt: null });
    expect(failed.steps.map((s: { state: string }) => s.state)).toEqual(["done", "done", "failed", "skipped", "skipped", "skipped"]);
    expect(failed.steps[2].detail).toBe("Could not compose this file: boom");

    const rejected = (await owner("/owner/ops/story/OPS_REJECTED")).body;
    expect(rejected.steps.map((s: { state: string }) => s.state)).toEqual(["done", "done", "done", "skipped", "done", "skipped"]);
    expect(rejected.steps[4]).toMatchObject({ label: "Rejected", at: ist(11, 30).toISOString() });

    const ready = (await owner("/owner/ops/story/OPS_READY")).body;
    expect(ready).toMatchObject({ state: "stuck", stuckAt: "operator" });
    expect(ready.steps[4]).toMatchObject({ label: "In the desk queue", state: "waiting", at: null });
  });

  it("story: the newest of two stories with one slug; 404 for an unknown or Web Scraper slug", async () => {
    const dup = (await owner("/owner/ops/story/OPS_DUP")).body;
    expect(dup).toMatchObject({ state: "done" });
    expect(dup.steps[4].state).toBe("done");
    expect((await owner("/owner/ops/story/NOPE")).status).toBe(404);
    expect((await owner("/owner/ops/story/OPS_TREND")).body).toMatchObject({ error: "not_found" });
  });

  it("logins: every attempt recorded, newest first, without failing a sign-in; who is signed in now", async () => {
    const login = (email: string, password: string, ua = "Mozilla/5.0 test") =>
      app.inject({ method: "POST", url: "/auth/login", payload: { email, password }, headers: { "user-agent": ua }, remoteAddress: "10.1.2.3" });
    expect((await login("nobody@test", "whatever pass")).statusCode).toBe(401);
    expect((await login("op@test", "wrong password!")).statusCode).toBe(401);
    expect((await login(" OP@test ", "correct horse battery", "U".repeat(300))).statusCode).toBe(200);

    const { status, body } = await owner("/owner/ops/logins");
    expect(status).toBe(200);
    expect(body.events.map((e: { result: string }) => e.result)).toEqual(["success", "bad_password", "unknown_user"]);
    expect(body.events[0]).toMatchObject({ app: "digital-desk", user: "OP@test", name: "Op One", role: "operator", ip: "10.1.2.3" });
    expect(body.events[0].userAgent).toHaveLength(200);
    expect(body.events[2]).toMatchObject({ user: "nobody@test", name: null, role: null, userAgent: "Mozilla/5.0 test" });
    expect(typeof body.events[0].id).toBe("string");
    // Nothing secret in the record
    expect(JSON.stringify(body)).not.toContain("correct horse");
    expect(body.activeSessions).toEqual([{ app: "digital-desk", user: "op@test", since: expect.any(String), lastSeen: null, ip: null }]);
    // Another day's sign-ins are not this day's
    expect((await owner("/owner/ops/logins?date=2026-01-01")).body.events).toEqual([]);
  });

  it("login_event keeps 90 days", async () => {
    await h.db.insert(loginEvent).values({ app: "digital-desk", username: "old@test", result: "success", at: new Date(Date.now() - 91 * 86_400_000) });
    const before = (await h.db.select().from(loginEvent)).length;
    expect(await pruneLoginEvents(h.db)).toBe(1);
    expect((await h.db.select().from(loginEvent)).length).toBe(before - 1);
  });
});
