// The org's shared card designs (contract: dev-docs/org-card-templates-contract.md). Anyone signed in reads
// their own org's templates and images. Desk users who may edit drafts upload more (v2); the uploader or an
// admin renames one and moves its areas; only an admin sets the default tags or deletes one. The org always
// comes from the session, so another org's template is simply not found (404), never readable.

import { createHash, randomBytes } from "node:crypto";
import {
  changeOrgCardTemplate, createOrgCardTemplate, deleteOrgCardTemplate, getOrgCardTemplate, listOrgCardTemplates,
  ORG_TEMPLATE_DEFAULT_FOR, type Actor, type OrgCardLayout, type OrgCardTemplate, type OrgCardTemplateRow,
} from "@socia/db";
import { isMissingObject } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox, type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { COOKIE, HttpError, guard, loadSession, requirePermission, type SessionUser } from "../auth";
import type { AppDeps } from "../app";
import { SlidingLimiter } from "../limiter";
import { CARD_MAX_BYTES } from "./desk";
import { OrgLayout, UPLOADS_PER_WINDOW, checkLayout, readImage } from "./templates";

const actor = (u: SessionUser): Actor => ({ id: u.id, orgId: u.orgId, name: u.name, role: u.role });

/**
 * "Admin" in this access model is the built-in admin role (the one that always keeps users.manage and
 * roles.manage). There is no separate owner role in an org: the owner console acts from outside the desk.
 */
export const isAdmin = (u: SessionUser): boolean => u.role === "admin";

/** Uploading a shared template is part of making cards, so it goes with editing drafts. */
const UPLOAD_PERMISSION = "draft.edit" as const;

const PlatformQuery = Type.Object({ platform: Type.Optional(Type.Literal("x")) });
const SlugParams = Type.Object({ slug: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 40 }) });
/** Checked again after trimming (checkLabel); the schema only keeps absurd input out */
const LabelText = Type.String({ maxLength: 200 });
const DefaultForList = Type.Array(Type.Union(ORG_TEMPLATE_DEFAULT_FOR.map((t) => Type.Literal(t))), { maxItems: 10 });

const UPLOAD_MIN_PX = 600;
const UPLOAD_MAX_PX = 4000;
const UPLOAD_WINDOW_MS = 60_000;
const LABEL_MAX = 40;

/** What an uploaded template starts with: no date, a centred text box */
export const UPLOAD_DEFAULT_LAYOUT: OrgCardLayout = {
  date: null,
  box: { x: 0.08, y: 0.25, w: 0.84, h: 0.6 },
  headline: { color: "#FFFFFF" },
  body: { color: "#FFFFFF" },
  fontMinPx: 18,
  fontMaxPx: 60,
};

/** Trimmed, NFC; 1 to 40 characters, no control characters. 400 invalid otherwise. */
export function checkLabel(raw: string): string {
  const label = raw.normalize("NFC").trim();
  const length = [...label].length;
  if (length < 1 || length > LABEL_MAX) throw new HttpError(400, "invalid", `The name must be 1 to ${LABEL_MAX} characters.`);
  if (/\p{Cc}/u.test(label)) throw new HttpError(400, "invalid", "The name cannot contain control characters.");
  return label;
}

/** ASCII slug from the label (fallback "tpl") plus a short random suffix; at most 40 characters. */
export function slugFor(label: string): string {
  const base = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return `${base || "tpl"}-${randomBytes(4).toString("hex").slice(0, 6)}`;
}

/** Changes whenever the row does (a new image or layout), so a cached image is never stale. */
const versionOf = (t: OrgCardTemplate) => String(t.updatedAt.getTime());

/** Same-origin through the desk's /socia-api proxy, so the canvas stays exportable. */
const backgroundUrl = (t: OrgCardTemplate) => `/card-templates/${t.slug}/background?v=${versionOf(t)}`;

const canEditOf = (user: SessionUser, t: OrgCardTemplate) =>
  isAdmin(user) || (t.createdBy !== null && t.createdBy === user.id && user.permissions.has(UPLOAD_PERMISSION));

export function orgTemplateView(t: OrgCardTemplateRow, user: SessionUser) {
  return {
    slug: t.slug, label: t.label, platform: t.platform as "x", backgroundUrl: backgroundUrl(t), width: t.width, height: t.height,
    layout: t.layout, defaultFor: t.defaultFor, updatedAt: t.updatedAt.toISOString(),
    createdBy: t.createdBy ? { id: t.createdBy, name: t.createdByName ?? "" } : null,
    canEdit: canEditOf(user, t),
    canDelete: isAdmin(user),
    canSetDefault: isAdmin(user),
  };
}

const NOT_FOUND = () => new HttpError(404, "not_found", "There is no such card template.");

export const orgTemplateRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, storage }) => {
  const limiter = new SlidingLimiter(UPLOADS_PER_WINDOW, UPLOAD_WINDOW_MS);
  app.addHook("onClose", async () => limiter.close());

  app.get("/card-templates", { schema: { querystring: PlatformQuery } }, async (req) => {
    const { user } = guard(req);
    const rows = await listOrgCardTemplates(db, user.orgId, req.query.platform ?? "x");
    return { templates: rows.map((t) => orgTemplateView(t, user)) };
  });

  app.get(
    "/card-templates/:slug/background",
    { schema: { params: SlugParams, querystring: Type.Object({ platform: Type.Optional(Type.Literal("x")), v: Type.Optional(Type.String({ maxLength: 64 })) }) } },
    async (req, reply) => {
      const { user } = guard(req);
      const t = await getOrgCardTemplate(db, user.orgId, req.query.platform ?? "x", req.params.slug);
      if (!t) throw NOT_FOUND();
      const body = await storage.get(t.backgroundKey).catch((e) => {
        // Only a missing file is a 404; any other storage failure is a logged 500
        if (isMissingObject(e)) return null;
        throw e;
      });
      if (!body) throw new HttpError(404, "not_found", "This card template's image is missing. Ask an admin to seed the card templates again.");
      // Long cache only for the current version's URL; a missing or old v always asks again
      reply.header("cache-control", req.query.v === versionOf(t) ? "private, max-age=31536000, immutable" : "no-store");
      reply.type(t.backgroundKey.endsWith(".png") ? "image/png" : "image/jpeg");
      return reply.send(body);
    },
  );

  app.patch(
    "/card-templates/:slug",
    {
      schema: {
        params: SlugParams,
        querystring: PlatformQuery,
        body: Type.Object({ label: Type.Optional(LabelText), layout: Type.Optional(OrgLayout), defaultFor: Type.Optional(DefaultForList) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      const { label, layout, defaultFor } = req.body;
      if (label === undefined && layout === undefined && defaultFor === undefined) throw new HttpError(400, "invalid", "Send a label, a layout or defaultFor.");
      const change = { label: label === undefined ? undefined : checkLabel(label), layout, defaultFor };
      if (layout) checkLayout(layout);
      // Decided on the row as it is under the lock (its uploader), before anything is written
      const t = await changeOrgCardTemplate(db, actor(user), req.query.platform ?? "x", req.params.slug, change, (before) => {
        if ((label !== undefined || layout !== undefined) && !canEditOf(user, before)) {
          throw new HttpError(403, "forbidden", "Only the person who uploaded this template, or an admin, can rename it or move its areas.");
        }
        if (defaultFor !== undefined && !isAdmin(user)) throw new HttpError(403, "forbidden", "Only an admin can choose which stories open on a template.");
      });
      if (!t) throw NOT_FOUND();
      return { template: orgTemplateView(t, user) };
    },
  );

  app.delete("/card-templates/:slug", { schema: { params: SlugParams, querystring: PlatformQuery } }, async (req, reply) => {
    const { user } = guard(req);
    if (!isAdmin(user)) throw new HttpError(403, "forbidden", "Only an admin can delete a card template.");
    if (!(await deleteOrgCardTemplate(db, actor(user), req.query.platform ?? "x", req.params.slug))) throw NOT_FOUND();
    return reply.status(204).send();
  });

  // The image is the raw body. Its parsers live only in this child scope, so no other route takes one;
  // any other content type is read too, so it gets a 400 instead of a bare 415.
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

    uploads.post(
      "/card-templates",
      { bodyLimit: CARD_MAX_BYTES, schema: { querystring: Type.Object({ platform: Type.Optional(Type.Literal("x")), label: LabelText }) } },
      async (req, reply) => {
        const { user } = guard(req);
        const platform = req.query.platform ?? "x";
        requirePermission(user, UPLOAD_PERMISSION, platform);
        const label = checkLabel(req.query.label);
        const body = req.body as unknown;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "invalid", "Upload the template as a PNG or JPG image.");
        let image: ReturnType<typeof readImage>;
        try {
          image = readImage(body);
        } catch (e) {
          // The contract has one code for a bad image
          if (e instanceof HttpError) throw new HttpError(400, "invalid", e.message);
          throw e;
        }
        const { width, height } = image;
        if (Math.min(width, height) < UPLOAD_MIN_PX || Math.max(width, height) > UPLOAD_MAX_PX) {
          throw new HttpError(400, "invalid", `The template must be ${UPLOAD_MIN_PX} to ${UPLOAD_MAX_PX} pixels on each side; this one is ${width}x${height}.`);
        }
        if (!limiter.take(user.id)) throw new HttpError(429, "rate_limited", "Too many uploads in a minute. Wait a moment and try again.");

        const ext = image.contentType === "image/png" ? "png" : "jpg";
        const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
        // A clash on the random suffix is next to impossible; try a few before giving up
        for (let attempt = 0; attempt < 3; attempt++) {
          const slug = slugFor(label);
          const key = `card-templates/org/${user.orgId}/${slug}-${hash}.${ext}`;
          await storage.put(key, body, image.contentType);
          const t = await createOrgCardTemplate(db, actor(user), { platform, slug, label, backgroundKey: key, width, height, layout: UPLOAD_DEFAULT_LAYOUT })
            .catch(async (e) => {
              await storage.delete(key).catch(() => undefined);
              throw e;
            });
          if (t) return reply.status(201).send({ template: orgTemplateView(t, user) });
          await storage.delete(key).catch(() => undefined);
        }
        throw new HttpError(409, "conflict", "Could not name the template. Try again.");
      },
    );
  });
};
