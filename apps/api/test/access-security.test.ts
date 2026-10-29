// Security review fixes for access control (handoff/access-control-contract.md, "Review fixes (security)"):
// strict request schemas and whitelisted updates (mass assignment), platform scope on "cannot exceed your own
// access", the actor re-read under the lock, sign-in throttling and TOTP lockout, sockets dropped when their
// session goes, chunked access.changed notifies, POST /users input checks and TOTP reset + password.
// Needs TEST_DATABASE_URL (the database is wiped).

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@fastify/type-provider-typebox";
import { newTotpSecret, totpCode, totpStep, verifyTotp } from "@socia/core";
import { createDb, orgs, runMigrations, sessions, users, type DbHandle } from "@socia/db";
import { LocalStorage, encryptSecret } from "@socia/providers";
import { eq, sql } from "drizzle-orm";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOTIFY_MAX_BYTES, accessChanged, chunkIds, reloadActor } from "../src/access";
import { buildApp, strictSchema } from "../src/app";
import { hashPassword, type SessionUser } from "../src/auth";
import { trustProxyFrom, type ApiConfig } from "../src/config";
import { SlidingLimiter } from "../src/limiter";
import type { AuthLimits } from "../src/routes/auth";
import { attachRealtime } from "../src/realtime";

const URL = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a completely new passphrase";

type App = Awaited<ReturnType<typeof buildApp>>;
interface Client {
  cookie: string;
  csrf: string;
  status: number;
  body?: Record<string, unknown>;
}

describe("strictSchema", () => {
  it("closes objects (nested, in unions and arrays) but leaves intersections and explicit settings alone", () => {
    const s = strictSchema(
      Type.Object({
        a: Type.Optional(Type.Object({ b: Type.String() })),
        list: Type.Array(Type.Object({ c: Type.Integer() })),
        either: Type.Union([Type.Object({ d: Type.String() }), Type.Null()]),
        open: Type.Object({ e: Type.String() }, { additionalProperties: true }),
        both: Type.Intersect([Type.Object({ f: Type.String() }), Type.Object({ g: Type.String() })]),
      }),
    ) as Record<string, any>;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.a.additionalProperties).toBe(false);
    expect(s.properties.list.items.additionalProperties).toBe(false);
    expect(s.properties.either.anyOf[0].additionalProperties).toBe(false);
    expect(s.properties.open.additionalProperties).toBe(true);
    expect(s.properties.both.allOf.map((m: { additionalProperties?: boolean }) => m.additionalProperties)).toEqual([undefined, undefined]);
    // Optional stays optional (TypeBox keeps its markers on the copy)
    expect(s.required).toEqual(["list", "either", "open", "both"]);
  });
});

describe("SlidingLimiter", () => {
  it("counts in a sliding window, records without taking, prunes idle keys and caps the map", () => {
    const l = new SlidingLimiter(2, 1000, 3);
    try {
      expect([l.take("a", 0), l.take("a", 10), l.take("a", 20)]).toEqual([true, true, false]);
      expect(l.take("a", 1005)).toBe(true);
      l.record("b", 0);
      expect(l.isOver("b", 0)).toBe(false);
      l.record("b", 1);
      expect([l.isOver("b", 2), l.isOver("b", 1001)]).toEqual([true, false]);
      // Cap 3: the least recently touched key goes first
      l.record("c", 2);
      l.record("a", 3);
      l.record("d", 4);
      expect(l.size).toBe(3);
      expect(l.isOver("b", 5)).toBe(false); // b was evicted
      l.prune(10_000);
      expect(l.size).toBe(0);
    } finally {
      l.close();
    }
  });
});

(URL ? describe : describe.skip)("access control security fixes", () => {
  let h: DbHandle;
  let app: App;
  let orgId = "";
  const ids: Record<string, string> = {};
  const who: Record<string, Client> = {};
  const totpSecret = newTotpSecret();

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3006"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(client: Client | null, method: string, url: string, payload?: unknown, target: App = app) {
    const res = await target.inject({
      method: method as "GET",
      url,
      payload: payload as Record<string, unknown>,
      headers: { ...(client && { cookie: client.cookie, "x-csrf": client.csrf }) },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }

  async function login(email: string, password = PASSWORD, target: App = app, remoteAddress?: string): Promise<Client> {
    const res = await target.inject({ method: "POST", url: "/auth/login", payload: { email, password }, ...(remoteAddress && { remoteAddress }) });
    const body = res.body ? JSON.parse(res.body) : {};
    if (res.statusCode !== 200) return { cookie: "", csrf: "", status: res.statusCode, body };
    return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, csrf: body.csrfToken, status: 200, body };
  }

  const within = <T>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("still connected")), ms))]);

  /** Serves `target` with live sockets; `socketFor` connects with a client's cookie and returns when it is gone */
  async function live(target: App, recheckMs?: number) {
    await target.listen({ port: 0, host: "127.0.0.1" });
    const stop = attachRealtime(target.server, { db: h.db, databaseUrl: URL!, corsOrigins: config.corsOrigins, log: target.log, recheckMs });
    const port = (target.server.address() as { port: number }).port;
    const open: Socket[] = [];
    const socketFor = async (client: Client) => {
      const socket = connect(`http://127.0.0.1:${port}`, { extraHeaders: { cookie: client.cookie }, transports: ["websocket"], reconnection: false });
      open.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.on("connect", () => resolve());
        socket.on("connect_error", reject);
      });
      const gone = new Promise<string>((resolve) => socket.on("disconnect", (reason) => resolve(reason)));
      return { socket, gone };
    };
    await new Promise((r) => setTimeout(r, 300)); // listener up
    return {
      socketFor,
      close: async () => {
        for (const s of open) s.close();
        await stop();
      },
    };
  }

  const wrongCode = (at = new Date()) => {
    for (let i = 0; ; i++) {
      const code = String(i).padStart(6, "0");
      if (!verifyTotp(totpSecret, code, at)) return code;
    }
  };

  /**
   * The current code, unused: each code works once (replay guard), and in real life each sign-in here would be
   * at least one 30 s step apart, so the user's last used step is cleared first.
   */
  const freshCode = async (at = new Date()) => {
    await h.db.update(users).set({ totpLastStep: null }).where(eq(users.id, ids.totp!));
    return totpCode(totpSecret, at);
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
    const passwordHash = await hashPassword(PASSWORD);
    const people = [["admin", "Asha", "admin"], ["op", "Op", "operator"], ["viewer", "View", "viewer"], ["totp", "Two Step", "editor"], ["sock", "Sock", "viewer"]] as const;
    for (const [k, name, role] of people) {
      const [u] = await h.db.insert(users).values({ orgId, name, email: `${k}@test`, passwordHash, role }).returning();
      ids[k] = u!.id;
    }
    await h.db.update(users).set({ totpEnabled: true, totpSecretEnc: encryptSecret(totpSecret, config.secretKey) }).where(eq(users.id, ids.totp!));
    const store = new LocalStorage(await mkdtemp(join(tmpdir(), "socia-sec-")), "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    for (const k of ["admin", "op", "viewer"]) who[k] = await login(`${k}@test`);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  // ─── 1. Mass assignment ──────────────────────────────────────────────────────

  it("refuses any field but role, platforms, active, password and resetTotp on a user", async () => {
    const [before] = await h.db.select().from(users).where(eq(users.id, ids.op!));
    const attempts: Record<string, unknown>[] = [
      { orgId: randomUUID() }, { passwordHash: "x" }, { totpEnabled: false }, { totpSecretEnc: null }, { email: "owned@test" },
      { id: randomUUID() }, { lastLoginAt: new Date().toISOString() }, { name: "Renamed" }, { active: true, orgId: randomUUID() },
    ];
    for (const base of ["/admin/users", "/users"]) {
      for (const body of attempts) {
        const res = await call(who.admin!, "PATCH", `${base}/${ids.op}`, body);
        expect([JSON.stringify(body), res.status, res.body.error]).toEqual([JSON.stringify(body), 400, "invalid"]);
      }
    }
    const [after] = await h.db.select().from(users).where(eq(users.id, ids.op!));
    expect(after).toEqual(before);
    expect((await call(who.admin!, "POST", "/admin/users", { name: "N", email: "n@test", role: "viewer", platforms: [], password: PASSWORD, orgId: randomUUID() })).status).toBe(400);
    expect((await call(who.admin!, "POST", "/admin/roles", { label: "R", platformScoped: false, permissions: [], builtIn: true })).status).toBe(400);
    expect((await call(who.admin!, "PATCH", "/admin/roles/viewer", { builtIn: false })).status).toBe(400);
    expect((await call(who.admin!, "PUT", `/admin/users/${ids.op}/overrides`, { overrides: [], userId: ids.admin })).status).toBe(400);
    expect((await call(who.admin!, "GET", "/admin/audit?entity=user&orgId=x")).status).toBe(400);
  });

  it("whitelists hashtag rule and handle fields: orgId, id and the rest are 400", async () => {
    const rule = await call(who.admin!, "POST", "/hashtag-rules", { matchType: "city", name: "Jaipur", aliases: [], hashtagLatin: "#Jaipur", priority: 1 });
    expect(rule.status).toBe(200);
    expect((await call(who.admin!, "POST", "/hashtag-rules", { matchType: "city", name: "Kota", aliases: [], hashtagLatin: "#Kota", priority: 1, orgId: randomUUID() })).status).toBe(400);
    for (const body of [{ orgId: randomUUID() }, { id: randomUUID() }, { active: false }, { createdAt: "2020-01-01T00:00:00Z" }, { priority: 2, orgId: randomUUID() }]) {
      expect((await call(who.admin!, "PATCH", `/hashtag-rules/${rule.body.id}`, body)).status).toBe(400);
    }
    const ruleOk = await call(who.admin!, "PATCH", `/hashtag-rules/${rule.body.id}`, { priority: 5, aliases: ["Pink City"] });
    expect(ruleOk.body).toMatchObject({ id: rule.body.id, orgId, priority: 5, aliases: ["Pink City"], active: true });

    const handle = await call(who.admin!, "POST", "/handles", { entityName: "CMO Rajasthan", aliases: [], handle: "@RajCMO", priority: 1 });
    expect(handle.status).toBe(200);
    expect((await call(who.admin!, "POST", "/handles", { entityName: "X", aliases: [], handle: "x", priority: 1, source: "wikidata" })).status).toBe(400);
    for (const body of [{ orgId: randomUUID() }, { id: randomUUID() }, { verifiedAt: null }, { source: "spoof" }, { platform: "instagram" }]) {
      expect((await call(who.admin!, "PATCH", `/handles/${handle.body.id}`, body)).status).toBe(400);
    }
    const handleOk = await call(who.admin!, "PATCH", `/handles/${handle.body.id}`, { handle: "@RajCMO2", priority: 3 });
    expect(handleOk.body).toMatchObject({ id: handle.body.id, orgId, handle: "RajCMO2", priority: 3, source: "manual" });
    expect((await call(who.admin!, "POST", `/handles/staging/${randomUUID()}/promote`, { priority: 1, verifiedBy: ids.admin })).status).toBe(400);
  });

  it("is strict on every route, including ones that do not say so", async () => {
    expect((await call(who.admin!, "POST", "/trends/search", { q: "jaipur", extra: 1 })).status).toBe(400);
    expect((await call(who.admin!, "POST", "/me/trend-watches", { keyword: "metro", userId: ids.op })).status).toBe(400);
    expect((await call(who.admin!, "PATCH", `/drafts/${randomUUID()}`, { version: 1, status: "published" })).status).toBe(400);
    expect((await call(who.admin!, "POST", `/drafts/${randomUUID()}/reject`, { reason: "duplicate", by: ids.op })).status).toBe(400);
    expect((await call(who.admin!, "GET", "/x/queue?view=inbox&orgId=x")).status).toBe(400);
    expect((await call(null, "POST", "/auth/login", { email: "admin@test", password: PASSWORD, remember: true })).status).toBe(400);
    // What the desk sends still works
    expect((await call(who.admin!, "GET", "/x/queue?view=inbox&limit=5")).status).toBe(200);
    expect((await call(who.admin!, "GET", "/me/card-template?platform=x")).status).toBe(200);
  });

  // ─── 2. Platform scope ───────────────────────────────────────────────────────

  it("keeps a platform-scoped user manager inside their platforms and scoped roles", async () => {
    const mkRole = async (label: string, platformScoped: boolean, permissions: string[]) =>
      expect((await call(who.admin!, "POST", "/admin/roles", { label, platformScoped, permissions })).status).toBe(201);
    await mkRole("Scoped Lead", true, ["page.dashboard", "users.manage", "roles.manage"]);
    await mkRole("Scoped Basic", true, ["page.dashboard"]);
    await mkRole("Scoped Two", true, ["page.dashboard"]);
    await mkRole("Basic", false, ["page.dashboard"]);
    const mkUser = async (k: string, role: string, platforms: string[]) => {
      const res = await call(who.admin!, "POST", "/admin/users", { name: k, email: `${k}@test`, role, platforms, password: PASSWORD });
      expect(res.status).toBe(200);
      ids[k] = res.body.id;
    };
    await mkUser("lead", "scoped-lead", ["x"]);
    await mkUser("wide", "scoped-basic", ["instagram"]);
    await mkUser("plain", "basic", []);
    const lead = await login("lead@test");
    const denied = (r: { status: number; body: { error: string } }) => expect([r.status, r.body.error]).toEqual([403, "exceeds_own_access"]);

    // Creating: only scoped roles, only own platforms
    denied(await call(lead, "POST", "/admin/users", { name: "U1", email: "u1@test", role: "basic", platforms: [], password: PASSWORD }));
    denied(await call(lead, "POST", "/admin/users", { name: "U1", email: "u1@test", role: "scoped-basic", platforms: ["instagram"], password: PASSWORD }));
    const mine = await call(lead, "POST", "/admin/users", { name: "Mine", email: "mine@test", role: "scoped-basic", platforms: ["x"], password: PASSWORD });
    expect(mine.status).toBe(200);
    // Changing someone in scope: not onto an unscoped role, not onto other platforms
    denied(await call(lead, "PATCH", `/admin/users/${mine.body.id}`, { role: "basic" }));
    denied(await call(lead, "PATCH", `/admin/users/${mine.body.id}`, { platforms: ["x", "youtube"] }));
    expect((await call(lead, "PATCH", `/admin/users/${mine.body.id}`, { role: "scoped-two", platforms: ["x"] })).body).toMatchObject({ role: "scoped-two" });
    expect((await call(lead, "PATCH", `/admin/users/${mine.body.id}`, { password: NEW_PASSWORD })).status).toBe(200);
    // Users on wider platforms or unscoped roles are out of reach, whatever the change
    for (const target of [ids.wide!, ids.plain!]) {
      denied(await call(lead, "PATCH", `/admin/users/${target}`, { password: NEW_PASSWORD }));
      denied(await call(lead, "PATCH", `/admin/users/${target}`, { resetTotp: true, password: NEW_PASSWORD }));
      denied(await call(lead, "PATCH", `/admin/users/${target}`, { active: false }));
      denied(await call(lead, "PUT", `/admin/users/${target}/overrides`, { overrides: [] }));
    }
    denied(await call(lead, "PATCH", `/admin/users/${ids.wide}`, { platforms: ["x"] }));
    // Own platforms stay with a full admin
    expect((await call(lead, "PATCH", `/admin/users/${ids.lead}`, { platforms: ["x", "instagram"] })).body.error).toBe("self_change");

    // Roles: never unscoped, and not a role whose users reach past the lead's platforms
    denied(await call(lead, "POST", "/admin/roles", { label: "Open", platformScoped: false, permissions: ["page.dashboard"] }));
    denied(await call(lead, "POST", "/admin/roles", { label: "Open Copy", copyFrom: "basic" }));
    expect((await call(lead, "POST", "/admin/roles", { label: "Lead Made", platformScoped: true, permissions: ["page.dashboard"] })).status).toBe(201);
    denied(await call(lead, "PATCH", "/admin/roles/scoped-two", { platformScoped: false }));
    expect((await call(lead, "PATCH", "/admin/roles/scoped-two", { description: "Fine" })).body.description).toBe("Fine");
    denied(await call(lead, "PATCH", "/admin/roles/scoped-basic", { description: "wide is on instagram" }));
    denied(await call(lead, "PATCH", "/admin/roles/basic", { description: "unscoped" }));
    await mkRole("Unused Open", false, ["page.dashboard"]);
    denied(await call(lead, "DELETE", "/admin/roles/unused-open"));
    expect((await call(lead, "DELETE", "/admin/roles/lead-made")).status).toBe(200);

    // A full admin (unscoped) is not limited by any of this
    expect((await call(who.admin!, "PATCH", `/admin/users/${ids.wide}`, { platforms: ["instagram", "youtube"] })).status).toBe(200);
  });

  // ─── 7. Actor re-read under the lock ─────────────────────────────────────────

  it("re-reads the actor's role, exceptions and platforms inside the transaction", async () => {
    const [row] = await h.db.select().from(users).where(eq(users.id, ids.viewer!));
    const stale: SessionUser = {
      id: row!.id, orgId, name: "View", email: row!.email, role: "admin", roleLabel: "Admin", platformScoped: false, platforms: ["x", "instagram"],
      totpEnabled: false, active: true, createdAt: row!.createdAt, lastLoginAt: null, permissions: new Set(["users.manage", "roles.manage"]), overrides: [],
    };
    const fresh = await reloadActor(h.db, stale);
    expect(fresh).toMatchObject({ role: "viewer", platformScoped: false, platforms: row!.platforms });
    expect(fresh.permissions.has("users.manage")).toBe(false);
    await h.db.update(users).set({ active: false }).where(eq(users.id, ids.viewer!));
    await expect(reloadActor(h.db, stale)).rejects.toMatchObject({ status: 401 });
    await h.db.update(users).set({ active: true }).where(eq(users.id, ids.viewer!));
  });

  // ─── 9. POST /users input ────────────────────────────────────────────────────

  it("trims the new user's name and checks the email", async () => {
    const base = { role: "viewer", platforms: [], password: PASSWORD };
    expect((await call(who.admin!, "POST", "/admin/users", { ...base, name: "   ", email: "blank@test" })).body.error).toBe("invalid");
    for (const email of ["not-an-email", "two@@test", "sp ace@test", "a@-bad", "a@bad.", "@test"]) {
      expect([email, (await call(who.admin!, "POST", "/admin/users", { ...base, name: "E", email })).status]).toEqual([email, 400]);
    }
    const ok = await call(who.admin!, "POST", "/admin/users", { ...base, name: "  New \t Person ", email: " New.Person@Desk.Example " });
    expect(ok.body).toMatchObject({ name: "New Person", email: "new.person@desk.example" });
  });

  // ─── 10. TOTP reset also sets a password ─────────────────────────────────────

  it("resets two-step sign-in only together with a new password, signing the user out", async () => {
    const [u] = await h.db.insert(users).values({ orgId, name: "Reset Me", email: "reset@test", passwordHash: await hashPassword(PASSWORD), role: "viewer", totpEnabled: true, totpSecretEnc: "x" }).returning();
    const half = await login("reset@test");
    expect(half.body).toMatchObject({ next: "totp" });
    expect((await call(who.admin!, "PATCH", `/admin/users/${u!.id}`, { resetTotp: true }))).toMatchObject({ status: 400, body: { error: "password_required" } });
    const done = await call(who.admin!, "PATCH", `/admin/users/${u!.id}`, { resetTotp: true, password: NEW_PASSWORD });
    expect(done.body).toMatchObject({ totpEnabled: false });
    expect((await call(half, "GET", "/me")).status).toBe(401);
    expect((await login("reset@test")).status).toBe(401);
    expect((await login("reset@test", NEW_PASSWORD)).status).toBe(200);
  });

  // ─── 6. Throttling ───────────────────────────────────────────────────────────

  const limitedApp = async (authLimits: Partial<AuthLimits>, extra: Partial<ApiConfig> = {}) =>
    buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-sec2-")), "http://localhost/dev-files"), config: { ...config, ...extra }, authLimits }, false);

  it("counts only failed sign-ins: per IP + account, per IP, and a looser per-account ceiling", async () => {
    const limited = await limitedApp({ loginFailuresPerIpAccount: 3, loginFailuresPerIp: 5, loginFailuresPerAccount: 6 });
    try {
      const unknown = await login("nobody@test", PASSWORD, limited, "10.0.0.9");
      const wrong = await login("viewer@test", "wrong password", limited, "10.0.0.9");
      expect([unknown.status, unknown.body]).toEqual([wrong.status, wrong.body]);
      expect(unknown).toMatchObject({ status: 401, body: { error: "bad_login" } });

      // Correct sign-ins use no budget
      for (let i = 0; i < 8; i++) expect((await login("op@test", PASSWORD, limited, "10.0.1.1")).status).toBe(200);

      // A stranger's failures from one IP lock only that IP out of that account
      for (let i = 0; i < 3; i++) expect((await login("op@test", "wrong password", limited, "10.0.1.9")).status).toBe(401);
      const blocked = await limited.inject({ method: "POST", url: "/auth/login", payload: { email: " OP@test ", password: PASSWORD }, remoteAddress: "10.0.1.9" });
      expect([blocked.statusCode, JSON.parse(blocked.body).error]).toEqual([429, "rate_limited"]);
      expect(Number(blocked.headers["retry-after"])).toBe(60);
      expect((await login("op@test", PASSWORD, limited, "10.0.1.1")).status).toBe(200);

      // Failures spread over IPs hit the per-account ceiling (6), for its longer window
      for (let i = 0; i < 3; i++) expect((await login("op@test", "wrong password", limited, `10.0.3.${i}`)).status).toBe(401);
      const ceiling = await limited.inject({ method: "POST", url: "/auth/login", payload: { email: "op@test", password: PASSWORD }, remoteAddress: "10.0.1.1" });
      expect([ceiling.statusCode, ceiling.headers["retry-after"]]).toEqual([429, "900"]);

      // Per IP: 5 failures a minute across accounts
      for (let i = 0; i < 5; i++) expect((await login(`guess${i}@test`, PASSWORD, limited, "10.0.2.1")).status).toBe(401);
      expect((await login("admin@test", PASSWORD, limited, "10.0.2.1"))).toMatchObject({ status: 429, body: { error: "rate_limited" } });
      expect((await login("admin@test", PASSWORD, limited, "10.0.2.2")).status).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it("reads the client IP from X-Forwarded-For only through trusted hops", async () => {
    const tries = async (target: App, headers: (i: number) => Record<string, string>) => {
      const out: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await target.inject({ method: "POST", url: "/auth/login", payload: { email: `spray${i}@test`, password: "x" }, remoteAddress: "10.0.5.1", headers: headers(i) });
        out.push(res.statusCode);
      }
      return out;
    };
    // Default (false): a forged header changes nothing, the socket address is the key
    const plain = await limitedApp({ loginFailuresPerIp: 3 });
    try {
      expect(await tries(plain, (i) => ({ "x-forwarded-for": `203.0.113.${i}` }))).toEqual([401, 401, 401, 429]);
    } finally {
      await plain.close();
    }
    // One trusted hop: the address the proxy appended is the key; what the client prepends is ignored
    const proxied = await limitedApp({ loginFailuresPerIp: 3 }, { trustProxy: 1 });
    try {
      expect(await tries(proxied, (i) => ({ "x-forwarded-for": `203.0.113.${i}, 198.51.100.7` }))).toEqual([401, 401, 401, 429]);
      const other = await proxied.inject({ method: "POST", url: "/auth/login", payload: { email: "spray9@test", password: "x" }, remoteAddress: "10.0.5.1", headers: { "x-forwarded-for": "198.51.100.8" } });
      expect(other.statusCode).toBe(401);
    } finally {
      await proxied.close();
    }
    expect(trustProxyFrom(undefined)).toBe(false);
    expect(trustProxyFrom("false")).toBe(false);
    expect(trustProxyFrom("1")).toBe(1);
    expect(trustProxyFrom("10.0.0.0/8, 127.0.0.1")).toEqual(["10.0.0.0/8", "127.0.0.1"]);
    expect(() => trustProxyFrom("true")).toThrow(/any client/);
    expect(() => trustProxyFrom("render.com")).toThrow(/TRUST_PROXY/);
  });

  it("locks a half-signed-in session after 5 wrong codes", async () => {
    const half = await login("totp@test");
    expect(half.body).toMatchObject({ next: "totp" });
    for (let i = 0; i < 4; i++) expect((await call(half, "POST", "/auth/totp", { code: wrongCode() })).body.error).toBe("bad_code");
    const locked = await call(half, "POST", "/auth/totp", { code: wrongCode() });
    expect([locked.status, locked.body.error]).toEqual([429, "rate_limited"]);
    expect((await call(half, "GET", "/me")).status).toBe(401);
    // Even the right code is useless on the locked session; a new sign-in works
    expect((await call(half, "POST", "/auth/totp", { code: await freshCode() })).status).toBe(401);
    const again = await login("totp@test");
    expect((await call(again, "POST", "/auth/totp", { code: await freshCode() })).body).toEqual({ ok: true });
    expect((await call(again, "GET", "/me")).body.verified).toBe(true);
  });

  it("throttles wrong codes per IP + account across sessions, not right ones", async () => {
    const limited = await limitedApp({ totpFailuresPerIpAccount: 3 });
    try {
      const ok = await login("totp@test", PASSWORD, limited);
      for (let i = 0; i < 2; i++) expect((await call(ok, "POST", "/auth/totp", { code: await freshCode() }, limited)).status).toBe(200);
      const a = await login("totp@test", PASSWORD, limited);
      const b = await login("totp@test", PASSWORD, limited);
      for (const s of [a, a, b]) expect((await call(s, "POST", "/auth/totp", { code: wrongCode() }, limited)).status).toBe(401);
      expect((await call(b, "POST", "/auth/totp", { code: await freshCode() }, limited)).body.error).toBe("rate_limited");
    } finally {
      await limited.close();
    }
  });

  // ─── TOTP replay: a code works once ─────────────────────────────────────────

  it("refuses a code already used for another sign-in, as a wrong code", async () => {
    const code = await freshCode();
    const first = await login("totp@test");
    expect((await call(first, "POST", "/auth/totp", { code })).body).toEqual({ ok: true });
    const second = await login("totp@test");
    const replay = await call(second, "POST", "/auth/totp", { code });
    expect([replay.status, replay.body.error]).toEqual([401, "bad_code"]);
    expect((await call(second, "GET", "/me")).body.verified).toBe(false);
    const [row] = await h.db.select({ step: users.totpLastStep }).from(users).where(eq(users.id, ids.totp!));
    expect(row!.step).toBeGreaterThanOrEqual(totpStep(new Date()) - 1);
  });

  it("accepts the next step's code after a used one, and never an older step again", async () => {
    const now = totpStep(new Date());
    const s1 = await login("totp@test");
    expect((await call(s1, "POST", "/auth/totp", { code: await freshCode(new Date(now * 30_000)) })).status).toBe(200);
    // The next 30 s window (accepted now as one step of drift)
    const s2 = await login("totp@test");
    expect((await call(s2, "POST", "/auth/totp", { code: totpCode(totpSecret, new Date((now + 1) * 30_000)) })).status).toBe(200);
    // Back to the step before it: refused, though still inside the drift window
    const s3 = await login("totp@test");
    expect((await call(s3, "POST", "/auth/totp", { code: totpCode(totpSecret, new Date(now * 30_000)) })).body.error).toBe("bad_code");
  });

  it("lets only one of two concurrent submits of one code win", async () => {
    const code = await freshCode();
    const [a, b] = [await login("totp@test"), await login("totp@test")];
    const results = await Promise.all([call(a, "POST", "/auth/totp", { code }), call(b, "POST", "/auth/totp", { code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("counts a replay toward the wrong-code limits", async () => {
    const limited = await limitedApp({ totpFailuresPerIpAccount: 1 });
    try {
      const code = await freshCode();
      const ok = await login("totp@test", PASSWORD, limited);
      expect((await call(ok, "POST", "/auth/totp", { code }, limited)).status).toBe(200);
      const again = await login("totp@test", PASSWORD, limited);
      expect((await call(again, "POST", "/auth/totp", { code }, limited)).body.error).toBe("bad_code");
      // The one allowed failure is spent: even a fresh right code is throttled now
      const throttled = await call(again, "POST", "/auth/totp", { code: await freshCode() }, limited);
      expect([throttled.status, throttled.body.error]).toEqual([429, "rate_limited"]);
    } finally {
      await limited.close();
    }
  });

  it("refuses a replayed code on /auth/totp/enable", async () => {
    const [u] = await h.db.insert(users).values({ orgId, name: "Enabler", email: "enable@test", passwordHash: await hashPassword(PASSWORD), role: "viewer" }).returning();
    const s = await login("enable@test");
    const setup = await call(s, "POST", "/auth/totp/setup");
    expect(setup.status).toBe(200);
    const code = totpCode(setup.body.secret, new Date());
    expect((await call(s, "POST", "/auth/totp/enable", { code })).body).toEqual({ ok: true });
    // Two-step is on now: the same code cannot finish a new sign-in
    const next = await login("enable@test");
    expect(next.body).toMatchObject({ next: "totp" });
    expect((await call(next, "POST", "/auth/totp", { code })).body.error).toBe("bad_code");
    // Nor turn two-step back on with it (same secret, its step already used)
    await h.db.update(users).set({ totpEnabled: false }).where(eq(users.id, u!.id));
    const half = await login("enable@test");
    expect((await call(half, "POST", "/auth/totp/enable", { code })).body.error).toBe("bad_code");
  });

  // ─── 8. Chunked notifies ─────────────────────────────────────────────────────

  it("splits access.changed into payloads under 7000 bytes", async () => {
    const many = Array.from({ length: 900 }, () => randomUUID());
    const chunks = chunkIds(many, 160);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(many);
    for (const c of chunks) {
      const payload = JSON.stringify({ type: "access.changed", userIds: [], sessionIds: c, orgId, platform: "x" });
      expect(Buffer.byteLength(payload)).toBeLessThan(NOTIFY_MAX_BYTES);
    }
    // pg_notify refuses payloads of 8000 bytes or more; this would have thrown before
    await expect(accessChanged(h.db, orgId, many, many)).resolves.toBeUndefined();
  });

  // ─── 5. Sockets follow their session ─────────────────────────────────────────

  it("disconnects sockets on sign-out, password and TOTP resets and a password change", async () => {
    // Default re-check (60 s): every disconnect below comes from the access.changed notify
    const rt = await live(app);
    try {
      // Sign-out: only that session's socket goes
      const s1 = await login("sock@test");
      const s2 = await login("sock@test");
      const a = await rt.socketFor(s1);
      const b = await rt.socketFor(s2);
      expect((await call(s1, "POST", "/auth/logout")).status).toBe(200);
      expect(await within(a.gone)).toBe("io server disconnect");
      await new Promise((r) => setTimeout(r, 300));
      expect(b.socket.connected).toBe(true);

      // Own password change: the other sessions' sockets go, this one stays
      const s3 = await login("sock@test");
      const c = await rt.socketFor(s3);
      expect((await call(s2, "POST", "/me/password", { current: PASSWORD, next: NEW_PASSWORD })).status).toBe(200);
      expect(await within(c.gone)).toBe("io server disconnect");
      expect(b.socket.connected).toBe(true);

      // Admin password reset and TOTP reset: every socket of the user
      expect((await call(who.admin!, "PATCH", `/admin/users/${ids.sock}`, { password: PASSWORD })).status).toBe(200);
      expect(await within(b.gone)).toBe("io server disconnect");
      const s4 = await login("sock@test");
      const e = await rt.socketFor(s4);
      expect((await call(who.admin!, "PATCH", `/admin/users/${ids.sock}`, { resetTotp: true, password: NEW_PASSWORD })).status).toBe(200);
      expect(await within(e.gone)).toBe("io server disconnect");

      // A big access.changed (several chunks) still reaches the socket of the last id
      const s5 = await login("sock@test", NEW_PASSWORD);
      const g = await rt.socketFor(s5);
      await accessChanged(h.db, orgId, [...Array.from({ length: 400 }, () => randomUUID()), ids.sock!]);
      expect(await within(g.gone)).toBe("io server disconnect");
    } finally {
      await rt.close();
    }
  });

  it("re-checks open sockets' sessions and drops those that ended without a notify", async () => {
    const other = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-sec4-")), "http://localhost/dev-files"), config }, false);
    const rt = await live(other, 200);
    try {
      const kept = await login("viewer@test", PASSWORD, other);
      const ended = await login("sock@test", NEW_PASSWORD, other);
      const k = await rt.socketFor(kept);
      const e = await rt.socketFor(ended);
      await h.db.delete(sessions).where(eq(sessions.userId, ids.sock!)); // no notify
      expect(await within(e.gone)).toBe("io server disconnect");
      // Expired, and a deactivated user, go the same way
      const k2 = await rt.socketFor(await login("sock@test", NEW_PASSWORD, other));
      await h.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, ids.sock!));
      expect(await within(k2.gone)).toBe("io server disconnect");
      const k3 = await rt.socketFor(await login("sock@test", NEW_PASSWORD, other));
      await h.db.update(users).set({ active: false }).where(eq(users.id, ids.sock!));
      expect(await within(k3.gone)).toBe("io server disconnect");
      await h.db.update(users).set({ active: true }).where(eq(users.id, ids.sock!));
      expect(k.socket.connected).toBe(true);
    } finally {
      await rt.close();
      await other.close();
    }
  });
});
