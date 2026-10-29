// Each user's card background: upload, read back, move the drawing areas, replace, remove; and the
// refusals (type, size, signed out, someone else's row, too many uploads). The file on disk follows the
// row: a replace or remove deletes the old file. Needs TEST_DATABASE_URL for the API part.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { DEFAULT_CARD_LAYOUT, auditLog, cardTemplates, createDb, orgs, runMigrations, users, type DbHandle } from "@socia/db";
import { LocalStorage } from "@socia/providers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import type { ApiConfig } from "../src/config";
import { UPLOADS_PER_WINDOW, jpegSize } from "../src/routes/templates";

const URL = process.env.TEST_DATABASE_URL;

function png(width: number, height: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const type = Buffer.from("IHDR", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(13);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, ihdr])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), len, type, ihdr, crc, Buffer.alloc(pad)]);
}

const APP0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

function sof(width: number, height: number, marker = 0xc0): Buffer {
  const frame = Buffer.alloc(19);
  frame.set([0xff, marker, 0x00, 0x11, 0x08]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 3;
  return frame;
}

/** An APP1 Exif segment holding only the orientation tag, little- or big-endian */
function exif(orientation: number, le = true): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(le ? "II" : "MM", 0, "latin1");
  const w16 = (v: number, at: number) => (le ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at));
  const w32 = (v: number, at: number) => (le ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at));
  w16(42, 2);
  w32(8, 4);
  w16(1, 8);
  w16(0x0112, 10);
  w16(3, 12);
  w32(1, 14);
  w16(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** SOI, the given segments, then EOI: all the API reads. */
const jpegOf = (...segments: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xd9])]);
const jpeg = (width: number, height: number, marker = 0xc0) => jpegOf(APP0, sof(width, height, marker));

describe("jpegSize", () => {
  it("reads the frame header after other segments, baseline or progressive", () => {
    expect(jpegSize(jpeg(1200, 1500))).toEqual({ width: 1200, height: 1500 });
    expect(jpegSize(jpeg(800, 600, 0xc2))).toEqual({ width: 800, height: 600 });
  });

  it("skips fill bytes and markers that carry no length", () => {
    expect(jpegSize(jpegOf(APP0, Buffer.from([0xff, 0xff, 0xff]), sof(900, 700)))).toEqual({ width: 900, height: 700 });
    expect(jpegSize(jpegOf(Buffer.from([0xff, 0xd0, 0xff, 0x01]), APP0, sof(900, 700)))).toEqual({ width: 900, height: 700 });
  });

  it("swaps width and height for EXIF orientations 5–8 only", () => {
    expect(jpegSize(jpegOf(exif(6), sof(1200, 700)))).toEqual({ width: 700, height: 1200 });
    expect(jpegSize(jpegOf(exif(8, false), sof(1200, 700)))).toEqual({ width: 700, height: 1200 });
    expect(jpegSize(jpegOf(exif(3), sof(1200, 700)))).toEqual({ width: 1200, height: 700 });
    expect(jpegSize(jpegOf(exif(1), sof(1200, 700)))).toEqual({ width: 1200, height: 700 });
  });

  it("refuses what is not a JPEG, and one with no readable frame header", () => {
    expect(jpegSize(png(800, 800))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBe("no_header");
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("no_header");
    // A frame header shorter than its fields
    expect(jpegSize(jpegOf(Buffer.from([0xff, 0xc0, 0x00, 0x04, 0x08, 0x02])))).toBe("no_header");
    // A segment length that runs past the end of the file
    expect(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff]), Buffer.alloc(20)]))).toBe("no_header");
    // A frame header cut off by the end of the file
    expect(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8]), sof(900, 700).subarray(0, 8)]))).toBe("no_header");
  });
});

(URL ? describe : describe.skip)("card template", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: LocalStorage;
  let storeRoot = "";
  const op = { cookie: "", csrf: "", id: "" };
  const other = { cookie: "", csrf: "", id: "" };
  const racer = { cookie: "", csrf: "", id: "" };
  const spammer = { cookie: "", csrf: "", id: "" };
  type Who = typeof op;

  const config: ApiConfig = {
    databaseUrl: URL ?? "", port: 0, corsOrigins: ["http://localhost:3005"], cookieSecure: false, sessionHours: 12, requireTotp: false,
    secretKey: Buffer.alloc(32, 7).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false,
  };

  async function call(who: Who | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
    const auth = who ? { cookie: who.cookie, "x-csrf": who.csrf } : {};
    const res = await app.inject({ method: method as "GET", url, payload: payload as Record<string, unknown>, headers: { ...auth, ...headers } });
    return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().startsWith("application/json") ? JSON.parse(res.body) : null, raw: res };
  }

  const upload = (who: Who | null, body: Buffer, type = "image/png") => call(who, "PUT", "/me/card-template?platform=x", body, { "content-type": type });
  /** The files stored for a user: only the current one should ever be there */
  const filesOf = async (who: Who) => readdir(join(storeRoot, "card-templates", who.id)).catch(() => [] as string[]);
  const rowOf = async (who: Who) => (await h.db.select().from(cardTemplates).where(eq(cardTemplates.userId, who.id)))[0];

  async function login(email: string, into: Who) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "correct horse battery" } });
    into.cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    into.csrf = JSON.parse(res.body).csrfToken;
  }

  const audits = (action: string, who?: Who) =>
    h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "card_template"), eq(auditLog.action, action), who ? eq(auditLog.actorId, who.id) : undefined));

  beforeAll(async () => {
    h = createDb(URL!, 5);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    const [org] = await h.db
      .insert(orgs)
      .values({ name: "1st India", settings: { hashtagScript: "latin", fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 } })
      .returning();
    const passwordHash = await hashPassword("correct horse battery");
    const people: [Who, string, "operator" | "viewer"][] = [[op, "op", "operator"], [other, "viewer", "viewer"], [racer, "racer", "operator"], [spammer, "spammer", "operator"]];
    for (const [who, name, role] of people) {
      const [u] = await h.db.insert(users).values({ orgId: org!.id, name, email: `${name}@test`, passwordHash, role }).returning();
      who.id = u!.id;
    }
    storeRoot = await mkdtemp(join(tmpdir(), "socia-tpl-"));
    store = new LocalStorage(storeRoot, "http://localhost/dev-files");
    app = await buildApp({ db: h.db, storage: store, config }, false);
    for (const [who, name] of people) await login(`${name}@test`, who);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("starts with no template, and needs a session for every call", async () => {
    expect(await call(op, "GET", "/me/card-template?platform=x")).toMatchObject({ status: 200, body: { template: null } });
    expect((await call(op, "GET", "/me/card-template?platform=instagram")).status).toBe(400);
    expect((await call(null, "GET", "/me/card-template?platform=x")).status).toBe(401);
    expect(await upload(null, png(1080, 1080, 4 * 1024 * 1024))).toMatchObject({ status: 401, body: { error: "signed_out" } });
    expect((await call(null, "PATCH", "/me/card-template?platform=x", { layout: DEFAULT_CARD_LAYOUT })).status).toBe(401);
    expect((await call(null, "DELETE", "/me/card-template?platform=x")).status).toBe(401);
    expect((await call(null, "GET", "/me/card-template/background?platform=x")).status).toBe(401);
  });

  it("refuses a missing CSRF token, the wrong type, a bad size and a big file", async () => {
    const noCsrf = await app.inject({ method: "PUT", url: "/me/card-template?platform=x", payload: png(1080, 1080), headers: { cookie: op.cookie, "content-type": "image/png" } });
    expect(noCsrf.statusCode).toBe(403);
    expect(JSON.parse(noCsrf.body).error).toBe("csrf");
    expect(await upload(op, Buffer.from("GIF89a-------------"), "image/gif")).toMatchObject({ status: 400, body: { error: "unsupported_type" } });
    expect(await upload(op, Buffer.from("not an image at all"), "application/octet-stream")).toMatchObject({ status: 400, body: { error: "unsupported_type" } });
    expect(await upload(op, Buffer.from(JSON.stringify({ image: "x" })), "application/json")).toMatchObject({ status: 400, body: { error: "unsupported_type" } });
    expect(await upload(op, png(599, 1080))).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(await upload(op, jpeg(1080, 500), "image/jpeg")).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(await upload(op, png(8193, 1080))).toMatchObject({ status: 400, body: { error: "invalid" } });
    // Each side allowed, but 8000 x 3000 is over the 16.7 M pixel cap
    expect(await upload(op, png(8000, 3000))).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(await upload(op, png(1080, 1080, 5 * 1024 * 1024))).toMatchObject({ status: 413, body: { error: "too_large" } });
    expect(await h.db.select().from(cardTemplates)).toEqual([]);
    expect(await filesOf(op)).toEqual([]);
  });

  it("creates the template with the default layout, and serves the image back", async () => {
    const file = png(1080, 1350, 64);
    const up = await upload(op, file);
    expect(up.status).toBe(200);
    const t = up.body.template;
    expect(t).toMatchObject({ platform: "x", width: 1080, height: 1350, layout: DEFAULT_CARD_LAYOUT });
    expect(t.backgroundUrl).toMatch(/^\/me\/card-template\/background\?platform=x&v=[0-9a-f]{16}$/);
    expect(new Date(t.updatedAt).toISOString()).toBe(t.updatedAt);
    expect(await call(op, "GET", "/me/card-template")).toMatchObject({ status: 200, body: { template: t } });

    const img = await call(op, "GET", t.backgroundUrl);
    expect(img.status).toBe(200);
    expect(img.raw.headers["content-type"]).toBe("image/png");
    expect(img.raw.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(img.raw.rawPayload.equals(file)).toBe(true);
    // Without the current v, never cached
    expect((await call(op, "GET", "/me/card-template/background?platform=x")).raw.headers["cache-control"]).toBe("no-store");
    expect((await call(op, "GET", "/me/card-template/background?platform=x&v=0000000000000000")).raw.headers["cache-control"]).toBe("no-store");

    const row = await rowOf(op);
    expect(row!.backgroundKey).toMatch(new RegExp(`^card-templates/${op.id}/x-[0-9a-f-]{36}\\.png$`));
    expect(await filesOf(op)).toEqual([row!.backgroundKey.split("/").pop()]);
    const [a] = await audits("card_template.created", op);
    expect(a).toMatchObject({ actorId: op.id, entityId: row!.id, before: null, after: { platform: "x", key: row!.backgroundKey, contentType: "image/png", bytes: file.length, width: 1080, height: 1350 } });
  });

  it("changes the layout, and refuses a bad one", async () => {
    const layout = { ...DEFAULT_CARD_LAYOUT, box: { x: 0.05, y: 0.3, w: 0.9, h: 0.6 }, fontMaxPx: 64 };
    const before = (await call(op, "GET", "/me/card-template")).body.template;
    const ok = await call(op, "PATCH", "/me/card-template?platform=x", { layout });
    expect(ok).toMatchObject({ status: 200, body: { template: { layout } } });
    // The image did not change, so neither does its URL
    expect(ok.body.template.backgroundUrl).toBe(before.backgroundUrl);
    expect((await audits("card_template.layout_changed", op)).length).toBe(1);

    const bad = [
      { ...layout, box: { ...layout.box, x: 1.5 } },
      { ...layout, box: { x: 0.5, y: 0.3, w: 0.6, h: 0.6 } },
      { ...layout, fontMinPx: 70 },
      { ...layout, headline: { color: "yellow" } },
      { ...layout, extra: true },
    ];
    for (const b of bad) expect((await call(op, "PATCH", "/me/card-template?platform=x", { layout: b })).status).toBe(400);
    expect((await call(op, "PATCH", "/me/card-template?platform=x", {})).status).toBe(400);
  });

  it("replaces the image, keeping the layout; the URL changes and the old file goes", async () => {
    const before = (await call(op, "GET", "/me/card-template")).body.template;
    const oldKey = (await rowOf(op))!.backgroundKey;
    // Orientation 6: stored 1500 x 1200, shown 1200 x 1500
    const up = await upload(op, jpegOf(exif(6), sof(1500, 1200)), "image/jpeg");
    expect(up.status).toBe(200);
    expect(up.body.template).toMatchObject({ width: 1200, height: 1500, layout: before.layout });
    expect(up.body.template.backgroundUrl).not.toBe(before.backgroundUrl);
    const img = await call(op, "GET", up.body.template.backgroundUrl);
    expect(img.raw.headers["content-type"]).toBe("image/jpeg");
    // The URL the desk still holds no longer gets a long cache
    expect((await call(op, "GET", before.backgroundUrl)).raw.headers["cache-control"]).toBe("no-store");

    const row = await rowOf(op);
    expect(await filesOf(op)).toEqual([row!.backgroundKey.split("/").pop()]);
    const [a] = await audits("card_template.replaced", op);
    expect(a).toMatchObject({ before: { key: oldKey, width: 1080, height: 1350 }, after: { contentType: "image/jpeg", width: 1200, height: 1500 } });
    expect(await h.db.select().from(cardTemplates)).toHaveLength(1);
  });

  it("sniffs the type from the bytes: a PNG sent as image/jpeg is stored as a PNG", async () => {
    const up = await upload(op, png(900, 900), "image/jpeg");
    expect(up.status).toBe(200);
    expect((await rowOf(op))!.backgroundKey).toMatch(/\.png$/);
    expect((await call(op, "GET", up.body.template.backgroundUrl)).raw.headers["content-type"]).toBe("image/png");
    expect(await filesOf(op)).toHaveLength(1);
  });

  it("keeps each user to their own row", async () => {
    expect((await call(other, "GET", "/me/card-template")).body).toEqual({ template: null });
    expect((await call(other, "GET", "/me/card-template/background?platform=x")).status).toBe(404);
    expect((await call(other, "PATCH", "/me/card-template", { layout: DEFAULT_CARD_LAYOUT })).status).toBe(404);
    expect((await call(other, "DELETE", "/me/card-template?platform=x")).status).toBe(204);
    expect((await call(op, "GET", "/me/card-template")).body.template).not.toBeNull();
    expect(await filesOf(op)).toHaveLength(1);

    const mine = await upload(other, png(800, 800));
    expect(mine.status).toBe(200);
    expect(mine.body.template.layout).toEqual(DEFAULT_CARD_LAYOUT);
    expect(await h.db.select().from(cardTemplates)).toHaveLength(2);
  });

  it("answers 404, not 500, when the stored file is gone", async () => {
    const row = (await h.db.select().from(cardTemplates).where(eq(cardTemplates.userId, other.id)))[0]!;
    await rm(join(storeRoot, row.backgroundKey));
    expect(await call(other, "GET", "/me/card-template/background?platform=x")).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("removes the template and its file", async () => {
    const res = await call(op, "DELETE", "/me/card-template?platform=x");
    expect(res.status).toBe(204);
    expect(res.raw.body).toBe("");
    expect(await filesOf(op)).toEqual([]);
    expect((await call(op, "GET", "/me/card-template")).body).toEqual({ template: null });
    expect((await call(op, "GET", "/me/card-template/background?platform=x")).status).toBe(404);
    expect((await call(op, "PATCH", "/me/card-template", { layout: DEFAULT_CARD_LAYOUT })).status).toBe(404);
    const [a] = await audits("card_template.deleted", op);
    expect(a).toMatchObject({ actorId: op.id, after: null, before: { platform: "x", width: 900, height: 900 } });
    // The other user's template is untouched
    expect((await call(other, "GET", "/me/card-template")).body.template).toMatchObject({ width: 800 });
  });

  it("takes two first uploads at once as one create and one replace, leaving one row and one file", async () => {
    const [a, b] = await Promise.all([upload(racer, png(1000, 1000)), upload(racer, jpeg(1100, 1100), "image/jpeg")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await h.db.select().from(cardTemplates).where(eq(cardTemplates.userId, racer.id));
    expect(rows).toHaveLength(1);
    expect(await audits("card_template.created", racer)).toHaveLength(1);
    expect(await audits("card_template.replaced", racer)).toHaveLength(1);
    expect(await filesOf(racer)).toEqual([rows[0]!.backgroundKey.split("/").pop()]);
  });

  it("limits stored uploads per user per minute; refused uploads do not count", async () => {
    for (let n = 0; n < 3; n++) expect((await upload(spammer, png(100, 100))).status).toBe(400);
    for (let n = 0; n < UPLOADS_PER_WINDOW; n++) expect((await upload(spammer, png(700, 700))).status).toBe(200);
    expect(await upload(spammer, png(700, 700))).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(await filesOf(spammer)).toHaveLength(1);
    // Someone else is not affected
    expect((await upload(racer, png(700, 700))).status).toBe(200);
  });
});
