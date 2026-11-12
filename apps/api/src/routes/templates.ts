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
import { jpegSize, pngSize } from "../image-size";
import { CARD_MAX_BYTES } from "./desk";

export { jpegSize };

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

const DateSlot = Type.Object({ ...Rect, color: Color, format: Type.String({ minLength: 1, maxLength: 40 }) }, { additionalProperties: false });
const layoutFields = {
  box: Type.Object(Rect, { additionalProperties: false }),
  headline: Type.Object({ color: Color }, { additionalProperties: false }),
  body: Type.Object({ color: Color }, { additionalProperties: false }),
  fontMinPx: FontPx,
  fontMaxPx: FontPx,
};

export const Layout = Type.Object({ date: DateSlot, ...layoutFields }, { additionalProperties: false });
/** An org template's layout: the same, except a design may have no date (null) */
export const OrgLayout = Type.Object({ date: Type.Union([DateSlot, Type.Null()]), ...layoutFields }, { additionalProperties: false });

type Rect = { x: number; y: number; w: number; h: number };

/** The rules the schema cannot say: font range in order, every area non-empty and inside the image. 400 otherwise. */
export function checkLayout(layout: { date: Rect | null; box: Rect; fontMinPx: number; fontMaxPx: number }): void {
  if (layout.fontMinPx > layout.fontMaxPx) throw new HttpError(400, "invalid", "fontMinPx cannot be larger than fontMaxPx.");
  for (const [name, r] of [["date", layout.date], ["box", layout.box]] as const) {
    // A zero-size area breaks font fitting
    if (r && (r.w <= 0 || r.h <= 0)) throw new HttpError(400, "invalid", `The ${name} area has no width or height.`);
    if (r && (r.x + r.w > 1.0001 || r.y + r.h > 1.0001)) throw new HttpError(400, "invalid", `The ${name} area runs off the image.`);
  }
}

/** The image's type from its first bytes (not from the header the client sent) and its size. */
export function readImage(buf: Buffer): { contentType: "image/png" | "image/jpeg"; width: number; height: number } {
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
  app.addHook("onClose", async () => limiter.close());

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
    checkLayout(layout);
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
