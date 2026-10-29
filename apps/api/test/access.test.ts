// Roles, permissions, exceptions and the profile routes on a real Postgres (contract:
// handoff/access-control-contract.md §1–4). Needs TEST_DATABASE_URL.

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSION_KEYS } from "@socia/core";
import { createDb, ingestedFiles, orgs, postDrafts, roles, runMigrations, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect } from "socket.io-client";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { attachRealtime } from "../src/realtime";

const URL = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";

type App = Awaited<ReturnType<typeof buildApp>>;
interface Client {
  cookie: string;
  csrf: string;
}

(URL ? describe : describe.skip)("access control", () => {
  let h: DbHandle;
  let app: App;
  let orgId = "";
  let draftId = "";
  const ids: Record<string, string> = {};
  const who: Record<string, Client & { status?: number }> = {};

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3006"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(client: Client | null, method: string, url: string, payload?: unknown) {
    const res = await app.inject({
      method: method as "GET",
      url,
      payload: payload as Record<string, unknown>,
      headers: { ...(client && { cookie: client.cookie, "x-csrf": client.csrf }) },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function login(email: string, password = PASSWORD, target: App = app): Promise<Client & { status: number }> {
    const res = await target.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    if (res.statusCode !== 200) return { cookie: "", csrf: "", status: res.statusCode };
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, csrf: JSON.parse(res.body).csrfToken, status: 200 };
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
    const passwordHash = await hashPassword(PASSWORD);
    const people = [
      ["admin", "Asha", "admin"], ["admin2", "Bina", "admin"], ["editor", "Ed", "editor"], ["op", "Op", "operator"],
      ["op2", "Op Two", "operator"], ["viewer", "View", "viewer"],
    ] as const;
    for (const [k, name, role] of people) {
      const [u] = await h.db.insert(users).values({ orgId, name, email: `${k}@test`, passwordHash, role }).returning();
      ids[k] = u!.id;
    }
    // op2 has no platforms: a platform-scoped role then acts nowhere
    await h.db.update(users).set({ platforms: [] }).where(eq(users.id, ids.op2!));

    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-access-")), "http://localhost/dev-files");
    const [file] = await h.db.insert(ingestedFiles).values({ orgId, sha256: "a", sourcePath: "/a.txt", fileName: "a.txt", bytes: 1, storageKey: "raw/a", kind: "text", slug: "jpr_a" }).returning();
    const [story] = await h.db.insert(stories).values({ orgId, fileId: file!.id, slug: "jpr_a", status: "composed", headline: "जयपुर", body: "", conversionConfidence: 0.99 }).returning();
    const [draft] = await h.db
      .insert(postDrafts)
      .values({ orgId, storyId: story!.id, status: "ready", bodyText: "जयपुर", cardHeadline: "जयपुर", hashtags: [], composeVersion: "t", cardRenderedRev: 1, cardKey: "cards/a.png" })
      .returning();
    draftId = draft!.id;

    app = await buildApp({ db: h.db, storage: store, config }, false);
    for (const [k] of people) {
      const c = await login(`${k}@test`);
      who[k] = c;
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("seeds the 4 built-in roles for a new org", async () => {
    const rows = await h.db.select().from(roles).where(eq(roles.orgId, orgId));
    expect(rows.map((r) => [r.key, r.label, r.builtIn, r.platformScoped]).sort()).toEqual([
      ["admin", "Admin", true, false], ["editor", "Chief Editor", true, false], ["operator", "Digital Team", true, true], ["viewer", "Viewer", true, false],
    ]);
  });

  it("GET /me gives the user, their effective permissions, exceptions and the catalogue", async () => {
    const me = await call(who.op!, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: ids.op, name: "Op", role: "operator", roleLabel: "Digital Team", platforms: ["x"], active: true, totpEnabled: false });
    expect(me.body.user.lastLoginAt).not.toBeNull();
    expect(me.body.permissions).toContain("post.publish");
    expect(me.body.permissions).not.toContain("draft.approve");
    expect(me.body.overrides).toEqual([]);
    expect(me.body.catalogue).toHaveLength(PERMISSION_KEYS.length);
    expect(me.body.catalogue[0]).toEqual({ key: "page.dashboard", group: "pages", label: "Dashboard", description: expect.any(String) });
    expect(me.body.access).toEqual({ platforms: ["x"], canAct: true, canEditLibrary: false, canManageUsers: false });
    expect(me.body).toMatchObject({ verified: true, next: "done", csrfToken: who.op!.csrf });
    expect((await call(who.admin!, "GET", "/me")).body.permissions).toEqual([...PERMISSION_KEYS]);
  });

  it("keeps each role to what it could do before", async () => {
    const forbidden = await call(who.viewer!, "POST", `/drafts/${draftId}/claim`);
    expect(forbidden).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(forbidden.body.message).toContain('"Edit drafts"');
    // Platform-scoped: an operator without X acts nowhere; an editor acts anywhere
    expect((await call(who.op2!, "POST", `/drafts/${draftId}/claim`)).body.message).toBe("Your role cannot do this on this platform.");
    expect((await call(who.op!, "POST", "/trends/refresh")).status).toBe(403);
    expect((await call(who.op!, "GET", "/admin/roles")).status).toBe(403);
    expect((await call(who.editor!, "GET", "/admin/users")).status).toBe(403);
    expect((await call(who.editor!, "GET", "/users")).status).toBe(403);
    expect((await call(who.op!, "POST", `/drafts/${draftId}/claim`)).status).toBe(200);
    expect((await call(who.op!, "POST", `/drafts/${draftId}/release`)).status).toBe(200);
  });

  it("lists users with role label, exceptions and last sign-in at both paths", async () => {
    const list = await call(who.admin!, "GET", "/admin/users");
    expect(list.status).toBe(200);
    const op = list.body.items.find((u: { id: string }) => u.id === ids.op);
    expect(op).toMatchObject({ role: "operator", roleLabel: "Digital Team", platforms: ["x"], active: true, overrideCount: 0 });
    expect(op.lastLoginAt).not.toBeNull();
    expect(op).not.toHaveProperty("passwordHash");
    expect((await call(who.admin!, "GET", "/users")).body.items).toHaveLength(6);
  });

  it("creates, edits, copies and deletes custom roles", async () => {
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Video Editor", platformScoped: false, permissions: ["video.export", "made.up"] })).status).toBe(400);
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Video Editor" })).status).toBe(400);
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Video Editor", platformScoped: false, permissions: [], extra: 1 })).status).toBe(400);
    expect((await call(who.op!, "POST", "/admin/roles", { label: "Sneaky", platformScoped: false, permissions: [] })).status).toBe(403);

    const created = await call(who.admin!, "POST", "/admin/roles", {
      label: "Video Editor", description: "Cuts video", platformScoped: true, permissions: ["page.dashboard", "page.video_studio", "video.export", "video.export"],
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      key: "video-editor", label: "Video Editor", description: "Cuts video", builtIn: false, platformScoped: true, userCount: 0,
      permissions: ["page.dashboard", "page.video_studio", "video.export"], defaultPermissions: null,
    });
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "video editor", platformScoped: false, permissions: [] })))
      .toMatchObject({ status: 409, body: { error: "role_exists" } });
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Admin", platformScoped: false, permissions: [] })).status).toBe(409);

    const copy = await call(who.admin!, "POST", "/admin/roles", { label: "Night Desk", copyFrom: "operator" });
    expect(copy.status).toBe(201);
    expect(copy.body).toMatchObject({ key: "night-desk", platformScoped: true, permissions: (await call(who.admin!, "GET", "/admin/roles")).body.roles.find((r: { key: string }) => r.key === "operator").permissions });
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Ghost", copyFrom: "nobody" })).status).toBe(400);
    const hindi = await call(who.admin!, "POST", "/admin/roles", { label: "वीडियो टीम", platformScoped: false, permissions: [] });
    expect(hindi.status).toBe(201);
    expect(hindi.body.key).toMatch(/^role-[0-9a-f]{6}$/);

    const patched = await call(who.admin!, "PATCH", "/admin/roles/video-editor", { label: "Video Desk", permissions: ["page.video_studio", "video.export", "trends.refresh"] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ key: "video-editor", label: "Video Desk", permissions: ["page.video_studio", "trends.refresh", "video.export"] });
    expect((await call(who.admin!, "PATCH", "/admin/roles/video-editor", { permissions: ["nope"] })).status).toBe(400);
    expect((await call(who.admin!, "PATCH", "/admin/roles/nobody", { label: "X" })).status).toBe(404);

    // A user on the custom role gets exactly its permissions, platform-scoped
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.op2}`, { role: "video-editor", platforms: ["x", "x"] })).body).toMatchObject({ role: "video-editor", roleLabel: "Video Desk", platforms: ["x"] });
    const op2 = await login("op2@test");
    who.op2 = op2;
    expect((await call(op2, "GET", "/me")).body.permissions).toEqual(["page.video_studio", "trends.refresh", "video.export"]);
    expect((await call(op2, "POST", "/trends/refresh")).status).toBe(202);
    expect((await call(op2, "POST", `/drafts/${draftId}/claim`)).status).toBe(403);
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.op2}`, { role: "no-such-role" })).status).toBe(400);

    expect((await call(who.admin!, "DELETE", "/admin/roles/video-editor"))).toMatchObject({ status: 409, body: { error: "in_use" } });
    expect((await call(who.admin!, "DELETE", "/admin/roles/operator"))).toMatchObject({ status: 409, body: { error: "built_in" } });
    expect((await call(who.admin!, "DELETE", "/admin/roles/night-desk"))).toMatchObject({ status: 200, body: { ok: true } });
    expect((await call(who.admin!, "DELETE", "/admin/roles/night-desk")).status).toBe(404);
    const list = (await call(who.admin!, "GET", "/admin/roles")).body.roles;
    expect(list.map((r: { key: string }) => r.key).slice(0, 4)).toEqual(["admin", "editor", "operator", "viewer"]);
    expect(list.find((r: { key: string }) => r.key === "video-editor").userCount).toBe(1);
  });

  it("edits and resets built-in roles, and the admin role keeps user and role management", async () => {
    expect((await call(who.admin!, "PATCH", "/admin/roles/operator", { label: "Ops" }))).toMatchObject({ status: 409, body: { error: "built_in" } });
    expect((await call(who.admin!, "PATCH", "/admin/roles/operator", { platformScoped: false })).status).toBe(409);
    const adminPerms = PERMISSION_KEYS.filter((k) => k !== "roles.manage");
    expect((await call(who.admin!, "PATCH", "/admin/roles/admin", { permissions: adminPerms }))).toMatchObject({ status: 409, body: { error: "last_admin" } });

    const ops = (await call(who.admin!, "GET", "/admin/roles")).body.roles.find((r: { key: string }) => r.key === "operator");
    const without = ops.permissions.filter((k: string) => k !== "post.publish");
    expect((await call(who.admin!, "PATCH", "/admin/roles/operator", { permissions: without, description: "No posting today" })).body).toMatchObject({ permissions: without, description: "No posting today" });
    expect((await call(who.op!, "POST", `/drafts/${draftId}/approve`, { version: 1 })).body.message).toContain('"Post to platform"');

    const reset = await call(who.admin!, "POST", "/admin/roles/operator/reset");
    expect(reset.status).toBe(200);
    expect(reset.body.permissions).toEqual(reset.body.defaultPermissions);
    expect(reset.body.description).toBe("Posts on their own platforms.");
    expect((await call(who.admin!, "POST", "/admin/roles/video-editor/reset"))).toMatchObject({ status: 409, body: { error: "not_built_in" } });
    expect((await call(who.op!, "GET", "/me")).body.permissions).toContain("post.publish");
  });

  it("applies per-user exceptions, full replace, with strict keys", async () => {
    const url = `/admin/users/${ids.op}/overrides`;
    expect((await call(who.admin!, "PUT", url, { overrides: [{ permission: "made.up", allowed: true }] })).status).toBe(400);
    expect((await call(who.admin!, "PUT", url, { overrides: [{ permission: "trends.refresh", allowed: true }, { permission: "trends.refresh", allowed: false }] })).status).toBe(400);
    expect((await call(who.admin!, "PUT", url, { overrides: [{ permission: "trends.refresh", allowed: "yes" }] })).status).toBe(400);
    expect((await call(who.editor!, "PUT", url, { overrides: [] })).status).toBe(403);

    const set = await call(who.admin!, "PUT", url, { overrides: [{ permission: "trends.refresh", allowed: true }, { permission: "draft.edit", allowed: false }] });
    expect(set.status).toBe(200);
    expect(set.body.role).toBe("operator");
    const byKey = Object.fromEntries(set.body.permissions.map((p: { key: string }) => [p.key, p]));
    expect(byKey["trends.refresh"]).toMatchObject({ allowed: true, source: "override", roleAllowed: false });
    expect(byKey["draft.edit"]).toMatchObject({ allowed: false, source: "override", roleAllowed: true });
    expect(byKey["post.publish"]).toMatchObject({ allowed: true, source: "role" });
    expect(set.body.permissions).toHaveLength(PERMISSION_KEYS.length);

    // Takes effect on the next request, no sign-out
    expect((await call(who.op!, "POST", "/trends/refresh")).status).toBe(202);
    expect((await call(who.op!, "PATCH", `/drafts/${draftId}`, { version: 1, bodyText: "x" })).status).toBe(403);
    expect((await call(who.op!, "GET", "/me")).body.overrides).toEqual(expect.arrayContaining([{ permission: "trends.refresh", allowed: true }, { permission: "draft.edit", allowed: false }]));
    expect((await call(who.admin!, "GET", "/admin/users")).body.items.find((u: { id: string }) => u.id === ids.op).overrideCount).toBe(2);
    expect((await call(who.admin!, "GET", `/admin/users/${ids.op}/permissions`)).body.permissions.find((p: { key: string }) => p.key === "draft.edit").source).toBe("override");

    expect((await call(who.admin!, "PUT", url, { overrides: [] })).body.overrides).toEqual([]);
    expect((await call(who.op!, "POST", "/trends/refresh")).status).toBe(403);
    expect((await call(who.admin!, "GET", `/admin/users/${randomUUID()}/permissions`)).status).toBe(404);
  });

  it("refuses changes to yourself, whatever the case of the id", async () => {
    for (const id of [ids.admin!, ids.admin!.toUpperCase()]) {
      expect((await call(who.admin!, "PUT", `/admin/users/${id}/overrides`, { overrides: [{ permission: "users.manage", allowed: false }] }))).toMatchObject({ status: 409, body: { error: "self_change" } });
      expect((await call(who.admin!, "PATCH", `/admin/users/${id}`, { role: "editor" }))).toMatchObject({ status: 409, body: { error: "self_change" } });
      expect((await call(who.admin!, "PATCH", `/users/${id}`, { active: false }))).toMatchObject({ status: 409, body: { error: "self_change" } });
      expect((await call(who.admin!, "PATCH", `/admin/users/${id}`, { password: "a brand new long password" }))).toMatchObject({ status: 409, body: { error: "self_change" } });
      expect((await call(who.admin!, "PATCH", `/admin/users/${id}`, { resetTotp: true, password: "a brand new long password" }))).toMatchObject({ status: 409, body: { error: "self_change" } });
    }
    // Another user by upper-case id works as usual
    expect((await call(who.admin!, "GET", `/admin/users/${ids.op!.toUpperCase()}/permissions`)).body.role).toBe("operator");
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.op!.toUpperCase()}`, { platforms: ["x"] })).body.id).toBe(ids.op);
  });

  it("never leaves the org without an active admin, even when two admins demote each other at once", async () => {
    const [a, b] = await Promise.all([
      call(who.admin!, "PATCH", `/admin/users/${ids.admin2}`, { role: "editor" }),
      call(who.admin2!, "PATCH", `/admin/users/${ids.admin}`, { role: "editor" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    // The loser is refused: 401 (signed out), 409 last_admin, or 403 (re-read under the lock, no longer a user manager)
    expect([401, 403, 409]).toContain(statuses[1]);
    if (statuses[1] === 409) expect([a, b].find((r) => r.status === 409)!.body.error).toBe("last_admin");
    const admins = await h.db.select().from(users).where(eq(users.role, "admin"));
    expect(admins).toHaveLength(1);
    // The one left puts the other back
    const survivor = admins[0]!.id === ids.admin ? "admin" : "admin2";
    const other = survivor === "admin" ? "admin2" : "admin";
    who[survivor] = await login(`${survivor}@test`);
    expect((await call(who[survivor]!, "PATCH", `/admin/users/${ids[other]}`, { role: "admin" })).status).toBe(200);
    who[other] = await login(`${other}@test`);
  });

  it("lets a user manager hand out only what they hold", async () => {
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Basic", platformScoped: false, permissions: ["page.dashboard"] })).status).toBe(201);
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "User Desk", platformScoped: false, permissions: ["page.dashboard", "page.users", "users.manage"] })).status).toBe(201);
    const um = { name: "UM", email: "um@test", role: "user-desk", platforms: ["x"] };
    expect((await call(who.admin!, "POST", "/admin/users", { ...um, password: "elevenchars" })).status).toBe(400);
    expect((await call(who.admin!, "POST", "/admin/users", { ...um, password: PASSWORD })).body).toMatchObject({ role: "user-desk", roleLabel: "User Desk" });
    const me = await login("um@test");
    const myId = (await call(me, "GET", "/me")).body.user.id as string;

    expect((await call(me, "POST", "/admin/users", { name: "Z", email: "z@test", role: "admin", platforms: [], password: PASSWORD }))).toMatchObject({ status: 403, body: { error: "exceeds_own_access" } });
    expect((await call(me, "POST", "/admin/users", { name: "Z", email: "z@test", role: "viewer", platforms: [], password: PASSWORD })).status).toBe(403);
    const basic = await call(me, "POST", "/admin/users", { name: "B1", email: "b1@test", role: "basic", platforms: [], password: PASSWORD });
    expect(basic.body).toMatchObject({ role: "basic" });
    // Stronger users are out of reach, even for a password reset or a platform change
    expect((await call(me, "PATCH", `/admin/users/${ids.op}`, { platforms: ["x"] }))).toMatchObject({ status: 403, body: { error: "exceeds_own_access" } });
    expect((await call(me, "PATCH", `/admin/users/${ids.admin}`, { password: "take over this account" })).status).toBe(403);
    expect((await call(me, "PATCH", `/admin/users/${ids.admin}`, { resetTotp: true, password: "take over this account" })).status).toBe(403);
    expect((await call(me, "PATCH", `/admin/users/${basic.body.id}`, { role: "admin" })).body.error).toBe("exceeds_own_access");
    expect((await call(me, "PATCH", `/admin/users/${basic.body.id}`, { role: "user-desk" })).body.role).toBe("user-desk");
    expect((await call(me, "PUT", `/admin/users/${basic.body.id}/overrides`, { overrides: [{ permission: "roles.manage", allowed: true }] })).body.error).toBe("exceeds_own_access");
    expect((await call(me, "PUT", `/admin/users/${basic.body.id}/overrides`, { overrides: [{ permission: "users.manage", allowed: false }] })).status).toBe(200);
    expect((await call(me, "PUT", `/admin/users/${ids.op}/overrides`, { overrides: [] })).status).toBe(403);
    expect((await call(me, "PUT", `/admin/users/${myId}/overrides`, { overrides: [] })).body.error).toBe("self_change");
    expect((await call(me, "GET", "/admin/roles")).status).toBe(200);
  });

  it("lets a role manager neither widen their own role nor touch stronger ones", async () => {
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "Role Desk", platformScoped: false, permissions: ["page.dashboard", "roles.manage"] })).status).toBe(201);
    expect((await call(who.admin!, "POST", "/admin/users", { name: "RM", email: "rm@test", role: "role-desk", platforms: [], password: PASSWORD })).status).toBe(200);
    const me = await login("rm@test");

    expect((await call(me, "POST", "/admin/roles", { label: "Mega", platformScoped: false, permissions: ["users.manage"] }))).toMatchObject({ status: 403, body: { error: "exceeds_own_access" } });
    expect((await call(me, "POST", "/admin/roles", { label: "Desk Copy", copyFrom: "admin" })).status).toBe(403);
    expect((await call(me, "POST", "/admin/roles", { label: "Small", platformScoped: false, permissions: ["page.dashboard"] })).status).toBe(201);
    expect((await call(me, "PATCH", "/admin/roles/role-desk", { permissions: ["page.dashboard", "roles.manage", "users.manage"] }))).toMatchObject({ status: 403, body: { error: "own_role" } });
    expect((await call(me, "PATCH", "/admin/roles/role-desk", { description: "mine" })).body.error).toBe("own_role");
    expect((await call(me, "PATCH", "/admin/roles/operator", { description: "x" })).body.error).toBe("exceeds_own_access");
    expect((await call(me, "POST", "/admin/roles/viewer/reset")).body.error).toBe("exceeds_own_access");
    expect((await call(me, "PATCH", "/admin/roles/small", { permissions: ["page.dashboard", "users.manage"] })).body.error).toBe("exceeds_own_access");
    // Labels are unique in any case
    expect((await call(me, "PATCH", "/admin/roles/small", { label: "BASIC" }))).toMatchObject({ status: 409, body: { error: "role_exists" } });
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "role desk", platformScoped: false, permissions: [] })).body.error).toBe("role_exists");
    expect((await call(me, "PATCH", "/admin/roles/small", { label: "Small Desk" })).body.label).toBe("Small Desk");
    expect((await call(me, "DELETE", "/admin/roles/small")).status).toBe(200);
  });

  it("disconnects a user's live socket when their access changes", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const stop = attachRealtime(app.server, { db: h.db, databaseUrl: URL!, corsOrigins: config.corsOrigins, log: app.log });
    const port = (app.server.address() as { port: number }).port;
    const socket = connect(`http://127.0.0.1:${port}`, { extraHeaders: { cookie: who.op!.cookie }, transports: ["websocket"], reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("connect_error", reject);
      });
      await new Promise((r) => setTimeout(r, 300)); // listener up
      const gone = new Promise<string>((resolve) => socket.on("disconnect", (reason) => resolve(reason)));
      expect((await call(who.admin!, "PATCH", `/admin/users/${ids.op}`, { platforms: ["x", "instagram"] })).status).toBe(200);
      expect(await gone).toBe("io server disconnect");
    } finally {
      socket.close();
      await stop();
    }
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.op}`, { platforms: ["x"] })).status).toBe(200);
  });

  it("signs out and locks out inactive users", async () => {
    const before = await login("viewer@test");
    expect((await call(before, "GET", "/me")).status).toBe(200);
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.viewer}`, { active: false })).body).toMatchObject({ active: false });
    expect((await call(before, "GET", "/me")).status).toBe(401);
    expect((await login("viewer@test")).status).toBe(401);
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.viewer}`, { active: true })).body).toMatchObject({ active: true });
    who.viewer = await login("viewer@test");
    expect(who.viewer.status).toBe(200);
  });

  it("lets anyone change their name and password", async () => {
    expect((await call(who.op!, "PATCH", "/me", { name: "" })).status).toBe(400);
    expect((await call(who.op!, "PATCH", "/me", { name: "x".repeat(81) })).status).toBe(400);
    expect((await call(who.op!, "PATCH", "/me", { name: "Op", role: "admin" })).status).toBe(400);
    expect((await call(who.op!, "PATCH", "/me", { name: "  Operator   One " })).body.user.name).toBe("Operator One");
    expect((await call(who.op!, "GET", "/me")).body.user.name).toBe("Operator One");

    const other = await login("op@test");
    expect((await call(who.op!, "POST", "/me/password", { current: "wrong password", next: "a much longer secret" }))).toMatchObject({ status: 400, body: { error: "wrong_password" } });
    expect((await call(who.op!, "POST", "/me/password", { current: PASSWORD, next: "short" })).status).toBe(400);
    expect((await call(who.op!, "POST", "/me/password", { current: PASSWORD, next: "a much longer secret" })).status).toBe(200);
    expect((await call(who.op!, "GET", "/me")).status).toBe(200);
    expect((await call(other, "GET", "/me")).status).toBe(401);
    expect((await login("op@test")).status).toBe(401);
    expect((await login("op@test", "a much longer secret")).status).toBe(200);
  });

  it("does not let a half-signed-in session change the profile", async () => {
    const strict = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-access2-")), "http://localhost/dev-files"), config: { ...config, requireTotp: true } }, false);
    try {
      const half = await login("editor@test", PASSWORD, strict);
      const me = await strict.inject({ method: "GET", url: "/me", headers: { cookie: half.cookie } });
      expect(JSON.parse(me.body)).toMatchObject({ verified: false, next: "totp_setup" });
      const patch = await strict.inject({ method: "PATCH", url: "/me", payload: { name: "Hacker" }, headers: { cookie: half.cookie, "x-csrf": half.csrf } });
      expect(JSON.parse(patch.body).error).toBe("totp_setup_required");
    } finally {
      await strict.close();
    }
  });

  it("records every change and shows the history to audit.view", async () => {
    expect((await call(who.op!, "GET", "/admin/audit")).status).toBe(403);
    expect((await call(who.admin!, "GET", "/admin/audit?entity=story")).status).toBe(400);
    const roleHist = await call(who.admin!, "GET", "/admin/audit?entity=role&limit=200");
    expect(roleHist.status).toBe(200);
    const roleActions = roleHist.body.items.map((i: { a: { action: string } }) => i.a.action);
    for (const a of ["role.created", "role.updated", "role.permissions_changed", "role.reset", "role.deleted"]) expect(roleActions).toContain(a);
    expect(roleHist.body.items[0]).toMatchObject({ a: { entityType: "role" }, actor: expect.any(String) });

    const userHist = await call(who.editor!, "GET", "/admin/audit?entity=user&limit=200");
    const userActions = new Set(userHist.body.items.map((i: { a: { action: string } }) => i.a.action));
    for (const a of ["user.role_changed", "user.platforms_changed", "user.override_set", "user.override_cleared", "user.activated", "user.deactivated", "user.name_changed", "user.password_changed"]) {
      expect([a, userActions.has(a)]).toEqual([a, true]);
    }

    const page1 = await call(who.admin!, "GET", "/admin/audit?limit=3");
    expect(page1.body.items).toHaveLength(3);
    const page2 = await call(who.admin!, "GET", `/admin/audit?limit=3&before=${page1.body.nextBefore}`);
    expect(page2.body.items[0].a.id).toBeLessThan(page1.body.items[2].a.id);
    // One item's trail: open to anyone signed in, except roles and users
    expect((await call(who.viewer!, "GET", `/audit?entityType=role&entityId=video-editor`)).status).toBe(403);
    expect((await call(who.viewer!, "GET", `/audit?entityType=user&entityId=${ids.op}`)).status).toBe(403);
    expect((await call(who.viewer!, "GET", `/audit?entityType=hashtag_rule&entityId=${randomUUID()}`)).status).toBe(200);
    const trail = await call(who.editor!, "GET", `/audit?entityType=user&entityId=${ids.op!.toUpperCase()}`);
    expect(trail.status).toBe(200);
    expect(trail.body.items.length).toBeGreaterThan(0);
  });
});
