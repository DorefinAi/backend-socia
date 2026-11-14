// Live presence and watch mode over SSE + REST (routes/live.ts, presence.ts), against a real server on a random port:
// the stream (hello, presence.list, queue events, resync, pings), the clientId binding, edit vs watch, the holder's
// live text, snapshots, edit.ended on release, limits, take-over, the stream cap, and that another org sees nothing.
// Locks are taken and released over REST, as the browser does; the release reaches presence through the real LISTEN
// fan-out. Needs TEST_DATABASE_URL.

import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, notify, orgs, postDrafts, releaseExpiredClaims, runMigrations, sessions, stories, userPermissionOverrides, users, type Db, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { initials, MAX_EDIT_TEXT, PRESENCE_COLORS, presenceColor, PresenceHub, type LiveClient } from "../src/presence";
import { sseFrame } from "../src/routes/live";

const URL_ = process.env.TEST_DATABASE_URL;

type Session = { cookie: string; csrf: string };
type Logged = { event: string; data: any };
type Client = { clientId: string; session: Session; log: Logged[]; comments: string[]; headers: Headers; close: () => void; ended: Promise<void> };
type Person = { userId: string; name: string; initials: string; color: string; mode: "edit" | "watch"; correcting: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("presence colour and initials", () => {
  it("gives each user a stable colour from the palette, and two-letter initials", () => {
    const a = presenceColor("4b0c1a52-0d0e-4f39-9a8b-5a1c2d3e4f50");
    expect(PRESENCE_COLORS).toContain(a);
    expect(presenceColor("4b0c1a52-0d0e-4f39-9a8b-5a1c2d3e4f50")).toBe(a);
    const spread = new Set(Array.from({ length: 64 }, (_, i) => presenceColor(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)));
    expect(spread.size).toBeGreaterThan(4);
    expect(initials("asha rani verma")).toBe("AR");
    expect(initials("  Ravi  ")).toBe("R");
    expect(initials("")).toBe("");
  });
});

(URL_ ? describe : describe.skip)("live presence and watch mode (SSE + REST)", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let orgId = "";
  const who: Record<"holder" | "watcher" | "second" | "outsider" | "viewer" | "noundo" | "admin" | "mover", Session> = {
    holder: { cookie: "", csrf: "" }, watcher: { cookie: "", csrf: "" }, second: { cookie: "", csrf: "" }, outsider: { cookie: "", csrf: "" },
    viewer: { cookie: "", csrf: "" }, noundo: { cookie: "", csrf: "" }, admin: { cookie: "", csrf: "" }, mover: { cookie: "", csrf: "" },
  };
  const uid: Record<string, string> = {};
  let open: Client[] = [];

  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 7).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };

  async function call(s: Session, method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: s.cookie, "x-csrf": s.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  async function signIn(s: Session, email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    s.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    s.csrf = JSON.parse(res.body).csrfToken;
  }

  async function draft(key: string, platform = "x") {
    const [s] = await h.db.insert(stories).values({ orgId, slug: key, status: "composed", headline: key, body: "", layout: "breaking", mediaState: "none" }).returning();
    const [d] = await h.db.insert(postDrafts).values({ orgId, storyId: s!.id, platform, status: "ready", bodyText: key, cardHeadline: key, composeVersion: "t1", cardRev: 0 }).returning();
    return d!.id;
  }
  /** A breaking draft posted with Copy & Posted by the holder (as correction.test.ts) */
  async function postedDraft(key: string) {
    const [s] = await h.db.insert(stories).values({ orgId, slug: key, status: "composed", headline: key, body: "", layout: "breaking", mediaState: "none", district: "Jaipur" }).returning();
    const [d] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: s!.id, status: "ready", bodyText: `#Jaipur: ${key}`, cardHeadline: key, hashtags: ["#RajasthanWithFirstIndia", "#Desk"], composeVersion: "b1", cardRev: 0,
        handlePick: { cls: "other", why: "", warnings: [], handles: [] },
      })
      .returning();
    expect((await call(who.holder, "POST", `/drafts/${d!.id}/copy-posted`, { version: d!.version })).status).toBe(200);
    return d!.id;
  }
  async function claim(s: Session, id: string) {
    expect((await call(s, "POST", `/drafts/${id}/claim`)).status).toBe(200);
  }

  /** Opens GET /live/stream with fetch and parses it as SSE: events into `log`, comment lines into `comments` */
  async function stream(s: Session, query = ""): Promise<Client> {
    const ac = new AbortController();
    const res = await fetch(`${base}/live/stream${query}`, { headers: { cookie: s.cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const c: Client = { clientId: "", session: s, log: [], comments: [], headers: res.headers, close: () => ac.abort(), ended: Promise.resolve() };
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    c.ended = (async () => {
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += value;
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) c.comments.push(line.slice(1).trim());
              else if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            if (data.length) c.log.push({ event, data: JSON.parse(data.join("\n")) });
          }
        }
      } catch {
        // aborted
      }
    })();
    open.push(c);
    c.clientId = (await waitFor(c, "hello")).clientId;
    return c;
  }

  async function post(c: Client, path: string, body: Record<string, unknown>, opts: { session?: Session; clientId?: string } = {}) {
    const s = opts.session ?? c.session;
    const res = await fetch(`${base}/live/${path}`, {
      method: "POST",
      headers: { cookie: s.cookie, "x-csrf": s.csrf, "content-type": "application/json" },
      body: JSON.stringify({ clientId: opts.clientId ?? c.clientId, ...body }),
    });
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string; mode?: string } };
  }
  const send = async (c: Client, path: string, body: Record<string, unknown>) => (await post(c, path, body)).body;

  /** Waits for a logged event that matches; looks at what arrived after `from` */
  async function waitFor(c: Client, event: string, match: (data: any) => boolean = () => true, from = 0, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const hit = c.log.slice(from).find((l) => l.event === event && match(l.data));
      if (hit) return hit.data;
      if (Date.now() > end) throw new Error(`no ${event} within ${ms} ms`);
      await sleep(10);
    }
  }
  const people = (data: any, draftId: string): Person[] => (data?.stories?.[draftId] ?? []) as Person[];
  const latestList = (c: Client) => [...c.log].reverse().find((l) => l.event === "presence.list")?.data;
  async function listSettles(c: Client, draftId: string, ok: (p: Person[]) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      const list = people(latestList(c), draftId);
      if (ok(list)) return list;
      if (Date.now() > end) throw new Error(`presence list for ${draftId} did not settle: ${JSON.stringify(list)}`);
      await sleep(10);
    }
  }
  const state = (draftId: string, text: string, version = 1) => ({ draftId, text, selStart: text.length, selEnd: text.length, version, extra: "ignored" });

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };
    const [org] = await h.db.insert(orgs).values({ name: "1st India", settings }).returning();
    const [other] = await h.db.insert(orgs).values({ name: "Other Desk", settings }).returning();
    orgId = org!.id;
    const pw = await hashPassword("correct horse battery");
    const rows = await h.db
      .insert(users)
      .values([
        { orgId, name: "Asha Rani Verma", email: "holder@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Ravi Kumar", email: "watcher@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Second", email: "second@test", passwordHash: pw, role: "operator" },
        { orgId: other!.id, name: "Outsider", email: "outsider@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Viewer", email: "viewer@test", passwordHash: pw, role: "viewer" },
        { orgId, name: "No Undo", email: "noundo@test", passwordHash: pw, role: "operator" },
        { orgId, name: "Admin", email: "admin@test", passwordHash: pw, role: "admin" },
        { orgId, name: "Mover", email: "mover@test", passwordHash: pw, role: "operator" },
      ])
      .returning();
    for (const u of rows) uid[u.email.split("@")[0]!] = u.id;
    // An operator who may not correct others' posts (operators have Undo by default)
    await h.db.insert(userPermissionOverrides).values({ userId: uid.noundo!, permission: "post.undo", allowed: false });

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-presence-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config, live: { pingMs: 100, throttleMs: 20, takeoverCooldownMs: 2500, recheckMs: 200, streamOpensPerMin: 10_000 } }, false);
    // (This suite opens far more streams per person than a browser would: the open limit has its own app in N9)
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    for (const k of Object.keys(who) as (keyof typeof who)[]) await signIn(who[k], `${k}@test`);
    // The first stream starts the LISTEN connection; wait for its resync so the fan-out is up before any test
    const first = await stream(who.second);
    await waitFor(first, "resync", () => true, 0, 10_000);
    first.close();
  }, 60_000);

  afterEach(async () => {
    for (const c of open) c.close();
    await Promise.all(open.map((c) => c.ended));
    open = [];
    await sleep(50);
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("opens an SSE stream: headers, hello with a clientId, the list, pings; signed-out and wrong-platform refused", async () => {
    const c = await stream(who.holder);
    expect(c.headers.get("content-type")).toBe("text/event-stream");
    expect(c.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(c.headers.get("x-accel-buffering")).toBe("no");
    expect(c.log[0]).toEqual({ event: "hello", data: { clientId: c.clientId } });
    expect(c.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.log[1]).toEqual({ event: "presence.list", data: { stories: {} } });
    await sleep(250);
    expect(c.comments.filter((x) => x === "ping").length).toBeGreaterThanOrEqual(1);

    expect((await fetch(`${base}/live/stream`)).status).toBe(401);
    // An operator acts on their own platforms only
    expect((await fetch(`${base}/live/stream?platform=instagram`, { headers: { cookie: who.holder.cookie } })).status).toBe(403);
    expect((await fetch(`${base}/live/stream?platform=NOT%20OK`, { headers: { cookie: who.holder.cookie } })).status).toBe(400);
  });

  it("binds a clientId to the session that opened it, and needs the CSRF header", async () => {
    const id = await draft("binding");
    const mine = await stream(who.watcher);
    const theirs = await stream(who.second);
    // Another user's stream: 403, nothing recorded
    expect(await post(mine, "join", { draftId: id, mode: "watch" }, { clientId: theirs.clientId })).toEqual({ status: 403, body: { ok: false, error: "not_your_client" } });
    expect(await post(mine, "state", state(id, "x"), { clientId: theirs.clientId })).toEqual({ status: 403, body: { ok: false, error: "not_your_client" } });
    // The same user but another session (signed in again elsewhere): also not theirs
    const other: Session = { cookie: "", csrf: "" };
    await signIn(other, "second@test");
    expect((await post(theirs, "join", { draftId: id, mode: "watch" }, { session: other })).status).toBe(403);
    // An unknown or closed stream
    expect(await post(mine, "join", { draftId: id, mode: "watch" }, { clientId: "00000000-0000-4000-8000-000000000000" })).toEqual({ status: 403, body: { ok: false, error: "unknown_client" } });
    expect((await post(mine, "join", { draftId: id, mode: "watch" }, { clientId: 5 as unknown as string })).status).toBe(400);
    // No CSRF header: refused by the guard
    const res = await fetch(`${base}/live/join`, { method: "POST", headers: { cookie: who.watcher.cookie, "content-type": "application/json" }, body: JSON.stringify({ clientId: mine.clientId, draftId: id, mode: "watch" }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf");
    await sleep(80);
    expect(people(latestList(mine), id)).toEqual([]);
  });

  it("records joins once per person, keeps edit for the holder across tabs, and leaves the previous story", async () => {
    const id = await draft("list");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);

    expect(await send(holder, "join", { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
    expect(await send(watcher, "join", { draftId: id, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    const list = await listSettles(watcher, id, (p) => p.length === 2);
    expect(list).toContainEqual({ userId: uid.holder, name: "Asha Rani Verma", initials: "AR", color: presenceColor(uid.holder!), mode: "edit", correcting: false });
    expect(list).toContainEqual({ userId: uid.watcher, name: "Ravi Kumar", initials: "RK", color: presenceColor(uid.watcher!), mode: "watch", correcting: false });

    // A new stream gets the current list right after hello; a second tab of the holder, watching: one entry, still edit
    const tab = await stream(who.holder);
    expect(people(await waitFor(tab, "presence.list"), id)).toHaveLength(2);
    expect(await send(tab, "join", { draftId: id, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    await sleep(80);
    expect(people(latestList(watcher), id).filter((p) => p.userId === uid.holder)).toEqual([expect.objectContaining({ mode: "edit" })]);

    const other = await draft("list-other");
    expect(await send(watcher, "join", { draftId: other, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    await listSettles(holder, id, (p) => p.length === 1 && p[0]!.userId === uid.holder);
    expect(people(latestList(holder), other)).toEqual([expect.objectContaining({ userId: uid.watcher, mode: "watch" })]);

    expect(await send(watcher, "leave", { draftId: other })).toEqual({ ok: true });
    await waitFor(holder, "presence.list", (d) => !d.stories[other]);
  });

  it("records a non-holder asking for edit as a watcher, drops a watcher's state, and checks payloads", async () => {
    const id = await draft("refused");
    await claim(who.holder, id);
    const watcher = await stream(who.second);
    expect(await send(watcher, "join", { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "watch" });
    await listSettles(watcher, id, (p) => p.length === 1 && p[0]!.mode === "watch");

    const holder = await stream(who.holder);
    expect(await send(holder, "join", { draftId: id, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    const from = holder.log.length;
    expect(await send(watcher, "state", state(id, "not mine"))).toEqual({ ok: false, error: "not_holder" });
    await sleep(80);
    expect(holder.log.slice(from).some((l) => l.event === "edit.state")).toBe(false);

    expect(await send(holder, "state", state(await draft("unjoined"), "x"))).toEqual({ ok: false, error: "not_holder" });
    expect(await post(holder, "state", { draftId: id, text: 5, selStart: 0, selEnd: 0, version: 1 })).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    expect(await post(holder, "join", { draftId: "not-a-uuid", mode: "edit" })).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    expect(await post(holder, "join", { draftId: id, mode: "owner" })).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    expect(await post(holder, "join", { draftId: "00000000-0000-4000-8000-000000000000", mode: "watch" })).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
  });

  it("sends the holder's state to watchers but not the sender, and a snapshot to a late or returning watcher", async () => {
    const id = await draft("live");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    expect((await send(holder, "join", { draftId: id, mode: "edit" })).mode).toBe("edit");
    expect((await send(watcher, "join", { draftId: id, mode: "watch" })).mode).toBe("watch");
    expect(watcher.log.some((l) => l.event === "edit.snapshot")).toBe(false);

    expect(await send(holder, "state", state(id, "Jaipur: first", 3))).toEqual({ ok: true });
    const got = await waitFor(watcher, "edit.state");
    expect(got).toEqual({
      draftId: id, text: "Jaipur: first", selStart: 13, selEnd: 13, version: 3,
      userId: uid.holder, name: "Asha Rani Verma", color: presenceColor(uid.holder!), at: expect.any(String), correcting: false,
    });
    await sleep(80);
    expect(holder.log.some((l) => l.event === "edit.state")).toBe(false);

    expect(await send(holder, "state", state(id, "Jaipur: second", 4))).toEqual({ ok: true });
    const late = await stream(who.second);
    expect((await send(late, "join", { draftId: id, mode: "watch" })).mode).toBe("watch");
    expect(await waitFor(late, "edit.snapshot")).toMatchObject({ draftId: id, text: "Jaipur: second", version: 4, userId: uid.holder });

    const from = late.log.length;
    await send(late, "join", { draftId: id, mode: "watch" });
    expect(await waitFor(late, "edit.snapshot", () => true, from)).toMatchObject({ text: "Jaipur: second" });
  });

  it("ends the live text when the lock is released, forwards the queue event, and refuses the old holder after", async () => {
    const id = await draft("released");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    await send(holder, "state", state(id, "before release"));
    await waitFor(watcher, "edit.state");

    expect((await call(who.holder, "POST", `/drafts/${id}/release`)).status).toBe(200);
    expect(await waitFor(watcher, "draft.released")).toEqual({ type: "draft.released", draftId: id });
    expect(await waitFor(watcher, "edit.ended")).toEqual({ draftId: id, userId: uid.holder });
    await listSettles(watcher, id, (p) => p.find((x) => x.userId === uid.holder)?.mode === "watch");

    const from = watcher.log.length;
    expect(await send(holder, "state", state(id, "after release"))).toEqual({ ok: false, error: "not_holder" });
    await sleep(80);
    expect(watcher.log.slice(from).some((l) => l.event === "edit.state")).toBe(false);
    const late = await stream(who.second);
    await send(late, "join", { draftId: id, mode: "watch" });
    await sleep(80);
    expect(late.log.some((l) => l.event === "edit.snapshot")).toBe(false);

    // The holder's leaving ends it too
    const id2 = await draft("left");
    await claim(who.holder, id2);
    expect(await waitFor(watcher, "draft.claimed", (d) => d.draftId === id2)).toMatchObject({ type: "draft.claimed", userId: uid.holder });
    await send(holder, "join", { draftId: id2, mode: "edit" });
    await send(watcher, "join", { draftId: id2, mode: "watch" });
    await send(holder, "leave", { draftId: id2 });
    expect(await waitFor(watcher, "edit.ended", (d) => d.draftId === id2)).toEqual({ draftId: id2, userId: uid.holder });
  });

  it("cleans up when a stream closes: off the list, and the holder's live text ends", async () => {
    const id = await draft("disconnect");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    await listSettles(holder, id, (p) => p.length === 2);

    watcher.close();
    await listSettles(holder, id, (p) => p.length === 1 && p[0]!.userId === uid.holder);
    // Its clientId is gone with it
    expect((await post(watcher, "join", { draftId: id, mode: "watch" })).body).toEqual({ ok: false, error: "unknown_client" });

    const observer = await stream(who.second);
    await send(observer, "join", { draftId: id, mode: "watch" });
    holder.close();
    expect(await waitFor(observer, "edit.ended")).toEqual({ draftId: id, userId: uid.holder });
    await listSettles(observer, id, (p) => p.length === 1 && p[0]!.userId === uid.second);
  });

  it("limits state to 6 a second and 2000 characters, and join to 10 a second", async () => {
    const id = await draft("limits");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    await send(holder, "join", { draftId: id, mode: "edit" });

    expect(await post(holder, "state", state(id, "x".repeat(MAX_EDIT_TEXT + 1)))).toEqual({ status: 200, body: { ok: false, error: "too_long" } });
    await sleep(1100);
    const acks = await Promise.all(Array.from({ length: 9 }, (_, i) => post(holder, "state", state(id, "x".repeat(MAX_EDIT_TEXT), i))));
    expect(acks.filter((a) => a.body.ok)).toHaveLength(6);
    expect(acks.filter((a) => a.status === 429 && a.body.error === "rate_limited")).toHaveLength(3);
    await sleep(1100);
    expect(await send(holder, "state", state(id, "again"))).toEqual({ ok: true });

    const joiner = await stream(who.watcher);
    await sleep(1100);
    const joins = await Promise.all(Array.from({ length: 13 }, () => post(joiner, "join", { draftId: id, mode: "watch" })));
    expect(joins.filter((a) => a.body.ok)).toHaveLength(10);
    expect(joins.filter((a) => a.status === 429)).toHaveLength(3);
    // The windows outlive the stream (N9): let this second pass before the next test joins as the same people
    await sleep(1100);
  });

  it("passes a take-over request to the holder and the answer back; only the holder may answer", async () => {
    const id = await draft("takeover");
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    const second = await stream(who.second);
    await send(watcher, "join", { draftId: id, mode: "watch" });
    expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: false, error: "no_holder" });

    await claim(who.holder, id);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(second, "join", { draftId: id, mode: "watch" });

    expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: true });
    expect(await waitFor(holder, "takeover.requested")).toEqual({ draftId: id, from: { userId: uid.watcher, name: "Ravi Kumar", color: presenceColor(uid.watcher!) } });
    expect(second.log.some((l) => l.event === "takeover.requested")).toBe(false);
    expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: false, error: "pending" });

    expect(await send(second, "takeover/answer", { draftId: id, requesterId: uid.watcher, accept: true })).toEqual({ ok: false, error: "not_holder" });
    expect(await send(holder, "takeover/answer", { draftId: id, requesterId: uid.second, accept: true })).toEqual({ ok: false, error: "no_request" });
    await sleep(80);
    expect(watcher.log.some((l) => l.event === "takeover.answered")).toBe(false);

    expect(await send(holder, "takeover/answer", { draftId: id, requesterId: uid.watcher, accept: false })).toEqual({ ok: true });
    expect(await waitFor(watcher, "takeover.answered")).toEqual({ draftId: id, accept: false, by: { userId: uid.holder, name: "Asha Rani Verma" } });
    expect(second.log.some((l) => l.event === "takeover.answered")).toBe(false);

    // Asked again soon (past the 3-a-second request limit): the per-person cooldown (2.5 s here, 10 s live), also
    // across leave and re-join
    await sleep(1100);
    expect(await post(watcher, "takeover/request", { draftId: id })).toEqual({ status: 429, body: { ok: false, error: "cooldown" } });
    await send(watcher, "leave", { draftId: id });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: false, error: "cooldown" });
    await sleep(1500);

    // Asked again and accepted: the browsers release and claim over REST, and presence follows the lock
    const seen = holder.log.length;
    expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: true });
    await waitFor(holder, "takeover.requested", () => true, seen);
    expect(await send(holder, "takeover/answer", { draftId: id, requesterId: uid.watcher, accept: true })).toEqual({ ok: true });
    await waitFor(watcher, "takeover.answered", (d) => d.accept === true);
    expect((await call(who.holder, "POST", `/drafts/${id}/release`)).status).toBe(200);
    await waitFor(watcher, "edit.ended");
    await claim(who.watcher, id);
    await waitFor(watcher, "draft.claimed", (d) => d.draftId === id);
    await sleep(100);
    expect(await send(watcher, "join", { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
    expect(await send(watcher, "state", state(id, "mine now"))).toEqual({ ok: true });
    expect(await waitFor(holder, "edit.state")).toMatchObject({ text: "mine now", userId: uid.watcher });
    expect(await send(holder, "state", state(id, "not mine any more"))).toEqual({ ok: false, error: "not_holder" });
  });

  it("never shows another org's people, text or queue events", async () => {
    const id = await draft("private");
    const outsider = await stream(who.outsider);
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    await send(holder, "state", state(id, "inside only"));
    await waitFor(watcher, "edit.state");

    expect(await post(outsider, "join", { draftId: id, mode: "watch" })).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    expect(await send(outsider, "join", { draftId: id, mode: "edit" })).toEqual({ ok: false, error: "not_found" });
    expect(await send(outsider, "state", state(id, "hijack"))).toEqual({ ok: false, error: "not_holder" });
    expect(await send(outsider, "takeover/request", { draftId: id })).toEqual({ ok: false, error: "not_joined" });
    expect(await send(outsider, "takeover/answer", { draftId: id, requesterId: uid.watcher, accept: true })).toEqual({ ok: false, error: "not_holder" });
    // Nor may it act through the holder's stream
    expect((await post(holder, "state", state(id, "hijack"), { session: who.outsider })).status).toBe(403);
    await send(holder, "state", state(id, "still inside"));
    await waitFor(watcher, "edit.state", (d) => d.text === "still inside");
    await call(who.holder, "POST", `/drafts/${id}/release`);
    await waitFor(watcher, "draft.released", (d) => d.draftId === id);
    await sleep(100);

    expect(outsider.log.filter((l) => !["hello", "presence.list", "resync"].includes(l.event))).toEqual([]);
    for (const l of outsider.log.filter((x) => x.event === "presence.list")) expect(l.data).toEqual({ stories: {} });
    expect(holder.log.some((l) => l.event === "takeover.requested")).toBe(false);
  });

  it("keeps at most 8 streams per user, closing the oldest", async () => {
    const streams: Client[] = [];
    for (let i = 0; i < 8; i++) streams.push(await stream(who.second));
    const ninth = await stream(who.second);
    await streams[0]!.ended;
    // Told before it was closed, so the browser does not reconnect
    expect(streams[0]!.log.at(-1)).toEqual({ event: "replaced", data: {} });
    expect(streams[1]!.log.some((l) => l.event === "replaced")).toBe(false);
    expect((await post(streams[0]!, "leave", { draftId: "00000000-0000-4000-8000-000000000000" })).status).toBe(403);
    for (const c of [...streams.slice(1), ninth]) expect((await post(c, "leave", { draftId: "00000000-0000-4000-8000-000000000000" })).body).toEqual({ ok: true });
  });

  it("sends resync after the event listener reconnects", async () => {
    const c = await stream(who.holder);
    const from = c.log.length;
    // Drop the LISTEN connection (the test database only): the feed reconnects after 1 s and says resync
    await h.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
    expect(await waitFor(c, "resync", () => true, from, 8000)).toEqual({});
    // And events flow again
    const id = await draft("after-reconnect");
    await claim(who.holder, id);
    expect(await waitFor(c, "draft.claimed", (d) => d.draftId === id)).toMatchObject({ type: "draft.claimed" });
  }, 15_000);

  it("is off with LIVE=false: every /live path is a 404", async () => {
    const off = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-live-off-")), "http://localhost/dev-files"), config: { ...config, live: false } }, false);
    try {
      const s = who.holder;
      expect((await off.inject({ method: "GET", url: "/live/stream", headers: { cookie: s.cookie } })).statusCode).toBe(404);
      for (const p of ["join", "leave", "state", "takeover/request", "takeover/answer"]) {
        expect((await off.inject({ method: "POST", url: `/live/${p}`, payload: { clientId: "x" }, headers: { cookie: s.cookie, "x-csrf": s.csrf } })).statusCode).toBe(404);
      }
    } finally {
      await off.close();
    }
  });

  /** Resolves true when the stream ends within `ms` */
  const closes = (c: Client, ms = 3000) => Promise.race([c.ended.then(() => true), sleep(ms).then(() => false)]);

  it("refuses a take-over request from someone who could not take the story (claim rights)", async () => {
    const id = await draft("rights");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const viewer = await stream(who.viewer);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(viewer, "join", { draftId: id, mode: "watch" });
    // A viewer may watch, but has no Edit drafts
    expect(await post(viewer, "takeover/request", { draftId: id })).toEqual({ status: 403, body: { ok: false, error: "forbidden" } });
    await sleep(80);
    expect(holder.log.some((l) => l.event === "takeover.requested")).toBe(false);
  });

  // ─── One lock per story (L1–L4) ─────────────────────────────────────────────

  it("L1 one lock record for a claim and a correction hold: a story has at most one holder", async () => {
    // A claim keeps a correction out, and presence reads that one holder
    const id = await draft("l1-claimed");
    await claim(who.holder, id);
    expect((await call(who.admin, "POST", `/drafts/${id}/correction`)).body.error).toBe("invalid_state");
    expect((await call(who.admin, "POST", `/drafts/${id}/claim`)).status).toBe(409);
    const [claimed] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, id));
    expect(claimed).toMatchObject({ status: "claimed", claimedBy: uid.holder });

    // A correction hold is the same record (claimed_by on the published draft): nobody else can claim or correct it
    const posted = await postedDraft("l1-posted");
    expect((await call(who.holder, "POST", `/drafts/${posted}/correction`)).status).toBe(200);
    const [held] = await h.db.select().from(postDrafts).where(eq(postDrafts.id, posted));
    expect(held).toMatchObject({ status: "published", claimedBy: uid.holder });
    expect(held!.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await call(who.admin, "POST", `/drafts/${posted}/correction`)).body.error).toBe("held_by_other");
    expect((await call(who.admin, "POST", `/drafts/${posted}/claim`)).status).toBe(409);

    // Presence: the holder alone may edit and stream, on either kind of hold
    const holder = await stream(who.holder);
    const admin = await stream(who.admin);
    for (const story of [id, posted]) {
      expect(await send(holder, "join", { draftId: story, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
      expect(await send(admin, "join", { draftId: story, mode: "edit" })).toEqual({ ok: true, mode: "watch" });
      expect(await send(admin, "state", state(story, "not mine"))).toEqual({ ok: false, error: "not_holder" });
      expect(await send(holder, "state", state(story, "mine"))).toEqual({ ok: true });
    }
    await call(who.holder, "POST", `/drafts/${posted}/correction/done`);
    await call(who.holder, "POST", `/drafts/${id}/release`);
  });

  it("L2 refuses a take-over request on a posted story under correction: 409 correcting, to everyone", async () => {
    const posted = await postedDraft("l2-posted");
    expect((await call(who.holder, "POST", `/drafts/${posted}/correction`)).status).toBe(200);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    const noundo = await stream(who.noundo);
    const admin = await stream(who.admin);
    expect(await send(holder, "join", { draftId: posted, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
    for (const c of [watcher, noundo, admin]) {
      await send(c, "join", { draftId: posted, mode: "watch" });
      expect(await post(c, "takeover/request", { draftId: posted })).toEqual({ status: 409, body: { ok: false, error: "correcting" } });
    }
    await sleep(80);
    expect(holder.log.some((l) => l.event === "takeover.requested")).toBe(false);
    // Refused, not a cooldown: still refused for what it is
    expect(await post(admin, "takeover/request", { draftId: posted })).toEqual({ status: 409, body: { ok: false, error: "correcting" } });
    await call(who.holder, "POST", `/drafts/${posted}/correction/done`);
  });

  it("L2 refuses a correction hold the presence cache has not seen yet (the request reads the draft)", async () => {
    const id = await draft("l2-unseen");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    // Presence cached a claim; the same record turns into a correction hold with no event
    await h.db.update(postDrafts).set({ status: "published" }).where(eq(postDrafts.id, id));
    expect(await post(watcher, "takeover/request", { draftId: id })).toEqual({ status: 409, body: { ok: false, error: "correcting" } });
    await sleep(80);
    expect(holder.log.some((l) => l.event === "takeover.requested")).toBe(false);
  });

  it("L3 every way a hold ends clears the same record and sends the same edit.ended, claim or correction", async () => {
    const watcher = await stream(who.watcher);
    const holder = await stream(who.holder);
    const ended = async (id: string) => {
      // The queue event: draft.released for either kind of hold, never a draft.updated for the hold's end
      expect(await waitFor(watcher, "draft.released", (d) => d.draftId === id, 0, 5000)).toEqual({ type: "draft.released", draftId: id });
      expect(await waitFor(watcher, "edit.ended", (d) => d.draftId === id, 0, 5000)).toEqual({ draftId: id, userId: uid.holder });
      await listSettles(watcher, id, (p) => p.find((x) => x.userId === uid.holder)?.mode === "watch");
      const [row] = await h.db.select({ claimedBy: postDrafts.claimedBy, claimExpiresAt: postDrafts.claimExpiresAt }).from(postDrafts).where(eq(postDrafts.id, id));
      return row!;
    };
    const held = async (id: string, start: () => Promise<unknown>) => {
      await start();
      await sleep(100);
      updatesFrom = watcher.log.length;
      expect(await send(holder, "join", { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
      await send(watcher, "join", { draftId: id, mode: "watch" });
      expect(await send(holder, "state", state(id, "live"))).toEqual({ ok: true });
      await waitFor(watcher, "edit.state", (d) => d.draftId === id);
    };
    const correct = (id: string) => () => call(who.holder, "POST", `/drafts/${id}/correction`);
    const take = (id: string) => () => call(who.holder, "POST", `/drafts/${id}/claim`);
    let updatesFrom = 0;
    const noUpdate = (id: string) => expect(watcher.log.slice(updatesFrom).some((l) => l.event === "draft.updated" && l.data.draftId === id)).toBe(false);

    // Hand over / close the story: release, for a claim and for a correction hold
    const a = await draft("l3-release");
    await held(a, take(a));
    await call(who.holder, "POST", `/drafts/${a}/release`);
    expect(await ended(a)).toEqual({ claimedBy: null, claimExpiresAt: null });
    noUpdate(a);
    const b = await postedDraft("l3-release-posted");
    await held(b, correct(b));
    await call(who.holder, "POST", `/drafts/${b}/release`);
    expect(await ended(b)).toEqual({ claimedBy: null, claimExpiresAt: null });
    noUpdate(b);

    // Done on a correction
    const c = await postedDraft("l3-done");
    await held(c, correct(c));
    await call(who.holder, "POST", `/drafts/${c}/correction/done`);
    expect(await ended(c)).toEqual({ claimedBy: null, claimExpiresAt: null });
    noUpdate(c);

    // The hold expiring (a claim, and a correction hold capped at midnight IST): the same record runs out; presence
    // notices on its own, and the worker's sweep (run here by hand) sends draft.released for both kinds
    for (const [id, start] of [[await draft("l3-expired"), take], [await postedDraft("l3-midnight"), correct]] as const) {
      // Shortened in the database before the join (a lease nobody extends), so presence caches the short one
      await held(id, async () => {
        await start(id)();
        await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() + interval '1 second'` }).where(eq(postDrafts.id, id));
      });
      await sleep(1200);
      // Any read of the lock (here a take-over request from someone else) finds it gone
      expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: false, error: "no_holder" });
      expect(await waitFor(watcher, "edit.ended", (d) => d.draftId === id)).toEqual({ draftId: id, userId: uid.holder });
      await releaseExpiredClaims(h.db);
      expect(await ended(id)).toEqual({ claimedBy: null, claimExpiresAt: null });
      noUpdate(id);
    }
  });

  it("L4 presence and edit.state mark a story under correction, so the client can show who is fixing the post", async () => {
    const posted = await postedDraft("l4-posted");
    expect((await call(who.holder, "POST", `/drafts/${posted}/correction`)).status).toBe(200);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    expect(await send(holder, "join", { draftId: posted, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
    await send(watcher, "join", { draftId: posted, mode: "watch" });
    const list = await listSettles(watcher, posted, (p) => p.length === 2);
    expect(list.find((p) => p.userId === uid.holder)).toMatchObject({ mode: "edit", correcting: true });
    expect(list.find((p) => p.userId === uid.watcher)).toMatchObject({ mode: "watch", correcting: false });

    expect(await send(holder, "state", state(posted, "a fix"))).toEqual({ ok: true });
    expect(await waitFor(watcher, "edit.state", (d) => d.draftId === posted)).toMatchObject({ text: "a fix", userId: uid.holder, correcting: true });
    const late = await stream(who.second);
    await send(late, "join", { draftId: posted, mode: "watch" });
    expect(await waitFor(late, "edit.snapshot")).toMatchObject({ text: "a fix", correcting: true });

    // A claim is not a correction
    const id = await draft("l4-claimed");
    await claim(who.holder, id);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    const claimed = await listSettles(watcher, id, (p) => p.length === 2);
    expect(claimed.find((p) => p.userId === uid.holder)).toMatchObject({ mode: "edit", correcting: false });
    expect(await send(holder, "state", state(id, "a draft"))).toEqual({ ok: true });
    expect(await waitFor(watcher, "edit.state", (d) => d.draftId === id)).toMatchObject({ correcting: false });
    await call(who.holder, "POST", `/drafts/${posted}/correction/done`);
  });

  it("N5 the probe: stream headers then the end; same auth; no client, not counted, never replaces a stream", async () => {
    const probe = (s: Session | null, q = "?platform=x&probe=1") => fetch(`${base}/live/stream${q}`, { headers: s ? { cookie: s.cookie } : {} });
    expect((await probe(null)).status).toBe(401);
    expect((await probe(who.holder, "?platform=instagram&probe=1")).status).toBe(403);
    const res = await probe(who.holder);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe("");

    // Eight streams open (the limit); probes on top replace none of them
    const eight = [];
    for (let i = 0; i < 8; i++) eight.push(await stream(who.mover));
    for (let i = 0; i < 3; i++) expect((await probe(who.mover)).status).toBe(200);
    await sleep(150);
    expect(eight.some((c) => c.log.some((l) => l.event === "replaced"))).toBe(false);
    expect(await closes(eight[0]!, 200)).toBe(false);
    // The probe registered no client: a POST quoting nothing it could have handed out still finds only real streams
    const id = await draft("n5");
    expect(await send(eight[7]!, "join", { draftId: id, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    await listSettles(eight[7]!, id, (p) => p.length === 1);
  });

  it("N9 limits stream opens to 10 per person per minute (429 beyond); probes do not count; closing resets nothing", async () => {
    // An app with the real limit
    const limited = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-n9-")), "http://localhost/dev-files"), config }, false);
    await limited.listen({ port: 0, host: "127.0.0.1" });
    const at = `http://127.0.0.1:${(limited.server.address() as AddressInfo).port}`;
    const acs: AbortController[] = [];
    const open = async () => {
      const ac = new AbortController();
      acs.push(ac);
      const res = await fetch(`${at}/live/stream`, { headers: { cookie: who.second.cookie }, signal: ac.signal });
      if (res.status !== 200) await res.text();
      return res.status;
    };
    const probe = async () => {
      const res = await fetch(`${at}/live/stream?probe=1`, { headers: { cookie: who.second.cookie } });
      await res.text();
      return res.status;
    };
    try {
      for (let i = 0; i < 3; i++) expect(await probe()).toBe(200);
      for (let i = 0; i < 10; i++) expect(await open()).toBe(200);
      expect(await open()).toBe(429);
      // Probes still answer, and count for nothing
      expect(await probe()).toBe(200);
      // Every stream closed: the window is kept, so reopening is still refused
      for (const ac of acs) ac.abort();
      await sleep(150);
      expect(await open()).toBe(429);
      // Another person has a window of their own
      const res = await fetch(`${at}/live/stream`, { headers: { cookie: who.watcher.cookie }, signal: (acs[acs.length] = new AbortController()).signal });
      expect(res.status).toBe(200);
    } finally {
      for (const ac of acs) ac.abort();
      await limited.close();
    }
  });

  it("N9 keeps a person's rate windows after their last stream closes, and sweeps them once idle", async () => {
    const hub = new PresenceHub({ db: h.db, log: { warn: () => undefined }, streamOpensPerMin: 2, rateIdleMs: 300, rateSweepMs: 50 });
    const rates = (hub as unknown as { rates: Map<string, unknown> }).rates;
    try {
      const user = { id: uid.second!, orgId, name: "Second", platformScoped: true, platforms: ["x"] } as unknown as LiveClient["user"];
      const mk = (): LiveClient => ({ id: crypto.randomUUID(), user, sessionId: "s", platform: "x", send: () => undefined, lagging: () => false, close: () => undefined });
      expect(hub.allowOpen(user)).toBe(true);
      const a = mk();
      hub.connect(a);
      expect(hub.allowOpen(user)).toBe(true);
      const b = mk();
      hub.connect(b);
      expect(hub.allowOpen(user)).toBe(false);
      hub.disconnect(a.id);
      hub.disconnect(b.id);
      // Not deleted on close: the open limit still holds
      expect(rates.has(uid.second!)).toBe(true);
      expect(hub.allowOpen(user)).toBe(false);
      await sleep(150);
      expect(rates.has(uid.second!)).toBe(true);
      // Idle past rateIdleMs: the sweep drops them
      await sleep(400);
      expect(rates.has(uid.second!)).toBe(false);
      // A person with an open stream is never swept
      const c = mk();
      hub.connect(c);
      await sleep(450);
      expect(rates.has(uid.second!)).toBe(true);
      hub.disconnect(c.id);
    } finally {
      hub.close();
    }
  });

  it("N11 the session re-check closes a stream whose user's permissions changed (no event), and only that one", async () => {
    const changed = await stream(who.mover);
    const bystander = await stream(who.watcher);
    // A stream re-opened after the change carries the new permissions and stays open
    await h.db.insert(userPermissionOverrides).values({ userId: uid.mover!, permission: "draft.card", allowed: false });
    try {
      expect(await closes(changed)).toBe(true);
      const reopened = await stream(who.mover);
      expect(await closes(reopened, 600)).toBe(false);
      expect(await closes(bystander, 100)).toBe(false);
    } finally {
      await h.db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, uid.mover!));
    }
  });

  it("N10 answers pending and cooldown from memory, before any database read", async () => {
    let reads = 0;
    let mayCalls = 0;
    const counting = new Proxy(h.db, {
      get(target, prop, recv) {
        if (prop === "select") reads++;
        return Reflect.get(target, prop, recv);
      },
    }) as Db;
    const hub = new PresenceHub({
      db: counting, log: { warn: () => undefined }, takeoverCooldownMs: 60_000,
      mayTakeOver: async () => (mayCalls++, true),
    });
    try {
      const id = await draft("n10");
      await claim(who.holder, id);
      const mk = (name: string, userId: string): LiveClient => ({
        id: crypto.randomUUID(), user: { id: userId, orgId, name, platformScoped: true, platforms: ["x"] } as unknown as LiveClient["user"],
        sessionId: name, platform: "x", send: () => undefined, lagging: () => false, close: () => undefined,
      });
      const holder = mk("holder", uid.holder!);
      const asker = mk("watcher", uid.watcher!);
      hub.connect(holder);
      hub.connect(asker);
      await hub.join(holder.id, { draftId: id, mode: "edit" });
      await hub.join(asker.id, { draftId: id, mode: "watch" });
      expect(await hub.takeoverRequest(asker.id, { draftId: id })).toEqual({ ok: true });
      expect(mayCalls).toBe(1);

      // Waiting for the answer: pending, with no read
      let before = reads;
      expect(await hub.takeoverRequest(asker.id, { draftId: id })).toEqual({ ok: false, error: "pending" });
      expect([reads - before, mayCalls]).toEqual([0, 1]);

      // Answered: the cooldown, with no read, even with the cached lease run out (which would otherwise read the lock)
      expect(await hub.takeoverAnswer(holder.id, { draftId: id, requesterId: uid.watcher, accept: false })).toEqual({ ok: true });
      await sleep(1100);
      (hub as unknown as { drafts: Map<string, { holder: { expiresAt: number } }> }).drafts.get(id)!.holder.expiresAt = Date.now() - 1;
      before = reads;
      expect(await hub.takeoverRequest(asker.id, { draftId: id })).toEqual({ ok: false, error: "cooldown" });
      expect([reads - before, mayCalls]).toEqual([0, 1]);
    } finally {
      hub.close();
    }
  });

  it("counts a lock only in a held status (claimed, or published under a correction hold)", async () => {
    const id = await draft("not-held");
    // claimed_by left on a draft that is not claimed: no hold
    await h.db.update(postDrafts).set({ claimedBy: uid.holder!, claimExpiresAt: sql`now() + interval '5 minutes'` }).where(eq(postDrafts.id, id));
    const holder = await stream(who.holder);
    expect(await send(holder, "join", { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "watch" });
    expect(await send(holder, "state", state(id, "x"))).toEqual({ ok: false, error: "not_holder" });
  });

  it("counts state, join, leave, take-over request and answer per person, across all their streams", async () => {
    const id = await draft("per-person");
    await claim(who.holder, id);
    const a = await stream(who.holder);
    const b = await stream(who.holder);
    await send(a, "join", { draftId: id, mode: "edit" });
    await send(b, "join", { draftId: id, mode: "edit" });
    await sleep(1100);
    const states = await Promise.all([a, b, a, b, a, b, a, b].map((c, i) => post(c, "state", state(id, `t${i}`, i))));
    expect(states.filter((r) => r.body.ok)).toHaveLength(6);
    expect(states.filter((r) => r.status === 429)).toHaveLength(2);
    const joins = await Promise.all(Array.from({ length: 12 }, (_, i) => post(i % 2 ? a : b, "join", { draftId: id, mode: "edit" })));
    expect(joins.filter((r) => r.body.ok)).toHaveLength(10);
    expect(joins.filter((r) => r.status === 429)).toHaveLength(2);
    const other = "00000000-0000-4000-8000-000000000000";
    const leaves = await Promise.all(Array.from({ length: 12 }, (_, i) => post(i % 2 ? a : b, "leave", { draftId: other })));
    expect(leaves.filter((r) => r.body.ok)).toHaveLength(10);
    expect(leaves.filter((r) => r.status === 429)).toHaveLength(2);
    const answers = await Promise.all(Array.from({ length: 7 }, (_, i) => post(i % 2 ? a : b, "takeover/answer", { draftId: id, requesterId: uid.second, accept: false })));
    expect(answers.filter((r) => r.body.error === "no_request")).toHaveLength(5);
    expect(answers.filter((r) => r.status === 429)).toHaveLength(2);

    const w1 = await stream(who.watcher);
    const w2 = await stream(who.watcher);
    await send(w1, "join", { draftId: id, mode: "watch" });
    await send(w2, "join", { draftId: id, mode: "watch" });
    await sleep(1100);
    const asks = await Promise.all([w1, w2, w1, w2, w1].map((c) => post(c, "takeover/request", { draftId: id })));
    expect(asks.filter((r) => r.body.error === "rate_limited")).toHaveLength(2);
    // Of the three let through: one request reaches the holder, the others find it still waiting
    expect(asks.filter((r) => r.body.ok)).toHaveLength(1);
    expect(asks.filter((r) => r.body.error === "pending")).toHaveLength(2);
  });

  it("refuses control characters in the text, other than newline and tab", async () => {
    const id = await draft("control");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    await send(holder, "join", { draftId: id, mode: "edit" });
    for (const bad of ["a\u0007b", "a\rb", "a\u001bb", "a\u007fb", "a\u0085b", "\u0000"]) {
      expect(await post(holder, "state", state(id, bad))).toEqual({ status: 400, body: { ok: false, error: "bad_request" } });
    }
    expect(await send(holder, "state", state(id, "line one\n\tline two"))).toEqual({ ok: true });
  });

  it("notices a cached lease that ran out with no event, and one extended with no event", async () => {
    const id = await draft("lapsed");
    await claim(who.holder, id);
    // Shortened in the database directly: no event
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() + interval '1.5 seconds'` }).where(eq(postDrafts.id, id));
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    expect((await send(holder, "join", { draftId: id, mode: "edit" })).mode).toBe("edit");
    await send(watcher, "join", { draftId: id, mode: "watch" });
    expect(await send(holder, "state", state(id, "while held"))).toEqual({ ok: true });
    await sleep(1700);
    // The take-over request reads the lock again: nobody holds it now
    expect(await send(watcher, "takeover/request", { draftId: id })).toEqual({ ok: false, error: "no_holder" });
    expect(await waitFor(watcher, "edit.ended")).toEqual({ draftId: id, userId: uid.holder });
    expect(await send(holder, "state", state(id, "after"))).toEqual({ ok: false, error: "not_holder" });

    // Extended in the database with no event (as a heartbeat does): still the holder after the cached time
    const id2 = await draft("extended");
    await claim(who.holder, id2);
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() + interval '1.5 seconds'` }).where(eq(postDrafts.id, id2));
    expect((await send(holder, "join", { draftId: id2, mode: "edit" })).mode).toBe("edit");
    await h.db.update(postDrafts).set({ claimExpiresAt: sql`now() + interval '5 minutes'` }).where(eq(postDrafts.id, id2));
    await sleep(1700);
    expect(await send(holder, "state", state(id2, "still mine"))).toEqual({ ok: true });
  });

  it("switches mode on the same story without a leave", async () => {
    const id = await draft("switch");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    await send(holder, "state", state(id, "editing"));
    await waitFor(watcher, "edit.state");
    expect(await send(holder, "join", { draftId: id, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    expect(await waitFor(watcher, "edit.ended")).toEqual({ draftId: id, userId: uid.holder });
    await listSettles(watcher, id, (p) => p.length === 2 && p.find((x) => x.userId === uid.holder)?.mode === "watch");
    expect(await send(holder, "join", { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
    await listSettles(watcher, id, (p) => p.length === 2 && p.find((x) => x.userId === uid.holder)?.mode === "edit");
  });

  it("lets a stream join only its own platform's stories", async () => {
    const insta = await draft("insta", "instagram");
    const xStream = await stream(who.admin);
    expect(await post(xStream, "join", { draftId: insta, mode: "watch" })).toEqual({ status: 404, body: { ok: false, error: "not_found" } });
    const instaStream = await stream(who.admin, "?platform=instagram");
    expect(await send(instaStream, "join", { draftId: insta, mode: "watch" })).toEqual({ ok: true, mode: "watch" });
    await listSettles(instaStream, insta, (p) => p.length === 1);
    // The X streams never list it
    const watcher = await stream(who.watcher);
    await sleep(80);
    expect(watcher.log.filter((l) => l.event === "presence.list").every((l) => !l.data.stories[insta])).toBe(true);
    expect(xStream.log.filter((l) => l.event === "presence.list").every((l) => !l.data.stories[insta])).toBe(true);
  });

  it("closes streams on access.changed, and on the session re-check (session gone, platforms changed)", async () => {
    const byEvent = await stream(who.mover);
    const bystander = await stream(who.watcher);
    await notify(h.db, orgId, { type: "access.changed", userIds: [uid.mover!] });
    expect(await closes(byEvent)).toBe(true);
    expect(await closes(bystander, 300)).toBe(false);

    // A session deleted with no event: the re-check (200 ms here) closes its stream
    const temp: Session = { cookie: "", csrf: "" };
    await signIn(temp, "mover@test");
    const doomed = await stream(temp);
    const kept = await stream(who.mover);
    const [row] = await h.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, uid.mover!)).orderBy(sql`${sessions.createdAt} DESC`).limit(1);
    await h.db.delete(sessions).where(eq(sessions.id, row!.id));
    expect(await closes(doomed)).toBe(true);
    expect(await closes(kept, 500)).toBe(false);

    // The user's platforms changed with no event: closed, to reopen under the new ones
    await h.db.update(users).set({ platforms: ["x", "instagram"] }).where(eq(users.id, uid.mover!));
    try {
      expect(await closes(kept)).toBe(true);
    } finally {
      await h.db.update(users).set({ platforms: ["x"] }).where(eq(users.id, uid.mover!));
    }
  });

  it("re-reads every tracked lock after the event listener reconnects", async () => {
    const id = await draft("resync-holder");
    await claim(who.holder, id);
    const holder = await stream(who.holder);
    const watcher = await stream(who.watcher);
    await send(holder, "join", { draftId: id, mode: "edit" });
    await send(watcher, "join", { draftId: id, mode: "watch" });
    // Released in the database with no event, then the listener drops and comes back
    await h.db.update(postDrafts).set({ status: "ready", claimedBy: null, claimExpiresAt: null }).where(eq(postDrafts.id, id));
    await h.db.execute(sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN%' AND pid <> pg_backend_pid()`);
    expect(await waitFor(watcher, "edit.ended", () => true, 0, 8000)).toEqual({ draftId: id, userId: uid.holder });
  }, 15_000);

  describe("the presence core on its own", () => {
    const log = { warn: () => undefined };
    function fake(name: keyof typeof who) {
      const got: Logged[] = [];
      let lag = false;
      const user = { id: uid[name]!, orgId, name, platformScoped: true, platforms: ["x"] } as unknown as LiveClient["user"];
      const client: LiveClient = {
        id: crypto.randomUUID(), user, sessionId: name, platform: "x",
        send: (event, data) => got.push({ event, data }), lagging: () => lag, close: () => undefined,
      };
      return { client, got, setLag: (v: boolean) => (lag = v) };
    }

    it("re-reads a lock that changed while a read was in flight", async () => {
      // Each read runs at once but answers 150 ms late
      const slow = {
        select: (f: never) => ({ from: (t: never) => ({ where: (w: never) => h.db.select(f).from(t).where(w).then(async (r) => (await sleep(150), r)) }) }),
      } as unknown as Db;
      const hub = new PresenceHub({ db: slow, log });
      try {
        const id = await draft("dirty");
        await claim(who.holder, id);
        const w = fake("watcher");
        hub.connect(w.client);
        await hub.join(w.client.id, { draftId: id, mode: "watch" });
        hub.onEvent(orgId, { type: "draft.updated", draftId: id });
        await sleep(30);
        // The lock moves after the first read began; its event arrives while that read is in flight
        await h.db.update(postDrafts).set({ claimedBy: uid.second! }).where(eq(postDrafts.id, id));
        hub.onEvent(orgId, { type: "draft.claimed", draftId: id });
        await sleep(500);
        expect(w.got.filter((l) => l.event === "edit.ended")).toEqual([{ event: "edit.ended", data: { draftId: id, userId: uid.holder } }]);
      } finally {
        hub.close();
      }
    });

    it("skips live text for a watcher far behind, and caps the encoded size", async () => {
      const hub = new PresenceHub({ db: h.db, log, maxStateBytes: 400 });
      try {
        const id = await draft("lagging");
        await claim(who.holder, id);
        const holder = fake("holder");
        const w = fake("watcher");
        hub.connect(holder.client);
        hub.connect(w.client);
        expect(await hub.join(holder.client.id, { draftId: id, mode: "edit" })).toEqual({ ok: true, mode: "edit" });
        await hub.join(w.client.id, { draftId: id, mode: "watch" });
        w.setLag(true);
        const s1 = { draftId: id, text: "one", selStart: 0, selEnd: 0, version: 1 };
        expect(await hub.state(holder.client.id, s1)).toEqual({ ok: true });
        expect(w.got.some((l) => l.event === "edit.state")).toBe(false);
        w.setLag(false);
        expect(await hub.state(holder.client.id, { ...s1, text: "two", version: 2 })).toEqual({ ok: true });
        expect(w.got.filter((l) => l.event === "edit.state").map((l) => l.data.text)).toEqual(["two"]);
        // 200 Devanagari characters are 600 bytes in UTF-8: over this hub's 400
        expect(await hub.state(holder.client.id, { ...s1, text: "क".repeat(200), version: 3 })).toEqual({ ok: false, error: "too_long" });
        expect(w.got.filter((l) => l.event === "edit.state")).toHaveLength(1);
      } finally {
        hub.close();
      }
    });

    it("frames only plain event names", () => {
      expect(sseFrame("edit.state", { a: 1 })).toBe('event: edit.state\ndata: {"a":1}\n\n');
      expect(sseFrame("presence.list", {})).not.toBeNull();
      for (const bad of ["", "Edit", "a\nb", "a b", "a:b", "x\r", "1a", "a-b"]) expect(sseFrame(bad, {})).toBeNull();
    });
  });
});
