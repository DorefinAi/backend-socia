// The API end to end on a real Postgres: sign-in with TOTP, CSRF, the operator path, roles, and
// a live event over Socket.IO. Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { totpCode } from "@socia/core";
import { createDb, ingestedFiles, orgs, postDrafts, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage, encryptSecret } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { io as connect } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { attachRealtime } from "../src/realtime";

const URL = process.env.TEST_DATABASE_URL;
const SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
const AMIT_TOTP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

type App = Awaited<ReturnType<typeof buildApp>>;

interface Client {
  cookie: string;
  csrf: string;
}

(URL ? describe : describe.skip)("API", () => {
  let h: DbHandle;
  let app: App;
  let draftId: string;
  let orgId: string;

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3000"], cookieSecure: false, sessionHours: 12, requireTotp: true, secretKey: SECRET_KEY, storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(client: Client | null, method: string, url: string, payload?: unknown, csrf = true) {
    const res = await app.inject({
      method: method as "GET",
      url,
      payload: payload as Record<string, unknown>,
      headers: { ...(client && { cookie: client.cookie }), ...(client && csrf && { "x-csrf": client.csrf }) },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }

  /**
   * The current code, unused: each code works once (replay guard), and in real life these sign-ins would be
   * at least one 30 s step apart, so the user's last used step is cleared first.
   */
  async function freshCode(email: string, secret: string): Promise<string> {
    await h.db.update(users).set({ totpLastStep: null }).where(eq(users.email, email));
    return totpCode(secret, new Date());
  }

  async function login(email: string): Promise<Client & { next: string }> {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const body = JSON.parse(res.body);
    return { cookie, csrf: body.csrfToken, next: body.next };
  }

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
      { orgId, name: "Priya", email: "priya@test", passwordHash, role: "operator" },
      { orgId, name: "Amit", email: "amit@test", passwordHash, role: "operator", totpEnabled: true, totpSecretEnc: encryptSecret(AMIT_TOTP, SECRET_KEY) },
      { orgId, name: "Editor", email: "editor@test", passwordHash, role: "editor", totpEnabled: true, totpSecretEnc: encryptSecret(AMIT_TOTP, SECRET_KEY) },
    ]);

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-api-")), "http://localhost/dev-files");
    await store.put("cards/a.png", new Uint8Array([137, 80, 78, 71]), "image/png");
    const [file] = await h.db.insert(ingestedFiles).values({ orgId, sha256: "a", sourcePath: "/a.txt", fileName: "a.txt", bytes: 1, storageKey: "raw/a", kind: "text", slug: "jpr_metro" }).returning();
    const [story] = await h.db.insert(stories).values({ orgId, fileId: file!.id, slug: "jpr_metro", status: "composed", headline: "जयपुर मेट्रो को मंजूरी", body: "", conversionConfidence: 0.99 }).returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: story!.id, status: "ready", bodyText: "जयपुर मेट्रो को मंजूरी", cardHeadline: "जयपुर मेट्रो को मंजूरी", hashtags: ["#Jaipur"], composeVersion: "t", cardRenderedRev: 1, cardKey: "cards/a.png" })
      .returning();
    draftId = draft!.id;

    app = await buildApp({ db: h.db, storage: store, config }, false);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("refuses everything until two-step sign-in is set up", async () => {
    expect((await call(null, "GET", "/me")).status).toBe(401);
    expect((await call(null, "POST", "/auth/login", { email: "priya@test", password: "wrong" })).body.error).toBe("bad_login");

    const priya = await login("priya@test");
    expect(priya.next).toBe("totp_setup");
    expect((await call(priya, "GET", "/x/queue")).body.error).toBe("totp_setup_required");

    const setup = await call(priya, "POST", "/auth/totp/setup");
    expect(setup.body.otpauthUri).toContain("otpauth://totp/Socia");
    expect((await call(priya, "POST", "/auth/totp/enable", { code: "000000" })).status).toBe(401);
    expect((await call(priya, "POST", "/auth/totp/enable", { code: totpCode(setup.body.secret, new Date()) })).status).toBe(200);

    const queue = await call(priya, "GET", "/x/queue");
    expect(queue.status).toBe(200);
    expect(queue.body.items[0]).toMatchObject({ id: draftId, slug: "jpr_metro", cardUrl: "http://localhost/dev-files/cards/a.png" });
    expect(queue.body.cap).toMatchObject({ used: 0, cap: 800, level: "ok" });
  });

  it("runs the operator path, with one holder per draft", async () => {
    const priya = await login("priya@test");
    await call(priya, "POST", "/auth/totp", { code: await freshCode("priya@test", await priyaSecret()) });

    const amit = await login("amit@test");
    expect(amit.next).toBe("totp");
    expect((await call(amit, "POST", "/auth/totp", { code: await freshCode("amit@test", AMIT_TOTP) })).status).toBe(200);

    expect((await call(priya, "POST", `/drafts/${draftId}/claim`, undefined, false)).body.error).toBe("csrf");
    const claimed = await call(priya, "POST", `/drafts/${draftId}/claim`);
    expect(claimed.body.claim).toMatchObject({ name: "Priya", mine: true });
    expect(claimed.body.check).toMatchObject({ problems: [] });

    const blocked = await call(amit, "POST", `/drafts/${draftId}/claim`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: "held_by_other", message: "Priya is working on this." });

    const saved = await call(priya, "PATCH", `/drafts/${draftId}`, { version: claimed.body.version, bodyText: "जयपुर मेट्रो फेज-2 को मंजूरी" });
    expect(saved.body.postText).toBe("जयपुर मेट्रो फेज-2 को मंजूरी\n\n#Jaipur");
    expect((await call(priya, "PATCH", `/drafts/${draftId}`, { version: claimed.body.version, bodyText: "x" })).body.error).toBe("stale_version");

    const check = await call(priya, "POST", "/x/check", { bodyText: "देखें example.com", hashtags: [], mentions: [] });
    expect(check.body.problems[0]).toContain("13 times");

    const approved = await call(priya, "POST", `/drafts/${draftId}/approve`, { version: saved.body.version });
    expect(approved.status).toBe(200);
    expect(new Date(approved.body.sendAt).getTime()).toBeGreaterThan(Date.now() + 7000);

    const undone = await call(priya, "POST", `/jobs/${approved.body.jobId}/undo`);
    expect(undone.body).toMatchObject({ status: "claimed", claim: { mine: true } });

    expect((await call(priya, "POST", `/drafts/${draftId}/reject`, { reason: "duplicate" })).status).toBe(200);
    expect((await call(amit, "POST", `/drafts/${draftId}/restore`)).body.status).toBe("ready");
  });

  it("keeps the library to editors", async () => {
    const priya = await login("priya@test");
    await call(priya, "POST", "/auth/totp", { code: await freshCode("priya@test", await priyaSecret()) });
    const rule = { matchType: "city", name: "जयपुर", aliases: ["Jaipur"], hashtagLatin: "Jaipur", hashtagDevanagari: "जयपुर", priority: 5 };
    expect((await call(priya, "POST", "/hashtag-rules", rule)).status).toBe(403);

    const editor = await login("editor@test");
    await call(editor, "POST", "/auth/totp", { code: await freshCode("editor@test", AMIT_TOTP) });
    expect((await call(editor, "POST", "/hashtag-rules", rule)).status).toBe(200);
    const handle = await call(editor, "POST", "/handles", { entityName: "जयपुर विकास प्राधिकरण", aliases: ["JDA"], handle: "@JDAJaipur", priority: 1 });
    expect(handle.body.handle).toBe("JDAJaipur");
    expect((await call(priya, "GET", "/handles?q=JDA")).body.items).toHaveLength(1);
    expect((await call(priya, "GET", "/drafts/not-a-uuid")).status).toBe(400);
  });

  it("pushes a claim to other operators' screens", async () => {
    const amit = await login("amit@test");
    await call(amit, "POST", "/auth/totp", { code: await freshCode("amit@test", AMIT_TOTP) });
    const priya = await login("priya@test");
    await call(priya, "POST", "/auth/totp", { code: await freshCode("priya@test", await priyaSecret()) });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const stop = attachRealtime(app.server, { db: h.db, databaseUrl: URL!, corsOrigins: config.corsOrigins, log: app.log });
    const address = app.server.address() as { port: number };
    const socket = connect(`http://127.0.0.1:${address.port}`, { extraHeaders: { cookie: amit.cookie }, transports: ["websocket"] });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("connect_error", reject);
      });
      await new Promise((r) => setTimeout(r, 300)); // listener up
      const event = new Promise<{ draftId: string; name: string }>((resolve) => socket.on("draft.claimed", resolve));
      await call(priya, "POST", `/drafts/${draftId}/claim`);
      expect(await event).toMatchObject({ draftId, name: "Priya" });
    } finally {
      socket.close();
      await stop();
    }
  });

  async function priyaSecret(): Promise<string> {
    const { decryptSecret } = await import("@socia/providers");
    const [u] = await h.db.select().from(users).where(sql`${users.email} = 'priya@test'`);
    return decryptSecret(u!.totpSecretEnc!, SECRET_KEY);
  }
});
