// Each user's own card background (contract: handoff/first-india-card-contract.md §2). The desk
// uploads it once per platform and draws every card on it in the browser. A user only ever reaches
// their own row: every query is keyed on the session's user id, never on anything the client sends.

import { createHash } from "node:crypto";
import {
  deleteCardTemplate, getCardTemplate, saveCardBackground, updateCardLayout, type Actor, type CardFiles, type CardTemplate,
} from "@socia/db";
import type { Storage } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { COOKIE, HttpError, guard, loadSession, requirePermission, type SessionUser } from "../auth";
import type { AppDeps } from "../app";
import { SlidingLimiter } from "../limiter";
import { CARD_MAX_BYTES, pngSize } from "./desk";

const actor = (u: SessionUser): Actor => ({ id: u.id, orgId: u.orgId, name: u.name, role: u.role });

const TEMPLATE_MIN_PX = 600;
/** Past this a browser canvas may refuse to draw it */
const TEMPLATE_MAX_PX = 8192;
/** 4096 x 4096: a decoded image this size is already 64 MB in the browser */
const TEMPLATE_MAX_AREA = 16_777_216;
/** Uploads that store a file, per user, in a sliding window. Each replaces the last, so a few is plenty. */
export const UPLOADS_PER_WINDOW = 5;
const UPLOAD_WINDOW_MS = 60_000;

const PlatformQuery = Type.Object({ platform: Type.Optional(Type.Literal("x")) });

const Fraction = Type.Number({ minimum: 0, maximum: 1 });
const Color = Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" });
const Rect = { x: Fraction, y: Fraction, w: Fraction, h: Fraction };
const FontPx = Type.Integer({ minimum: 6, maximum: 400 });

export const Layout = Type.Object(
  {
    date: Type.Object({ ...Rect, color: Color, format: Type.String({ minLength: 1, maxLength: 40 }) }, { additionalProperties: false }),
    box: Type.Object(Rect, { additionalProperties: false }),
    headline: Type.Object({ color: Color }, { additionalProperties: false }),
    body: Type.Object({ color: Color }, { additionalProperties: false }),
    fontMinPx: FontPx,
    fontMaxPx: FontPx,
  },
  { additionalProperties: false },
);

/** EXIF orientation (tag 0x0112) from an APP1 "Exif" segment; 1 when absent or unreadable. */
function exifOrientation(buf: Buffer, start: number, end: number): number {
  if (end - start < 14 || buf.toString("latin1", start, start + 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const order = buf.toString("latin1", tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 1;
  const le = order === "II";
  const u16 = (at: number) => (at + 2 <= end ? (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at)) : -1);
  const u32 = (at: number) => (at + 4 <= end ? (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at)) : -1);
  const ifd = u32(tiff + 4);
  if (ifd < 0) return 1;
  const count = u16(tiff + ifd);
  for (let n = 0; n < count; n++) {
    const entry = tiff + ifd + 2 + n * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Width and height as displayed: from the first SOF marker, swapped when EXIF orientation is 5–8
 * (rotated 90°). Null if not a JPEG; "no_header" if it has no readable frame header.
 */
export function jpegSize(buf: Buffer): { width: number; height: number } | null | "no_header" {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return "no_header";
    const marker = buf[i + 1]!;
    // Fill bytes, and markers with no length (TEM, RSTn)
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // End of image or start of scan before any frame header
    if (marker === 0xd9 || marker === 0xda) return "no_header";
    const length = buf.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > buf.length) return "no_header";
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(buf, i + 4, end);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7) return "no_header";
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return orientation >= 5 ? { width: height, height: width } : { width, height };
    }
    i = end;
  }
  return "no_header";
}

/** The image's type from its first bytes (not from the header the client sent) and its size. */
function readImage(buf: Buffer): { contentType: "image/png" | "image/jpeg"; width: number; height: number } {
  const png = pngSize(buf);
  const jpeg = png === null ? jpegSize(buf) : null;
  const size = png ?? jpeg;
  if (size === null) throw new HttpError(400, "unsupported_type", "Upload the background as a PNG or JPG image.");
  if (size === "no_header") throw new HttpError(400, "invalid", "This image has no readable size. Save it again as PNG or JPG and retry.");
  return { contentType: png ? "image/png" : "image/jpeg", ...size };
}

/** Changes with the image (not with the layout), so a cached copy is never stale. */
const versionOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** Same-origin through the desk's /socia-api proxy, so the canvas stays exportable. */
function backgroundUrl(t: CardTemplate): string {
  return `/me/card-template/background?platform=${t.platform}&v=${versionOf(t.backgroundKey)}`;
}

function templateView(t: CardTemplate | null) {
  if (!t) return null;
  return { platform: t.platform, backgroundUrl: backgroundUrl(t), width: t.width, height: t.height, layout: t.layout, updatedAt: t.updatedAt.toISOString() };
}

const cardFiles = (storage: Storage, body: Buffer, contentType: string): CardFiles => ({
  put: (key) => storage.put(key, body, contentType),
  remove: (key) => storage.delete(key),
});

export const templateRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, storage }) => {
  const limiter = new SlidingLimiter(UPLOADS_PER_WINDOW, UPLOAD_WINDOW_MS);

  app.get("/me/card-template", { schema: { querystring: PlatformQuery } }, async (req) => {
    const { user } = guard(req);
    return { template: templateView(await getCardTemplate(db, actor(user), req.query.platform ?? "x")) };
  });

  app.get(
    "/me/card-template/background",
    { schema: { querystring: Type.Object({ platform: Type.Optional(Type.Literal("x")), v: Type.Optional(Type.String({ maxLength: 64 })) }) } },
    async (req, reply) => {
      const { user } = guard(req);
      const t = await getCardTemplate(db, actor(user), req.query.platform ?? "x");
      if (!t) throw new HttpError(404, "not_found", "You have no card background for this platform.");
      const body = await storage.get(t.backgroundKey).catch(() => null);
      if (!body) throw new HttpError(404, "not_found", "Your card background file is missing. Upload it again in Templates.");
      // Long cache only for the current image's URL; a missing or old v always asks again
      reply.header("cache-control", req.query.v === versionOf(t.backgroundKey) ? "private, max-age=31536000, immutable" : "no-store");
      reply.type(t.backgroundKey.endsWith(".png") ? "image/png" : "image/jpeg");
      return reply.send(body);
    },
  );

  app.patch("/me/card-template", { schema: { querystring: PlatformQuery, body: Type.Object({ layout: Layout }, { additionalProperties: false }) } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "card_template.own");
    const { layout } = req.body;
    if (layout.fontMinPx > layout.fontMaxPx) throw new HttpError(400, "invalid", "fontMinPx cannot be larger than fontMaxPx.");
    for (const [name, r] of [["date", layout.date], ["box", layout.box]] as const) {
      if (r.x + r.w > 1.0001 || r.y + r.h > 1.0001) throw new HttpError(400, "invalid", `The ${name} area runs off the image.`);
    }
    const t = await updateCardLayout(db, actor(user), req.query.platform ?? "x", layout);
    if (!t) throw new HttpError(404, "not_found", "Upload a card background first.");
    return { template: templateView(t) };
  });

  app.delete("/me/card-template", { schema: { querystring: PlatformQuery } }, async (req, reply) => {
    const { user } = guard(req);
    requirePermission(user, "card_template.own");
    await deleteCardTemplate(db, actor(user), req.query.platform ?? "x", { remove: (key) => storage.delete(key) });
    return reply.status(204).send();
  });

  // The image is the raw body. Its parsers live only in this child scope, so no other route takes one;
  // any other content type is read too, so it gets the contract's 400 instead of a bare 415.
  await app.register(async (scope) => {
    // Session and CSRF before the body is read: a signed-out caller never gets to send 5 MB
    scope.addHook("onRequest", async (req) => {
      req.session = await loadSession(db, req.cookies[COOKIE]);
      guard(req);
    });

    const uploads = scope.withTypeProvider<TypeBoxTypeProvider>();
    const raw = { parseAs: "buffer" as const, bodyLimit: CARD_MAX_BYTES };
    uploads.addContentTypeParser(["image/png", "image/jpeg"], raw, (_req, body, done) => done(null, body));
    uploads.addContentTypeParser("*", raw, (_req, body, done) => done(null, body));

    uploads.put("/me/card-template", { bodyLimit: CARD_MAX_BYTES, schema: { querystring: PlatformQuery } }, async (req) => {
      const { user } = guard(req);
      requirePermission(user, "card_template.own");
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "unsupported_type", "Upload the background as a PNG or JPG image.");
      const image = readImage(body);
      const { width, height } = image;
      if (Math.min(width, height) < TEMPLATE_MIN_PX || Math.max(width, height) > TEMPLATE_MAX_PX) {
        throw new HttpError(400, "invalid", `The background must be ${TEMPLATE_MIN_PX} to ${TEMPLATE_MAX_PX} pixels on each side; this one is ${width}x${height}.`);
      }
      if (width * height > TEMPLATE_MAX_AREA) {
        throw new HttpError(400, "invalid", `The background is ${width}x${height}, too many pixels to draw on. Use at most about 4096x4096.`);
      }
      if (!limiter.take(user.id)) throw new HttpError(429, "rate_limited", "Too many uploads in a minute. Wait a moment and try again.");
      const platform = req.query.platform ?? "x";
      const t = await saveCardBackground(db, actor(user), platform, { ...image, bytes: body.length }, cardFiles(storage, body, image.contentType));
      return { template: templateView(t) };
    });
  });
};
