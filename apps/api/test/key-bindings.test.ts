// Per-user keyboard shortcuts: GET /me prefs.keyBindings and PUT /me/key-bindings (strict body, clash check,
// own row only, audit with counts, reset). The pure clash helper is checked without a database.
// The API part needs TEST_DATABASE_URL (a throwaway database: it is wiped).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog, createDb, orgs, runMigrations, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { findClashes, invalidBindings, readKeyBindings } from "../src/key-bindings";

const URL = process.env.TEST_DATABASE_URL;
const SETTINGS = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

describe("key binding helpers", () => {
  it("finds clashes, treating mod as ctrl or meta and modifier order as irrelevant", () => {
    expect(findClashes({ "desk.next": ["j"], "desk.prev": ["k"] })).toEqual([]);
    expect(findClashes({ "desk.next": ["j"], "desk.prev": ["k", "j"] })).toEqual([{ combos: ["j"], actions: ["desk.next", "desk.prev"] }]);
    expect(findClashes({ a: ["mod+k"], b: ["ctrl+k"] })).toEqual([{ combos: ["ctrl+k", "mod+k"], actions: ["a", "b"] }]);
    expect(findClashes({ a: ["shift+mod+k"], b: ["mod+shift+k"] })).toHaveLength(1);
    expect(findClashes({ a: ["shift+k"], b: ["k"], c: [] })).toEqual([]);
  });

  it("refuses a doubled modifier or a combo listed twice in one action", () => {
    expect(invalidBindings({ a: ["shift+shift+k"] })).toMatch(/modifier twice/);
    expect(invalidBindings({ a: ["mod+k", "mod+k"] })).toMatch(/listed twice/);
    expect(invalidBindings({ a: ["mod+k", "ctrl+k"] })).toBeNull();
  });

  it("reads {} for unset or malformed prefs", () => {
    expect(readKeyBindings({})).toEqual({});
    expect(readKeyBindings(null)).toEqual({});
    expect(readKeyBindings({ keyBindings: "j" })).toEqual({});
    expect(readKeyBindings({ keyBindings: { "Bad Id": ["j"] } })).toEqual({});
    expect(readKeyBindings({ keyBindings: { "desk.next": ["j"] }, theme: "dark" })).toEqual({ "desk.next": ["j"] });
  });
});

(URL ? describe : describe.skip)("PUT /me/key-bindings", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  const priya = { cookie: "", csrf: "", id: "" };
  const amit = { cookie: "", csrf: "", id: "" };
  type Who = typeof priya;

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 7).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(who: Who | null, method: string, url: string, payload?: unknown, csrf = true) {
    const headers = who ? { cookie: who.cookie, ...(csrf && { "x-csrf": who.csrf }) } : {};
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function login(email: string, into: Who) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    expect(res.statusCode).toBe(200);
    into.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    into.csrf = JSON.parse(res.body).csrfToken;
  }

  const put = (who: Who | null, bindings: unknown) => call(who, "PUT", "/me/key-bindings", { bindings });
  const stored = async (id: string) => (await h.db.select({ prefs: users.prefs }).from(users).where(eq(users.id, id)))[0]!.prefs;

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db.insert(orgs).values({ name: "1st India", settings: SETTINGS }).returning();
    orgId = org!.id;
    const passwordHash = await hashPassword("correct horse battery");
    for (const [who, name, role] of [[priya, "priya", "operator"], [amit, "amit", "viewer"]] as const) {
      const [u] = await h.db.insert(users).values({ orgId, name, email: `${name}@test`, passwordHash, role }).returning();
      who.id = u!.id;
    }
    app = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-keys-")), "http://localhost/dev-files"), config }, false);
    await login("priya@test", priya);
    await login("amit@test", amit);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("migration 0020 gives existing users prefs = {}, and GET /me shows empty keyBindings", async () => {
    expect(await stored(priya.id)).toEqual({});
    const me = await call(priya, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.prefs).toEqual({ keyBindings: {} });
  });

  it("needs a session (401) and the CSRF header (403)", async () => {
    expect((await put(null, {})).status).toBe(401);
    expect((await call(null, "GET", "/me")).status).toBe(401);
    expect((await call(priya, "PUT", "/me/key-bindings", { bindings: {} }, false)).status).toBe(403);
  });

  it("saves the whole map, returns it, and GET /me reads it back; other prefs keys are kept", async () => {
    await h.db.update(users).set({ prefs: sql`'{"theme":"dark"}'::jsonb` }).where(eq(users.id, priya.id));
    const bindings = { "desk.next": ["j", "arrowdown"], "desk.prev": ["k"], "draft.publish": ["mod+enter"], "draft.discard": [], "nav.search": ["/"] };
    const res = await put(priya, bindings);
    expect(res).toEqual({ status: 200, body: { keyBindings: bindings } });
    expect((await call(priya, "GET", "/me")).body.prefs).toEqual({ keyBindings: bindings });
    expect(await stored(priya.id)).toEqual({ theme: "dark", keyBindings: bindings });

    // Replaces wholly: a smaller map drops the rest
    expect((await put(priya, { "desk.next": ["n"] })).body).toEqual({ keyBindings: { "desk.next": ["n"] } });
    expect((await call(priya, "GET", "/me")).body.prefs.keyBindings).toEqual({ "desk.next": ["n"] });
  });

  it("audits user.key_bindings_changed with counts only", async () => {
    const [row] = await h.db.select().from(auditLog)
      .where(and(eq(auditLog.action, "user.key_bindings_changed"), eq(auditLog.entityId, priya.id)))
      .orderBy(desc(auditLog.id)).limit(1);
    expect(row).toMatchObject({ orgId, actorId: priya.id, entityType: "user", before: { actions: 5 }, after: { actions: 1 } });
  });

  it("400 invalid for a bad combo, a bad action id, too many actions or combos, or an extra body key", async () => {
    const bad: unknown[] = [
      { "desk.next": ["J"] },
      { "desk.next": ["ctrl+shift+alt+meta+k"] },
      { "desk.next": ["hyper+k"] },
      { "desk.next": ["arrowdownarrowdown"] },
      { "desk.next": ["ctrl+"] },
      { "desk.next": [""] },
      { "desk.next": ["j", "k", "l"] },
      { "desk.next": "j" },
      { "desk.next": [1] },
      { "Desk.next": ["j"] },
      { "desk..next": ["j"] },
      { "desk.next.": ["j"] },
      { "1desk": ["j"] },
      { ["a".repeat(41)]: ["j"] },
      { "desk.next": ["shift+shift+j"] },
      { "desk.next": ["j", "j"] },
      Object.fromEntries(Array.from({ length: 81 }, (_, i) => [`a${i}`, []])),
      [],
      null,
    ];
    for (const b of bad) {
      const res = await put(priya, b);
      expect({ b, status: res.status, error: res.body.error }).toEqual({ b, status: 400, error: "invalid" });
    }
    const extra = await call(priya, "PUT", "/me/key-bindings", { bindings: {}, userId: amit.id });
    expect(extra).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect((await call(priya, "PUT", "/me/key-bindings", {})).status).toBe(400);
    // Nothing changed
    expect((await call(priya, "GET", "/me")).body.prefs.keyBindings).toEqual({ "desk.next": ["n"] });
  });

  it("accepts the edges: 80 actions, a 40-character id, 3 modifiers, punctuation keys", async () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`a${i}`, []]));
    expect((await put(priya, many)).status).toBe(200);
    const edge = { ["a".repeat(40)]: ["ctrl+alt+shift+k"], "x.y.z": ["[", "]"], b: ["\\", "`"], c: ["'", ";"], d: ["-", "="], e: [",", "."] };
    expect(await put(priya, edge)).toEqual({ status: 200, body: { keyBindings: edge } });
  });

  it("400 key_clash naming the actions when two actions share a combo (mod counts as ctrl)", async () => {
    const res = await put(priya, { "desk.next": ["j"], "desk.prev": ["k", "j"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("key_clash");
    expect(res.body.message).toContain("desk.next");
    expect(res.body.message).toContain("desk.prev");
    const mod = await put(priya, { "draft.publish": ["mod+enter"], "draft.save": ["ctrl+enter"] });
    expect(mod).toMatchObject({ status: 400, body: { error: "key_clash" } });
    expect(mod.body.message).toMatch(/draft\.publish and draft\.save/);
  });

  it("only touches the caller's own row", async () => {
    await put(amit, { "desk.next": ["x"] });
    await put(priya, { "desk.next": ["p"] });
    expect((await call(amit, "GET", "/me")).body.prefs.keyBindings).toEqual({ "desk.next": ["x"] });
    expect((await call(priya, "GET", "/me")).body.prefs.keyBindings).toEqual({ "desk.next": ["p"] });
  });

  it("{ bindings: {} } resets to the desk defaults", async () => {
    expect(await put(priya, {})).toEqual({ status: 200, body: { keyBindings: {} } });
    expect((await call(priya, "GET", "/me")).body.prefs).toEqual({ keyBindings: {} });
    expect(await stored(priya.id)).toEqual({ theme: "dark", keyBindings: {} });
    expect((await call(amit, "GET", "/me")).body.prefs.keyBindings).toEqual({ "desk.next": ["x"] });
  });

  it("rate-limits saves per user (429 after 30 a minute)", async () => {
    let status = 200;
    for (let i = 0; i < 40 && status === 200; i++) status = (await put(amit, { "desk.next": ["x"] })).status;
    expect(status).toBe(429);
    // Another user is not affected
    expect((await put(priya, {})).status).toBe(200);
  });
});
