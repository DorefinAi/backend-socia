// The org's shared card templates (dev-docs/org-card-templates-contract.md): the seed (real images, sizes read
// from the files, idempotent), the list, the background (org-scoped), the layout change with date: null, and
// v2: uploads by desk users, rename/layout by the uploader or an admin, default tags and delete by an admin only.
// Needs TEST_DATABASE_URL (a throwaway database: it is wiped).

import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { auditLog, createDb, orgCardTemplates, orgs, runMigrations, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { CARD_TEMPLATE_ASSETS, ORG_CARD_TEMPLATES, seedOrgCardTemplates } from "../src/org-card-seed";

const URL = process.env.TEST_DATABASE_URL;

const SETTINGS = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, ihdr])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, type, ihdr, crc]);
}

const SQUARE_LAYOUT = ORG_CARD_TEMPLATES[0]!.layout;

(URL ? describe : describe.skip)("org card templates", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: LocalStorage;
  let storeRoot = "";
  let orgA = "";
  let orgB = "";
  const admin = { cookie: "", csrf: "", id: "" };
  const op = { cookie: "", csrf: "", id: "" };
  const outsider = { cookie: "", csrf: "", id: "" };
  const op2 = { cookie: "", csrf: "", id: "" };
  const editor = { cookie: "", csrf: "", id: "" };
  const viewer = { cookie: "", csrf: "", id: "" };
  type Who = typeof admin;

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 7).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(who: Who | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const auth = who ? { cookie: who.cookie, "x-csrf": who.csrf } : {};
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers: { ...auth, ...headers } });
    return { status: res.statusCode, body: res.headers["content-type"]?.toString().startsWith("application/json") ? JSON.parse(res.body) : null, raw: res };
  }

  async function login(email: string, into: Who) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    into.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    into.csrf = JSON.parse(res.body).csrfToken;
  }

  const rowsOf = (orgId: string) => h.db.select().from(orgCardTemplates).where(eq(orgCardTemplates.orgId, orgId)).orderBy(asc(orgCardTemplates.sort));
  const filesOf = (orgId: string) => readdir(join(storeRoot, "card-templates", "org", orgId)).catch(() => [] as string[]);

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [a] = await h.db.insert(orgs).values({ name: "1st India", settings: SETTINGS }).returning();
    const [b] = await h.db.insert(orgs).values({ name: "Other house", settings: SETTINGS }).returning();
    orgA = a!.id;
    orgB = b!.id;
    const passwordHash = await hashPassword("correct horse battery");
    const people: [Who, string, string, string][] = [
      [admin, "admin", "admin", orgA], [op, "op", "operator", orgA], [outsider, "outsider", "admin", orgB],
      [op2, "op2", "operator", orgA], [editor, "editor", "editor", orgA], [viewer, "viewer", "viewer", orgA],
    ];
    for (const [who, name, role, orgId] of people) {
      const [u] = await h.db.insert(users).values({ orgId, name, email: `${name}@test`, passwordHash, role }).returning();
      who.id = u!.id;
    }
    storeRoot = await mkdtemp(join(tmpdir(), "socia-orgtpl-"));
    store = new LocalStorage(storeRoot, "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    for (const [who, name] of people) await login(`${name}@test`, who);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("lists nothing before the seed, and needs a session", async () => {
    expect(await call(admin, "GET", "/card-templates?platform=x")).toMatchObject({ status: 200, body: { templates: [] } });
    expect((await call(null, "GET", "/card-templates")).status).toBe(401);
    expect((await call(admin, "GET", "/card-templates?platform=instagram")).status).toBe(400);
  });

  it("seeds both designs from the shipped images, sizes read from the files", async () => {
    const first = await seedOrgCardTemplates(h.db, store, orgA);
    expect(first.map((r) => [r.slug, r.outcome, r.width, r.height])).toEqual([
      ["breaking-square", "created", 1080, 1080],
      ["badi-khabar", "created", 1080, 1350],
    ]);
    const rows = await rowsOf(orgA);
    expect(rows.map((r) => ({ slug: r.slug, label: r.label, defaultFor: r.defaultFor, sort: r.sort, platform: r.platform }))).toEqual([
      { slug: "breaking-square", label: "BREAKING NEWS", defaultFor: ["breaking"], sort: 0, platform: "x" },
      { slug: "badi-khabar", label: "बड़ी ख़बर", defaultFor: ["big_breaking"], sort: 1, platform: "x" },
    ]);
    expect(rows[1]!.layout.date).toBeNull();
    // The stored files are the shipped images, byte for byte
    for (const r of rows) {
      const def = ORG_CARD_TEMPLATES.find((d) => d.slug === r.slug)!;
      expect((await store.get(r.backgroundKey)).equals(await readFile(join(CARD_TEMPLATE_ASSETS, def.file)))).toBe(true);
    }
    expect((await filesOf(orgA)).length).toBe(2);
  });

  it("seeding again changes nothing", async () => {
    const before = await rowsOf(orgA);
    const again = await seedOrgCardTemplates(h.db, store, orgA);
    expect(again.map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(await rowsOf(orgA)).toEqual(before);
    expect((await filesOf(orgA)).length).toBe(2);
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.entityType, "org_card_template"), eq(auditLog.action, "org_card_template.seeded")))).toEqual([]);
  });

  it("lists the org's templates in order, in the contract's shape", async () => {
    const res = await call(op, "GET", "/card-templates?platform=x");
    expect(res.status).toBe(200);
    const [square, badi] = res.body.templates;
    expect(res.body.templates).toHaveLength(2);
    expect(square).toEqual({
      slug: "breaking-square", label: "BREAKING NEWS", platform: "x", width: 1080, height: 1080, layout: SQUARE_LAYOUT, defaultFor: ["breaking"],
      backgroundUrl: expect.stringMatching(/^\/card-templates\/breaking-square\/background\?v=\d+$/), updatedAt: expect.any(String),
      // Seeded: no uploader, so only an admin may edit; an operator may do neither of the admin things
      createdBy: null, canEdit: false, canDelete: false, canSetDefault: false,
    });
    expect(new Date(square.updatedAt).toISOString()).toBe(square.updatedAt);
    expect(badi).toMatchObject({ slug: "badi-khabar", label: "बड़ी ख़बर", width: 1080, height: 1350, defaultFor: ["big_breaking"], layout: { date: null } });
    // Default platform is x
    expect((await call(op, "GET", "/card-templates")).body).toEqual(res.body);
    // The flags are per requesting user
    expect((await call(admin, "GET", "/card-templates")).body.templates[0]).toMatchObject({ createdBy: null, canEdit: true, canDelete: true, canSetDefault: true });
  });

  it("serves the background to anyone signed in to the same org, and to no one else", async () => {
    const { body } = await call(op, "GET", "/card-templates");
    const square = body.templates[0];
    const img = await call(op, "GET", square.backgroundUrl);
    expect(img.status).toBe(200);
    expect(img.raw.headers["content-type"]).toBe("image/jpeg");
    expect(img.raw.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(img.raw.rawPayload.equals(await readFile(join(CARD_TEMPLATE_ASSETS, "breaking-square.jpeg")))).toBe(true);
    // An old or missing v is not cached
    expect((await call(op, "GET", "/card-templates/breaking-square/background?v=1")).raw.headers["cache-control"]).toBe("no-store");
    expect((await call(op, "GET", "/card-templates/breaking-square/background")).raw.headers["cache-control"]).toBe("no-store");

    // Another org: its own (empty) list, and a 404 for this org's slug
    expect(await call(outsider, "GET", "/card-templates")).toMatchObject({ status: 200, body: { templates: [] } });
    expect(await call(outsider, "GET", square.backgroundUrl)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await call(null, "GET", square.backgroundUrl)).status).toBe(401);
    expect(await call(op, "GET", "/card-templates/no-such/background")).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await call(op, "GET", "/card-templates/Bad_Slug/background")).status).toBe(400);
  });

  it("changes a seeded template's layout only as an admin, and only with the CSRF token", async () => {
    const layout = { ...SQUARE_LAYOUT, box: { x: 0.1, y: 0.3, w: 0.8, h: 0.5 } };
    expect((await call(null, "PATCH", "/card-templates/breaking-square", { layout })).status).toBe(401);
    const noCsrf = await app.inject({ method: "PATCH", url: "/card-templates/breaking-square", payload: { layout }, headers: { cookie: admin.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(JSON.parse(noCsrf.body).error).toBe("csrf");
    expect(await call(op, "PATCH", "/card-templates/breaking-square", { layout })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    // v2: Settings alone no longer moves a shared template's areas; the uploader or an admin does
    expect(await call(editor, "PATCH", "/card-templates/breaking-square", { layout })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    // Another org's admin is an admin, but not of this org's template
    expect(await call(outsider, "PATCH", "/card-templates/breaking-square", { layout })).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await call(admin, "PATCH", "/card-templates/no-such", { layout })).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await rowsOf(orgA))[0]!.layout).toEqual(SQUARE_LAYOUT);

    const before = (await call(admin, "GET", "/card-templates")).body.templates[0];
    const ok = await call(admin, "PATCH", "/card-templates/breaking-square?platform=x", { layout });
    expect(ok.status).toBe(200);
    expect(ok.body.template).toMatchObject({ slug: "breaking-square", layout, width: 1080, height: 1080 });
    expect(ok.body.template.backgroundUrl).not.toBe(before.backgroundUrl);
    expect((await call(op, "GET", ok.body.template.backgroundUrl)).raw.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "org_card_template.layout_changed"));
    expect(entry).toMatchObject({ orgId: orgA, actorId: admin.id, entityType: "org_card_template", before: SQUARE_LAYOUT, after: layout });
  });

  it("takes date: null, and refuses what the per-user layout refuses", async () => {
    const noDate = { ...SQUARE_LAYOUT, date: null };
    expect(await call(admin, "PATCH", "/card-templates/breaking-square", { layout: noDate })).toMatchObject({ status: 200, body: { template: { layout: { date: null } } } });
    expect((await rowsOf(orgA))[0]!.layout.date).toBeNull();

    const bad: [string, unknown][] = [
      ["box off the right edge", { ...SQUARE_LAYOUT, box: { x: 0.5, y: 0.2, w: 0.6, h: 0.5 } }],
      ["date off the bottom", { ...SQUARE_LAYOUT, date: { ...SQUARE_LAYOUT.date!, y: 0.97, h: 0.05 } }],
      ["box of zero width", { ...SQUARE_LAYOUT, box: { x: 0.1, y: 0.2, w: 0, h: 0.5 } }],
      ["date of zero height", { ...SQUARE_LAYOUT, date: { ...SQUARE_LAYOUT.date!, h: 0 } }],
      ["fraction over 1", { ...SQUARE_LAYOUT, box: { x: 1.2, y: 0, w: 0.1, h: 0.1 } }],
      ["font range reversed", { ...SQUARE_LAYOUT, fontMinPx: 60, fontMaxPx: 20 }],
      ["colour not #RRGGBB", { ...SQUARE_LAYOUT, headline: { color: "yellow" } }],
      ["date missing (null is allowed, absent is not)", { box: SQUARE_LAYOUT.box, headline: SQUARE_LAYOUT.headline, body: SQUARE_LAYOUT.body, fontMinPx: 18, fontMaxPx: 56 }],
      ["extra key", { ...SQUARE_LAYOUT, logo: { x: 0 } }],
      ["date of the wrong type", { ...SQUARE_LAYOUT, date: "top-right" }],
    ];
    for (const [why, layout] of bad) {
      const res = await call(admin, "PATCH", "/card-templates/badi-khabar", { layout });
      expect([why, res.status, res.body?.error]).toEqual([why, 400, "invalid"]);
    }
    expect((await call(admin, "PATCH", "/card-templates/badi-khabar", { layout: noDate, extra: 1 })).status).toBe(400);
    expect((await rowsOf(orgA))[1]!.layout).toEqual(ORG_CARD_TEMPLATES[1]!.layout);
  });

  it("a re-seed keeps a layout changed in Settings, and --reset-layout puts the default back", async () => {
    const tuned = (await rowsOf(orgA))[0]!;
    expect(tuned.layout.date).toBeNull();
    expect((await seedOrgCardTemplates(h.db, store, orgA)).map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
    expect((await rowsOf(orgA))[0]).toEqual(tuned);
    const reset = await seedOrgCardTemplates(h.db, store, orgA, { resetLayout: true });
    expect(reset.map((r) => r.outcome)).toEqual(["updated", "unchanged"]);
    expect((await rowsOf(orgA))[0]!.layout).toEqual(SQUARE_LAYOUT);
  });

  it("a new image replaces the stored one; the old file is removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "socia-orgtpl-assets-"));
    await writeFile(join(dir, "square.png"), png(1200, 1200));
    const before = (await rowsOf(orgA))[0]!;
    const [res] = await seedOrgCardTemplates(h.db, store, orgA, { assetsDir: dir, templates: [{ ...ORG_CARD_TEMPLATES[0]!, file: "square.png" }] });
    expect(res).toMatchObject({ slug: "breaking-square", outcome: "updated", width: 1200, height: 1200 });
    const after = (await rowsOf(orgA))[0]!;
    expect(after.backgroundKey).toMatch(/\.png$/);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const files = await filesOf(orgA);
    expect(files).toHaveLength(2);
    expect(files.some((f) => before.backgroundKey.endsWith(f))).toBe(false);
    const img = await call(op, "GET", "/card-templates/breaking-square/background");
    expect(img.raw.headers["content-type"]).toBe("image/png");
  });

  it("seeds each org separately", async () => {
    await seedOrgCardTemplates(h.db, store, orgB);
    expect((await call(outsider, "GET", "/card-templates")).body.templates.map((t: { slug: string }) => t.slug)).toEqual(["breaking-square", "badi-khabar"]);
    // org A's rows are untouched by org B's seed
    expect((await rowsOf(orgA))[0]!.backgroundKey).toMatch(/\.png$/);
  });

  // ─── v2: upload, rename, defaults, delete ────────────────────────────────────

  const upload = (who: Who | null, label: string, body: Buffer, type = "image/png", extra = "") =>
    call(who, "POST", `/card-templates?label=${encodeURIComponent(label)}${extra}`, body, { "content-type": type });

  it("v2: an operator uploads a template; it starts with the default layout, no default tags, last in the order", async () => {
    const res = await upload(op, "Election Night!", png(1200, 900));
    expect(res.status).toBe(201);
    const t = res.body.template;
    expect(t).toMatchObject({
      label: "Election Night!", platform: "x", width: 1200, height: 900, defaultFor: [],
      layout: { date: null, box: { x: 0.08, y: 0.25, w: 0.84, h: 0.6 }, headline: { color: "#FFE600" }, body: { color: "#FFFFFF" }, fontMinPx: 18, fontMaxPx: 60 },
      createdBy: { id: op.id, name: "op" }, canEdit: true, canDelete: false, canSetDefault: false,
    });
    expect(t.slug).toMatch(/^election-night-[a-z0-9]{6}$/);
    const row = (await rowsOf(orgA)).find((r) => r.slug === t.slug)!;
    expect(row).toMatchObject({ createdBy: op.id, sort: 2 });
    expect(row.backgroundKey).toMatch(new RegExp(`^card-templates/org/${orgA}/${t.slug}-[0-9a-f]{16}\\.png$`));
    const img = await call(admin, "GET", t.backgroundUrl);
    expect(img.status).toBe(200);
    expect(img.raw.headers["content-type"]).toBe("image/png");
    const [entry] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "org_card_template.created"), eq(auditLog.entityId, row.id)));
    expect(entry).toMatchObject({ orgId: orgA, actorId: op.id, entityType: "org_card_template" });
    // Other users see it with their own flags
    const asOp2 = (await call(op2, "GET", "/card-templates")).body.templates.find((x: { slug: string }) => x.slug === t.slug);
    expect(asOp2).toMatchObject({ createdBy: { id: op.id, name: "op" }, canEdit: false, canDelete: false, canSetDefault: false });
    const asAdmin = (await call(admin, "GET", "/card-templates")).body.templates.find((x: { slug: string }) => x.slug === t.slug);
    expect(asAdmin).toMatchObject({ canEdit: true, canDelete: true, canSetDefault: true });
    // Another org never sees it
    expect((await call(outsider, "GET", "/card-templates")).body.templates.map((x: { slug: string }) => x.slug)).not.toContain(t.slug);
  });

  it("v2: a non-ASCII label gets the fallback slug; a JPEG upload works; sort keeps counting up", async () => {
    const jpeg = await readFile(join(CARD_TEMPLATE_ASSETS, "badi-khabar.jpeg"));
    const res = await upload(admin, "  चुनाव  ", jpeg, "image/jpeg");
    expect(res.status).toBe(201);
    expect(res.body.template).toMatchObject({ label: "चुनाव", width: 1080, height: 1350, createdBy: { id: admin.id, name: "admin" } });
    expect(res.body.template.slug).toMatch(/^tpl-[a-z0-9]{6}$/);
    expect((await rowsOf(orgA)).find((r) => r.slug === res.body.template.slug)!.sort).toBe(3);
  });

  it("v2: refuses who may not upload, a bad image, a wrong size, a bad label and a too-big body", async () => {
    // A viewer cannot edit drafts; signed out is 401; no CSRF is 403 csrf
    expect(await upload(viewer, "Nope", png(1200, 1200))).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect((await upload(null, "Nope", png(1200, 1200))).status).toBe(401);
    const noCsrf = await app.inject({ method: "POST", url: "/card-templates?label=x", payload: png(1200, 1200), headers: { cookie: op.cookie, "content-type": "image/png" } });
    expect([noCsrf.statusCode, JSON.parse(noCsrf.body).error]).toEqual([403, "csrf"]);

    const bad: [string, Promise<{ status: number; body: { error?: string } | null }>][] = [
      ["not an image", upload(op, "Bad", Buffer.from("hello, not an image"), "image/png")],
      ["empty body", upload(op, "Bad", Buffer.alloc(0), "image/png")],
      ["text content type", upload(op, "Bad", Buffer.from("plain"), "text/plain")],
      ["too small", upload(op, "Bad", png(599, 1200))],
      ["too large a side", upload(op, "Bad", png(4001, 1000))],
      ["empty label", upload(op, "   ", png(1200, 1200))],
      ["label over 40", upload(op, "x".repeat(41), png(1200, 1200))],
      ["control character", upload(op, "a\u0007b", png(1200, 1200))],
      ["no label", call(op, "POST", "/card-templates", png(1200, 1200), { "content-type": "image/png" })],
    ];
    for (const [why, p] of bad) {
      const res = await p;
      expect([why, res.status, res.body?.error]).toEqual([why, 400, "invalid"]);
    }
    // 40 characters (Devanagari counts by character, not byte) is fine; the edges 600 and 4000 are fine
    expect((await upload(op2, "क".repeat(40), png(600, 4000))).status).toBe(201);

    const big = Buffer.concat([png(1200, 1200), Buffer.alloc(5 * 1024 * 1024)]);
    expect(await upload(op2, "Big", big)).toMatchObject({ status: 413, body: { error: "too_large" } });
  });

  async function opTemplate() {
    const list = (await call(op, "GET", "/card-templates")).body.templates as { slug: string; label: string; createdBy: { id: string } | null }[];
    return list.find((t) => t.createdBy?.id === op.id && t.slug.startsWith("election-night-"))!;
  }

  it("v2: the uploader renames and moves their own template; another operator gets 403", async () => {
    const mine = await opTemplate();
    const renamed = await call(op, "PATCH", `/card-templates/${mine.slug}`, { label: " Results " });
    expect(renamed).toMatchObject({ status: 200, body: { template: { slug: mine.slug, label: "Results", canEdit: true } } });
    const layout = { ...SQUARE_LAYOUT, date: null, box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };
    expect(await call(op, "PATCH", `/card-templates/${mine.slug}`, { layout })).toMatchObject({ status: 200, body: { template: { layout } } });

    expect(await call(op2, "PATCH", `/card-templates/${mine.slug}`, { label: "Hijack" })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(await call(op2, "PATCH", `/card-templates/${mine.slug}`, { layout: SQUARE_LAYOUT })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(await call(editor, "PATCH", `/card-templates/${mine.slug}`, { label: "Hijack" })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    // An admin may rename anyone's
    expect(await call(admin, "PATCH", `/card-templates/${mine.slug}`, { label: "Results 2026" })).toMatchObject({ status: 200, body: { template: { label: "Results 2026" } } });
    const row = (await rowsOf(orgA)).find((r) => r.slug === mine.slug)!;
    expect(row.label).toBe("Results 2026");
    const renames = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "org_card_template.renamed"), eq(auditLog.entityId, row.id)));
    expect(renames.map((r) => [r.actorId, r.after])).toEqual([[op.id, { label: "Results" }], [admin.id, { label: "Results 2026" }]]);

    // Label limits on PATCH too, and an empty body
    for (const body of [{ label: "" }, { label: "y".repeat(41) }, {}, { label: "ok", extra: 1 }]) {
      const res = await call(admin, "PATCH", `/card-templates/${mine.slug}`, body);
      expect([JSON.stringify(body), res.status, res.body?.error]).toEqual([JSON.stringify(body), 400, "invalid"]);
    }
  });

  it("v2: only an admin sets defaultFor, and a tag lives on one template of the org at a time", async () => {
    const mine = await opTemplate();
    // Even the uploader cannot set default tags; the whole PATCH is refused, nothing written
    expect(await call(op, "PATCH", `/card-templates/${mine.slug}`, { label: "Sneaky", defaultFor: ["breaking"] })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(await call(editor, "PATCH", `/card-templates/${mine.slug}`, { defaultFor: ["breaking"] })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect((await rowsOf(orgA)).find((r) => r.slug === mine.slug)).toMatchObject({ label: "Results 2026", defaultFor: [] });
    expect(await call(admin, "PATCH", `/card-templates/${mine.slug}`, { defaultFor: ["unknown"] })).toMatchObject({ status: 400, body: { error: "invalid" } });

    const res = await call(admin, "PATCH", `/card-templates/${mine.slug}`, { defaultFor: ["breaking", "big_breaking", "breaking"] });
    expect(res).toMatchObject({ status: 200, body: { template: { defaultFor: ["big_breaking", "breaking"] } } });
    const tags = async () => Object.fromEntries((await rowsOf(orgA)).map((r) => [r.slug, r.defaultFor]));
    let now = await tags();
    expect(now["breaking-square"]).toEqual([]);
    expect(now["badi-khabar"]).toEqual([]);
    expect(now[mine.slug]).toEqual(["big_breaking", "breaking"]);
    // Org B keeps its own defaults
    expect((await rowsOf(orgB)).map((r) => r.defaultFor)).toEqual([["breaking"], ["big_breaking"]]);

    // Moving one tag back takes it from the uploaded template only
    expect((await call(admin, "PATCH", "/card-templates/badi-khabar", { defaultFor: ["big_breaking"] })).status).toBe(200);
    now = await tags();
    expect(now["badi-khabar"]).toEqual(["big_breaking"]);
    expect(now[mine.slug]).toEqual(["breaking"]);
    for (const tag of ["breaking", "big_breaking"]) expect(Object.values(now).filter((d) => d.includes(tag as never))).toHaveLength(1);

    const [entry] = await h.db.select().from(auditLog).where(eq(auditLog.action, "org_card_template.defaults_changed")).orderBy(desc(auditLog.at)).limit(1);
    expect(entry).toMatchObject({ actorId: admin.id, before: { defaultFor: [] }, after: { defaultFor: ["big_breaking"], removedFrom: [{ slug: mine.slug, before: ["big_breaking", "breaking"], after: ["breaking"] }] } });

    // Clearing works
    expect(await call(admin, "PATCH", `/card-templates/${mine.slug}`, { defaultFor: [] })).toMatchObject({ status: 200, body: { template: { defaultFor: [] } } });
    // Put the house default back for the next tests
    expect((await call(admin, "PATCH", "/card-templates/breaking-square", { defaultFor: ["breaking"] })).status).toBe(200);
  });

  it("v2: a re-seed keeps renames and default tags", async () => {
    await call(admin, "PATCH", "/card-templates/breaking-square", { label: "Breaking (house)" });
    expect((await seedOrgCardTemplates(h.db, store, orgA)).map((r) => r.slug)).toEqual(["breaking-square", "badi-khabar"]);
    const rows = await rowsOf(orgA);
    expect(rows.find((r) => r.slug === "breaking-square")).toMatchObject({ label: "Breaking (house)", defaultFor: ["breaking"] });
    expect(rows.find((r) => r.slug === "badi-khabar")).toMatchObject({ defaultFor: ["big_breaking"] });
  });

  it("v2: only an admin deletes (204); operators, even the uploader, get 403; unknown is 404", async () => {
    const mine = await opTemplate();
    expect(await call(op, "DELETE", `/card-templates/${mine.slug}`)).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(await call(editor, "DELETE", `/card-templates/${mine.slug}`)).toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(await call(outsider, "DELETE", `/card-templates/${mine.slug}`)).toMatchObject({ status: 404, body: { error: "not_found" } });
    const noCsrf = await app.inject({ method: "DELETE", url: `/card-templates/${mine.slug}`, headers: { cookie: admin.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    const row = (await rowsOf(orgA)).find((r) => r.slug === mine.slug)!;

    const del = await call(admin, "DELETE", `/card-templates/${mine.slug}`);
    expect(del.status).toBe(204);
    expect((await rowsOf(orgA)).some((r) => r.slug === mine.slug)).toBe(false);
    expect(await call(admin, "DELETE", `/card-templates/${mine.slug}`)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await call(admin, "DELETE", "/card-templates/no-such")).toMatchObject({ status: 404, body: { error: "not_found" } });
    const [entry] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "org_card_template.deleted"), eq(auditLog.entityId, row.id)));
    expect(entry).toMatchObject({ actorId: admin.id, after: null, before: { slug: mine.slug, label: "Results 2026", createdBy: op.id } });
    // The stored image may stay (contract)
    expect((await store.get(row.backgroundKey)).length).toBeGreaterThan(0);
  });

  it("v2: a deleted uploader leaves the template unowned (created_by set null)", async () => {
    const [temp] = await h.db.insert(users).values({ orgId: orgA, name: "temp", email: "temp@test", passwordHash: "x", role: "operator" }).returning();
    const [t] = await h.db
      .insert(orgCardTemplates)
      .values({ orgId: orgA, slug: "temp-tpl", label: "Temp", backgroundKey: "k.png", width: 1000, height: 1000, layout: SQUARE_LAYOUT, sort: 99, createdBy: temp!.id })
      .returning();
    expect((await call(admin, "GET", "/card-templates")).body.templates.find((x: { slug: string }) => x.slug === "temp-tpl").createdBy).toEqual({ id: temp!.id, name: "temp" });
    await h.db.delete(users).where(eq(users.id, temp!.id));
    expect((await rowsOf(orgA)).find((r) => r.id === t!.id)!.createdBy).toBeNull();
    expect((await call(admin, "GET", "/card-templates")).body.templates.find((x: { slug: string }) => x.slug === "temp-tpl").createdBy).toBeNull();
  });

  it("v2: a first seed leaves a tag an admin already gave an uploaded template where it is, and audits that", async () => {
    const [c] = await h.db.insert(orgs).values({ name: "Third house", settings: SETTINGS }).returning();
    await h.db.insert(orgCardTemplates).values({ orgId: c!.id, slug: "own-abc123", label: "Own", backgroundKey: "k.png", width: 1000, height: 1000, layout: SQUARE_LAYOUT, defaultFor: ["breaking"], sort: 0 });
    await seedOrgCardTemplates(h.db, store, c!.id);
    expect(Object.fromEntries((await rowsOf(c!.id)).map((r) => [r.slug, r.defaultFor]))).toEqual({ "own-abc123": ["breaking"], "breaking-square": [], "badi-khabar": ["big_breaking"] });
    const created = await h.db.select().from(auditLog).where(and(eq(auditLog.orgId, c!.id), eq(auditLog.action, "org_card_template.created")));
    expect(created.map((e) => (e.after as { keptElsewhere?: string[] }).keptElsewhere ?? null).sort()).toEqual([["breaking"], null]);
  });
});
