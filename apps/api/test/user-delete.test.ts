// Soft delete of a user (migration 0028): DELETE /users/:id, /admin/users/:id and /owner/people/:id on a real
// Postgres. Needs TEST_DATABASE_URL (the database is wiped).

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog, createDb, ingestedFiles, orgs, postDrafts, roles, runMigrations, sessions, stories, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";
const KEY = "k".repeat(40);

type App = Awaited<ReturnType<typeof buildApp>>;
interface Client {
  cookie: string;
  csrf: string;
  status: number;
}

(URL ? describe : describe.skip)("user delete", () => {
  let h: DbHandle;
  let app: App;
  let orgId = "";
  const ids: Record<string, string> = {};
  const who: Record<string, Client> = {};

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3006"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, ownerApiKey: KEY,
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
  async function owner(method: string, url: string) {
    const res = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${KEY}`, "x-owner-actor": "vansh" } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  async function login(email: string): Promise<Client> {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });
    if (res.statusCode !== 200) return { cookie: "", csrf: "", status: res.statusCode };
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, csrf: JSON.parse(res.body).csrfToken, status: 200 };
  }
  const userRow = async (id: string) => (await h.db.select().from(users).where(eq(users.id, id)))[0]!;
  const draftRow = async (id: string) => (await h.db.select().from(postDrafts).where(eq(postDrafts.id, id)))[0]!;
  const lastAudit = async () => (await h.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(1))[0]!;

  async function draft(status: "claimed" | "published" | "ready", claimedBy: string | null) {
    const slug = `jpr_${randomUUID().slice(0, 8)}`;
    const [file] = await h.db.insert(ingestedFiles).values({ orgId, sha256: randomUUID(), sourcePath: "/a.txt", fileName: "a.txt", bytes: 1, storageKey: `raw/${slug}`, kind: "text", slug }).returning();
    const [story] = await h.db.insert(stories).values({ orgId, fileId: file!.id, slug, status: "composed", headline: "जयपुर", body: "", conversionConfidence: 0.99 }).returning();
    const [d] = await h.db
      .insert(postDrafts)
      .values({
        orgId, storyId: story!.id, status, bodyText: "जयपुर", cardHeadline: "जयपुर", hashtags: [], composeVersion: "t", cardRenderedRev: 1, cardKey: "cards/a.png",
        claimedBy, claimExpiresAt: claimedBy ? sql`now() + interval '10 minutes'` : null,
      })
      .returning();
    return d!;
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
    const people = [["admin", "Asha", "admin"], ["editor", "Ed", "editor"], ["op", "Op", "operator"], ["op2", "Op Two", "operator"], ["viewer", "View", "viewer"]] as const;
    for (const [k, name, role] of people) {
      const [u] = await h.db.insert(users).values({ orgId, name, email: `${k}@test`, passwordHash, role }).returning();
      ids[k] = u!.id;
    }
    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-user-delete-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    for (const [k] of people) who[k] = await login(`${k}@test`);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("deletes a user: 204, signed out, locked out, gone from every list, holds let go, audited", async () => {
    const claimed = await draft("claimed", ids.op!);
    const held = await draft("published", ids.op!);
    const other = await draft("claimed", ids.op2!);
    expect((await call(who.op!, "GET", "/me")).status).toBe(200);

    const res = await call(who.admin!, "DELETE", `/admin/users/${ids.op!.toUpperCase()}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();

    const row = await userRow(ids.op!);
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.active).toBe(false);
    expect(await h.db.select().from(sessions).where(eq(sessions.userId, ids.op!))).toHaveLength(0);
    expect((await call(who.op!, "GET", "/me")).status).toBe(401);
    expect((await login("op@test")).status).toBe(401);

    // Holds: the claimed draft back in the queue, the posted one keeps its status, someone else's untouched
    expect(await draftRow(claimed.id)).toMatchObject({ status: "ready", claimedBy: null, claimExpiresAt: null });
    expect(await draftRow(held.id)).toMatchObject({ status: "published", claimedBy: null, claimExpiresAt: null });
    expect(await draftRow(other.id)).toMatchObject({ status: "claimed", claimedBy: ids.op2 });

    for (const path of ["/users", "/admin/users"]) {
      const list = await call(who.admin!, "GET", path);
      expect(list.status).toBe(200);
      expect(list.body.items.map((u: { id: string }) => u.id)).not.toContain(ids.op);
      expect(list.body.items.map((u: { id: string }) => u.id)).toContain(ids.op2);
    }
    const people = await owner("GET", "/owner/people");
    expect(people.body.users.map((u: { id: string }) => u.id)).not.toContain(ids.op);
    // Role counts leave deleted users out
    const roleList = await call(who.admin!, "GET", "/admin/roles");
    expect(roleList.body.roles.find((r: { key: string }) => r.key === "operator").userCount).toBe(1);

    const a = await lastAudit();
    expect(a).toMatchObject({ action: "user.delete", entityType: "user", entityId: ids.op, actorId: ids.admin });
    expect(a.before).toMatchObject({ name: "Op", email: "op@test", role: "operator", active: true });
    expect(a.after).toMatchObject({ deleted: true, active: false, releasedDrafts: 2 });
  });

  it("treats a deleted user as not found: delete again, edit, permissions, overrides, owner reads", async () => {
    expect((await call(who.admin!, "DELETE", `/users/${ids.op}`)).body).toMatchObject({ error: "not_found" });
    expect((await call(who.admin!, "DELETE", `/admin/users/${ids.op}`)).status).toBe(404);
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.op}`, { active: true })).status).toBe(404);
    expect((await call(who.admin!, "GET", `/admin/users/${ids.op}/permissions`)).status).toBe(404);
    expect((await call(who.admin!, "PUT", `/admin/users/${ids.op}/overrides`, { overrides: [] })).status).toBe(404);
    const gone = await owner("DELETE", `/owner/people/${ids.op}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe("not_found");
    expect((await owner("PATCH", `/owner/people/${ids.op}`)).status).not.toBe(200);
    expect((await call(who.admin!, "DELETE", `/admin/users/${randomUUID()}`)).status).toBe(404);
    expect((await call(who.admin!, "DELETE", "/admin/users/not-a-uuid")).status).toBe(400);
    // Still deleted and inactive
    expect(await userRow(ids.op!)).toMatchObject({ active: false });
  });

  it("keeps the email taken", async () => {
    const res = await call(who.admin!, "POST", "/admin/users", { name: "Op Again", email: "op@test", role: "operator", platforms: ["x"], password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_taken");
  });

  it("refuses to delete yourself (400 self), and needs users.manage", async () => {
    const self = await call(who.admin!, "DELETE", `/users/${ids.admin}`);
    expect(self.status).toBe(400);
    expect(self.body.error).toBe("self");
    expect((await call(who.viewer!, "DELETE", `/users/${ids.op2}`)).status).toBe(403);
    expect((await call(null, "DELETE", `/users/${ids.op2}`)).status).toBe(401);
    expect((await userRow(ids.admin!)).deletedAt).toBeNull();
    expect((await userRow(ids.op2!)).deletedAt).toBeNull();
  });

  it("owner delete: 204 and audited as the owner; the last admin cannot go (409 last_admin)", async () => {
    const res = await owner("DELETE", `/owner/people/${ids.viewer}`);
    expect(res.status).toBe(204);
    expect((await userRow(ids.viewer!)).deletedAt).toBeInstanceOf(Date);
    expect(await lastAudit()).toMatchObject({ action: "user.delete", entityId: ids.viewer, actorId: null, actor: "owner:vansh" });
    expect((await login("viewer@test")).status).toBe(401);

    const last = await owner("DELETE", `/owner/people/${ids.admin}`);
    expect(last.status).toBe(409);
    expect(last.body.error).toBe("last_admin");
    // Rolled back: still there, still signed in
    expect(await userRow(ids.admin!)).toMatchObject({ active: true, deletedAt: null });
    expect((await call(who.admin!, "GET", "/me")).status).toBe(200);
  });

  it("deletes a custom role whose only holders are deleted users (they move to viewer)", async () => {
    const created = await call(who.admin!, "POST", "/admin/roles", { label: "Night Desk", permissions: ["page.dashboard"], platformScoped: false });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.editor}`, { role: key })).status).toBe(200);
    expect((await call(who.admin!, "DELETE", `/admin/users/${ids.editor}`)).status).toBe(204);
    expect((await call(who.admin!, "DELETE", `/admin/roles/${key}`)).status).toBe(200);
    expect(await h.db.select().from(roles).where(and(eq(roles.orgId, orgId), eq(roles.key, key)))).toHaveLength(0);
    expect(await userRow(ids.editor!)).toMatchObject({ role: "viewer", active: false });
  });
});
