// Handle fixes F1 (14 Nov): every handle added in Settings has a type, and an organisation, person or party handle at
// least one keyword or name. POST /handles, PATCH /handles/:id and staging promotion refuse otherwise (400).
// Needs TEST_DATABASE_URL.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorage } from "@socia/providers";
import { createDb, handleDirectory, handleDirectoryStaging, orgs, runMigrations, users, type DbHandle } from "@socia/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";

const URL_ = process.env.TEST_DATABASE_URL;

(URL_ ? describe : describe.skip)("Settings handles: type and keywords (F1)", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let orgId = "";
  const admin = { cookie: "", csrf: "" };

  const config: ApiConfig = {
    databaseUrl: URL_ ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 5).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, phase: 1,
  };

  async function call(method: string, url: string, payload?: unknown) {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie: admin.cookie, "x-csrf": admin.csrf } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  const metro = { entityName: "Jaipur Metro", aliases: ["मेट्रो", "Metro", "जयपुर मेट्रो"], handle: "@JaipurMetro", priority: 1 };
  const stored = (handle: string) => h.db.select().from(handleDirectory).where(and(eq(handleDirectory.orgId, orgId), eq(handleDirectory.handle, handle)));

  beforeAll(async () => {
    h = createDb(URL_!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL_!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    orgId = org!.id;
    await h.db.insert(users).values({ orgId, name: "Admin", email: "admin@test", passwordHash: await hashPassword("correct horse battery"), role: "admin" });
    app = await buildApp({ db: h.db, storage: new LocalStorage(await mkdtemp(join(tmpdir(), "socia-settings-handles-")), "http://localhost/dev-files"), config }, false);
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "admin@test", password: "correct horse battery" } });
    admin.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    admin.csrf = JSON.parse(res.body).csrfToken;
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("F1 test 4: saving a Settings handle without a type → refused (400), nothing stored", async () => {
    expect((await call("POST", "/handles", metro)).status).toBe(400);
    expect((await call("POST", "/handles", { ...metro, type: "metro" })).status).toBe(400);
    expect(await stored("JaipurMetro")).toHaveLength(0);
  });

  it("an organisation, person or party handle with no keyword of 3+ letters → refused (400 keywords_required)", async () => {
    for (const type of ["organisation", "person", "party"]) {
      const res = await call("POST", "/handles", { ...metro, aliases: ["CM"], type });
      expect(res.status, type).toBe(400);
      expect(res.body.error).toBe("keywords_required");
    }
    expect(await stored("JaipurMetro")).toHaveLength(0);
  });

  it("a typed handle with keywords is saved with its type; police, collector and admin need no keyword", async () => {
    const ok = await call("POST", "/handles", { ...metro, type: "organisation" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ handle: "JaipurMetro", source: "manual", entityType: "organisation", aliases: metro.aliases });
    for (const type of ["police", "collector", "admin"]) {
      const res = await call("POST", "/handles", { entityName: `Jhalawar ${type}`, aliases: [], handle: `@Jhal_${type}`, priority: 0, type });
      expect(res.status, type).toBe(200);
      expect(res.body.entityType).toBe(type);
    }
  });

  it("PATCH keeps the rule: an organisation's last keyword cannot be removed; a bad type is refused", async () => {
    const [row] = await stored("JaipurMetro");
    expect((await call("PATCH", `/handles/${row!.id}`, { aliases: [] })).status).toBe(400);
    expect((await call("PATCH", `/handles/${row!.id}`, { type: "minister" })).status).toBe(400);
    const toPolice = await call("PATCH", `/handles/${row!.id}`, { type: "police", aliases: [] });
    expect(toPolice.status).toBe(200);
    expect(toPolice.body).toMatchObject({ entityType: "police", aliases: [] });
  });

  it("promotion from staging needs a type, and keywords for the keyword types", async () => {
    const [s] = await h.db
      .insert(handleDirectoryStaging)
      .values({ orgId, entityName: "Jaipur Development Authority", aliases: [], handle: "JDAJaipur", source: "wikidata", sourceId: "Q1" })
      .returning();
    expect((await call("POST", `/handles/staging/${s!.id}/promote`, { priority: 1 })).status).toBe(400);
    expect((await call("POST", `/handles/staging/${s!.id}/promote`, { type: "organisation" })).status).toBe(400);
    const ok = await call("POST", `/handles/staging/${s!.id}/promote`, { type: "organisation", aliases: ["जेडीए", "JDA Jaipur"] });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ handle: "JDAJaipur", source: "wikidata:Q1", entityType: "organisation" });
  });
});
