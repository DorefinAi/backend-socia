// The owner console's API on a real Postgres (contract: handoff/owner-console-contract.md §2, §4).
// Needs TEST_DATABASE_URL (the database is wiped).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSION_KEYS } from "@socia/core";
import { auditLog, createDb, orgs, runMigrations, sessions, userPermissionOverrides, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { desc, eq, sql } from "drizzle-orm";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { ownerKeyFrom, type ApiConfig } from "../src/config";
import { attachRealtime } from "../src/realtime";

const URL = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";
const KEY = "k".repeat(40);

type App = Awaited<ReturnType<typeof buildApp>>;
interface Client {
  cookie: string;
  csrf: string;
}

(URL ? describe : describe.skip)("owner API", () => {
  let h: DbHandle;
  let app: App;
  let orgId = "";
  const ids: Record<string, string> = {};
  const extraApps: App[] = [];

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3006"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, ownerApiKey: KEY,
  };
  const storage = async () => new LocalStorage(await mkdtemp(join(tmpdir(), "socia-owner-")), "http://localhost/dev-files");
  const appWith = async (extra: Partial<ApiConfig>, ownerLimits?: { failuresPerIp: number; windowMs: number }) => {
    const a = await buildApp({ db: h.db, storage: await storage(), config: { ...config, ...extra }, ownerLimits }, false);
    extraApps.push(a);
    return a;
  };

  /** An owner request: the key and actor by default, either can be overridden or left out (null) */
  async function owner(
    method: string,
    url: string,
    payload?: unknown,
    opts: { key?: string | null; actor?: string | null; target?: App; remoteAddress?: string } = {},
  ) {
    const key = opts.key === undefined ? KEY : opts.key;
    const actor = opts.actor === undefined ? "vansh" : opts.actor;
    const res = await (opts.target ?? app).inject({
      method: method as "GET",
      url,
      payload: payload as Record<string, unknown>,
      headers: { ...(key !== null && { authorization: `Bearer ${key}` }), ...(actor !== null && { "x-owner-actor": actor }) },
      ...(opts.remoteAddress && { remoteAddress: opts.remoteAddress }),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }

  async function call(client: Client, method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers: { cookie: client.cookie, "x-csrf": client.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function login(email: string): Promise<Client> {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, csrf: JSON.parse(res.body).csrfToken };
  }

  const sessionCount = async (userId: string) => (await h.db.select().from(sessions).where(eq(sessions.userId, userId))).length;
  const userRow = async (userId: string) => (await h.db.select().from(users).where(eq(users.id, userId)))[0]!;
  const lastAudit = async () => (await h.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]!;

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    const passwordHash = await hashPassword(PASSWORD);
    for (const [k, name, role] of [["admin", "Asha", "admin"], ["editor", "Ed", "editor"], ["viewer", "View", "viewer"]] as const) {
      const [u] = await h.db.insert(users).values({ orgId, name, email: `${k}@test`, passwordHash, role }).returning();
      ids[k] = u!.id;
    }
    app = await buildApp({ db: h.db, storage: await storage(), config }, false);
  }, 60_000);

  afterAll(async () => {
    for (const a of extraApps) await a.close();
    await app?.close();
    await h?.close();
  });

  // ─── Auth ──────────────────────────────────────────────────────────────────

  it("does not exist without OWNER_API_KEY, or with one under 32 characters", async () => {
    expect(ownerKeyFrom(undefined)).toBeNull();
    expect(ownerKeyFrom("x".repeat(31))).toBeNull();
    expect(ownerKeyFrom(` ${"x".repeat(32)} `)).toBe("x".repeat(32));
    for (const ownerApiKey of [undefined, null, "", "short-key"]) {
      const off = await appWith({ ownerApiKey });
      for (const [method, url] of [["GET", "/owner/people"], ["GET", "/owner/history"], ["PATCH", `/owner/people/${ids.viewer}`]]) {
        expect((await owner(method!, url!, method === "PATCH" ? { active: false } : undefined, { target: off, key: ownerApiKey ?? "x" })).status).toBe(404);
      }
    }
    expect((await userRow(ids.viewer!)).active).toBe(true);
  });

  it("needs the bearer key (401) and an X-Owner-Actor (400)", async () => {
    for (const key of [null, "", "k".repeat(39), "k".repeat(41), `${KEY.slice(0, -1)}x`]) {
      const res = await owner("GET", "/owner/people", undefined, { key });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("unauthorized");
    }
    // The key is checked before the body: a bad body without the key is still a 401
    expect((await owner("PATCH", `/owner/people/${ids.viewer}`, { nope: 1 }, { key: null })).status).toBe(401);
    // A cookie session is no substitute
    const admin = await login("admin@test");
    expect((await call(admin, "GET", "/owner/people")).status).toBe(401);
    for (const actor of [null, "", "Vansh", "vansh smith", "a".repeat(65), "owner:vansh"]) {
      const res = await owner("GET", "/owner/people", undefined, { actor });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_actor");
    }
    expect((await owner("GET", "/owner/people", undefined, { actor: "a.b_c-1" })).status).toBe(200);
  });

  it("rate limits wrong keys per IP (429); a valid key always passes", async () => {
    const limited = await appWith({}, { failuresPerIp: 3, windowMs: 60_000 });
    const from = (remoteAddress: string, key: string | null = KEY) => owner("GET", "/owner/people", undefined, { target: limited, remoteAddress, key });
    for (let i = 0; i < 5; i++) expect((await from("10.0.0.1")).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await from("10.0.0.2", "wrong")).status).toBe(401);
    const blocked = await from("10.0.0.2", "wrong");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect((await from("10.0.0.2", null)).status).toBe(429);
    // Over the limit the right key still works (someone sharing the IP cannot lock the console out)...
    expect((await from("10.0.0.2")).status).toBe(200);
    // ...and does not reset the count; another IP is not affected
    expect((await from("10.0.0.2", "wrong")).status).toBe(429);
    expect((await from("10.0.0.3", "wrong")).status).toBe(401);
  });

  // ─── Reads ─────────────────────────────────────────────────────────────────

  it("GET /owner/people lists everyone with roles and the catalogue", async () => {
    await h.db.insert(userPermissionOverrides).values({ userId: ids.viewer!, permission: "trends.refresh", allowed: true });
    const res = await owner("GET", "/owner/people");
    expect(res.status).toBe(200);
    expect(res.body.system).toBe("socia");
    expect(res.body.catalogue).toHaveLength(PERMISSION_KEYS.length);
    expect(res.body.catalogue[0]).toEqual({ key: "page.dashboard", group: "pages", label: "Dashboard", description: expect.any(String) });
    expect(res.body.roles).toEqual([
      { key: "admin", label: "Admin" }, { key: "editor", label: "Chief Editor" }, { key: "operator", label: "Digital Team" }, { key: "viewer", label: "Viewer" },
    ]);
    expect(res.body.users.map((u: { name: string }) => u.name)).toEqual(["Asha", "Ed", "View"]);
    const asha = res.body.users[0];
    expect(Object.keys(asha).sort()).toEqual(["active", "email", "id", "lastLoginAt", "name", "overrides", "role", "roleLabel", "username"]);
    expect(asha).toMatchObject({ id: ids.admin, username: null, name: "Asha", email: "admin@test", role: "admin", roleLabel: "Admin", active: true, overrides: [] });
    expect(typeof asha.lastLoginAt).toBe("string"); // signed in above
    expect(res.body.users[2]).toMatchObject({ lastLoginAt: null, overrides: [{ permission: "trends.refresh", allowed: true }] });
  });

  it("GET /owner/people/:id/permissions gives each key with its source", async () => {
    const res = await owner("GET", `/owner/people/${ids.viewer!.toUpperCase()}/permissions`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("viewer");
    expect(res.body.permissions).toHaveLength(PERMISSION_KEYS.length);
    expect(res.body.permissions.find((p: { key: string }) => p.key === "trends.refresh")).toMatchObject({ allowed: true, source: "override" });
    expect(res.body.permissions.find((p: { key: string }) => p.key === "post.publish")).toMatchObject({ allowed: false, source: "role" });
    expect((await owner("GET", "/owner/people/00000000-0000-0000-0000-000000000000/permissions")).status).toBe(404);
    expect((await owner("GET", "/owner/people/not-a-uuid/permissions")).status).toBe(400);
  });

  // ─── Changes ───────────────────────────────────────────────────────────────

  it("PATCH changes the role without signing out, audited as owner:<name>", async () => {
    const ed = await login("editor@test");
    const res = await owner("PATCH", `/owner/people/${ids.editor}`, { role: "viewer" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: ids.editor, username: null, role: "viewer", roleLabel: "Viewer", active: true });
    expect(await lastAudit()).toMatchObject({ actorId: null, actor: "owner:vansh", action: "user.role_changed", entityType: "user", entityId: ids.editor, before: { role: "editor" }, after: { role: "viewer" } });
    // Still signed in, with the new role's permissions on the next request
    const me = await call(ed, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("viewer");
    expect(me.body.permissions).not.toContain("trends.refresh");
    // Owners are not bound by the desk's own-access rules: they may hand out admin
    expect((await owner("PATCH", `/owner/people/${ids.editor}`, { role: "admin" })).body.user.role).toBe("admin");
    expect((await owner("PATCH", `/owner/people/${ids.editor}`, { role: "editor" })).body.user.role).toBe("editor");
  });

  it("PATCH refuses unknown roles (422), unknown fields (400) and unknown users (404)", async () => {
    const r1 = await owner("PATCH", `/owner/people/${ids.viewer}`, { role: "ghost" });
    expect(r1.status).toBe(422);
    expect(r1.body.error).toBe("unknown_role");
    expect((await owner("PATCH", `/owner/people/${ids.viewer}`, { role: "viewer", name: "X" })).status).toBe(400);
    expect((await owner("PATCH", `/owner/people/${ids.viewer}`, { platforms: ["x"] })).status).toBe(400);
    expect((await owner("PATCH", `/owner/people/${ids.viewer}`, { active: "no" })).status).toBe(400);
    expect((await owner("PATCH", "/owner/people/00000000-0000-0000-0000-000000000000", { active: false })).status).toBe(404);
    expect((await userRow(ids.viewer!)).role).toBe("viewer");
  });

  it("disabling signs the user out everywhere: sessions deleted and sockets dropped (exceptions drop sockets too)", async () => {
    const view = await login("viewer@test");
    await login("viewer@test");
    expect(await sessionCount(ids.viewer!)).toBe(2);
    const live = await appWith({});
    await live.listen({ port: 0, host: "127.0.0.1" });
    const stop = attachRealtime(live.server, { db: h.db, databaseUrl: URL!, corsOrigins: config.corsOrigins, log: live.log });
    const port = (live.server.address() as { port: number }).port;
    const open: Socket[] = [];
    const socketFor = async () => {
      const socket: Socket = connect(`http://127.0.0.1:${port}`, { extraHeaders: { cookie: view.cookie }, transports: ["websocket"], reconnection: false });
      open.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("connect_error", reject);
      });
      return { gone: new Promise<string>((resolve) => socket.on("disconnect", (reason) => resolve(reason))) };
    };
    const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("still connected")), 3000))]);
    try {
      const { gone: first } = await socketFor();
      await new Promise((r) => setTimeout(r, 300)); // listener up
      // Owner exceptions drop the sockets (they rejoin with the new access); the sessions stay
      expect((await owner("PUT", `/owner/people/${ids.viewer}/overrides`, { overrides: [] })).status).toBe(200);
      expect(await within(first)).toBe("io server disconnect");
      expect(await sessionCount(ids.viewer!)).toBe(2);

      const { gone } = await socketFor();
      const res = await owner("PATCH", `/owner/people/${ids.viewer}`, { active: false }, { actor: "aditya" });
      expect(res.status).toBe(200);
      expect(res.body.user.active).toBe(false);
      expect(await sessionCount(ids.viewer!)).toBe(0);
      expect(await within(gone)).toBe("io server disconnect");
      expect((await call(view, "GET", "/me")).status).toBe(401);
      expect(await lastAudit()).toMatchObject({ actorId: null, actor: "owner:aditya", action: "user.deactivated", entityId: ids.viewer });
    } finally {
      for (const socket of open) socket.close();
      await stop();
    }
    const back = await owner("PATCH", `/owner/people/${ids.viewer}`, { active: true });
    expect(back.body.user.active).toBe(true);
    expect((await lastAudit()).action).toBe("user.activated");
  });

  it("keeps the last active admin: no disable, demote or denied users.manage (409, nothing saved)", async () => {
    const before = (await h.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n;
    const disable = await owner("PATCH", `/owner/people/${ids.admin}`, { active: false });
    expect(disable.status).toBe(409);
    expect(disable.body.error).toBe("last_admin");
    expect((await owner("PATCH", `/owner/people/${ids.admin}`, { role: "editor" })).body.error).toBe("last_admin");
    const deny = await owner("PUT", `/owner/people/${ids.admin}/overrides`, { overrides: [{ permission: "users.manage", allowed: false }] });
    expect(deny.status).toBe(409);
    expect(deny.body.error).toBe("last_admin");
    const asha = await userRow(ids.admin!);
    expect([asha.active, asha.role]).toEqual([true, "admin"]);
    expect(await h.db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, ids.admin!))).toEqual([]);
    expect(await sessionCount(ids.admin!)).toBeGreaterThan(0);
    expect((await h.db.select({ n: sql<number>`count(*)::int` }).from(auditLog))[0]!.n).toBe(before);

    // With a second admin (the editor given both keys by exceptions), the first can be demoted
    expect((await owner("PUT", `/owner/people/${ids.editor}/overrides`, { overrides: [{ permission: "users.manage", allowed: true }, { permission: "roles.manage", allowed: true }] })).status).toBe(200);
    expect((await owner("PATCH", `/owner/people/${ids.admin}`, { role: "editor" })).status).toBe(200);
    // ...and now the editor's exceptions are what keeps an admin
    expect((await owner("PUT", `/owner/people/${ids.editor}/overrides`, { overrides: [] })).body.error).toBe("last_admin");
    expect((await owner("PATCH", `/owner/people/${ids.admin}`, { role: "admin" })).status).toBe(200);
    expect((await owner("PUT", `/owner/people/${ids.editor}/overrides`, { overrides: [] })).status).toBe(200);
  });

  it("PUT overrides replaces the set (422 unknown key, [] clears), audited as owner:<name>", async () => {
    const unknown = await owner("PUT", `/owner/people/${ids.viewer}/overrides`, { overrides: [{ permission: "nope.key", allowed: true }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toBe("unknown_permission");
    expect((await owner("PUT", `/owner/people/${ids.viewer}/overrides`, { overrides: [{ permission: "post.publish", allowed: true }, { permission: "post.publish", allowed: false }] })).status).toBe(400);
    expect((await owner("PUT", `/owner/people/${ids.viewer}/overrides`, { overrides: [{ permission: "post.publish", allowed: true, by: "x" }] })).status).toBe(400);
    expect((await owner("PUT", `/owner/people/${ids.viewer}/overrides`, { overrides: [], extra: 1 })).status).toBe(400);

    const set = await owner("PUT", `/owner/people/${ids.viewer}/overrides`, {
      overrides: [{ permission: "post.publish", allowed: true }, { permission: "page.dashboard", allowed: false }],
    });
    expect(set.status).toBe(200);
    expect(set.body.role).toBe("viewer");
    const byKey = new Map(set.body.permissions.map((p: { key: string }) => [p.key, p]));
    expect(byKey.get("post.publish")).toMatchObject({ allowed: true, source: "override" });
    expect(byKey.get("page.dashboard")).toMatchObject({ allowed: false, source: "override" });
    expect(byKey.get("trends.refresh")).toMatchObject({ allowed: false, source: "role" }); // full replace: the earlier one is gone
    const rows = await h.db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, ids.viewer!));
    expect(rows.map((r) => [r.permission, r.allowed, r.setBy]).sort()).toEqual([["page.dashboard", false, null], ["post.publish", true, null]]);
    expect(await lastAudit()).toMatchObject({ actorId: null, actor: "owner:vansh", entityType: "user", entityId: ids.viewer });

    const cleared = await owner("PUT", `/owner/people/${ids.viewer}/overrides`, { overrides: [] });
    expect(cleared.body.permissions.every((p: { source: string }) => p.source === "role")).toBe(true);
    expect(await h.db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, ids.viewer!))).toEqual([]);
  });

  // ─── History ───────────────────────────────────────────────────────────────

  it("GET /owner/history lists owner and admin changes to users, newest first, paged by time", async () => {
    // A desk admin's change appears too, under their name
    const admin = await login("admin@test");
    expect((await call(admin, "PATCH", `/admin/users/${ids.viewer}`, { role: "operator" })).status).toBe(200);

    const res = await owner("GET", "/owner/history?limit=200");
    expect(res.status).toBe(200);
    const entries = res.body.entries as { at: string; actor: string; actorKind: string; action: string; target: { id: string; name: string } }[];
    expect(Object.keys(entries[0]!).sort()).toEqual(["action", "actor", "actorKind", "after", "at", "before", "target"]);
    expect(entries[0]).toMatchObject({
      actor: "Asha", actorKind: "user", action: "user.role_changed", target: { id: ids.viewer, name: "View" }, before: { role: "viewer" }, after: { role: "operator" },
    });
    expect(entries.some((e) => e.actor === "owner:aditya" && e.actorKind === "owner" && e.action === "user.deactivated")).toBe(true);
    expect(entries.some((e) => e.actor === "owner:vansh" && e.actorKind === "owner" && e.action === "user.override_set")).toBe(true);
    expect(res.body.next).toBeNull();
    const times = entries.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    // before=<ISO> still works: strictly older entries
    const older = await owner("GET", `/owner/history?limit=200&before=${encodeURIComponent(entries[1]!.at)}`);
    expect(older.body.entries.length).toBeGreaterThan(0);
    expect(older.body.entries.every((e: { at: string }) => Date.parse(e.at) < Date.parse(entries[1]!.at))).toBe(true);

    for (const q of ["before=yesterday", "before=2026-13-45T00:00:00Z", "limit=0", "limit=201", "other=1", "cursor=nope", `cursor=${Buffer.from("2026-10-30T00:00:00Z|1").toString("base64url")}`, `cursor=${Buffer.from("2026-10-30T00:00:00.000000Z|x").toString("base64url")}`]) {
      expect((await owner("GET", `/owner/history?${q}`)).status).toBe(400);
    }
    expect((await owner("GET", `/owner/history?before=2026-10-30T00:00:00Z&cursor=${Buffer.from("2026-10-30T00:00:00.000000Z|1").toString("base64url")}`)).status).toBe(400);

    // The desk's own history names the owner too, with its kind
    const desk = await call(admin, "GET", "/admin/audit?entity=user&limit=200");
    const items = desk.body.items as { actor: string; actorKind: string; a: { actorId: string | null } }[];
    expect(items.some((i) => i.actor === "owner:aditya" && i.actorKind === "owner" && i.a.actorId === null)).toBe(true);
    expect(items.find((i) => i.actor === "Asha")?.actorKind).toBe("user");
  });

  it("history: a user named like an owner stays a user (actorKind)", async () => {
    await h.db.update(users).set({ name: "owner:vansh" }).where(eq(users.id, ids.admin!));
    try {
      const admin = await login("admin@test");
      expect((await call(admin, "PATCH", `/admin/users/${ids.viewer}`, { role: "viewer" })).status).toBe(200);
      const [top] = (await owner("GET", "/owner/history?limit=1")).body.entries;
      expect(top).toMatchObject({ actor: "owner:vansh", actorKind: "user", action: "user.role_changed" });
      const desk = await call(admin, "GET", "/admin/audit?entity=user&limit=1");
      expect(desk.body.items[0]).toMatchObject({ actor: "owner:vansh", actorKind: "user" });
    } finally {
      await h.db.update(users).set({ name: "Asha" }).where(eq(users.id, ids.admin!));
    }
  });

  it("history: the cursor pages through rows sharing a timestamp without gaps or repeats", async () => {
    // 7 rows at the same microsecond-precise time (a JS Date would round it), plus everything before
    await h.db.execute(sql`INSERT INTO audit_log (org_id, actor_id, actor, action, entity_type, entity_id, at)
      SELECT ${orgId}, NULL, 'owner:vansh', 'user.override_set', 'user', ${ids.viewer}, '2030-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1, 7)`);
    const all = (await owner("GET", "/owner/history?limit=200")).body.entries as unknown[];
    const seen: unknown[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { status: number; body: { entries: unknown[]; next: string | null } } = await owner("GET", `/owner/history?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.entries);
      cursor = res.body.next;
      pages++;
    } while (cursor && pages < 100);
    expect(seen).toEqual(all);
    expect(all.length).toBeGreaterThan(7);
    // The rows at the shared time come first (newest) and all 7 are there
    expect((all.slice(0, 7) as { at: string }[]).every((e) => e.at === "2030-01-01T00:00:00.123Z")).toBe(true);
  });
});
