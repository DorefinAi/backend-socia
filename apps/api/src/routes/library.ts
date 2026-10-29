// The library: hashtag rules, the verified handle directory, and Wikidata staging. Changing them needs
// the Settings permission (editors and admins by default); every role can search handles (the @
// dropdown in the editor).
//
// Schemas are strict (unknown keys → 400) and every insert/update is built from named fields only, so a
// client can never set orgId, id, verifiedAt, source or any other column.

import { audit, handleDirectory, handleDirectoryStaging, hashtagRules } from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox, type Static } from "@fastify/type-provider-typebox";
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { HttpError, guard, requirePermission } from "../auth";
import type { AppDeps } from "../app";

const Id = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
const bare = (handle: string) => handle.replace(/^@/, "");
const Search = Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false });
const Tag = Type.String({ minLength: 1, maxLength: 80 });

const RuleBody = Type.Object({
  matchType: Type.Union([Type.Literal("city"), Type.Literal("district"), Type.Literal("entity")]),
  name: Type.String({ minLength: 1, maxLength: 120 }),
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 30 }),
  hashtagLatin: Tag,
  hashtagDevanagari: Type.Optional(Type.Union([Tag, Type.Null()])),
  priority: Type.Integer({ minimum: 0, maximum: 1000 }),
  /** The rule does not fire from a sentence that also has one of these (e.g. "टल गया" on the accident rule) */
  negativePhrases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 30 })),
}, { additionalProperties: false });

const HandleBody = Type.Object({
  entityName: Type.String({ minLength: 1, maxLength: 200 }),
  entityNameHi: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  aliases: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 }),
  handle: Type.String({ pattern: "^@?\\w{1,15}$" }),
  priority: Type.Integer({ minimum: 0, maximum: 1000 }),
}, { additionalProperties: false });
const RulePatch = Type.Partial(RuleBody, { additionalProperties: false });
const HandlePatch = Type.Partial(HandleBody, { additionalProperties: false });

type RuleFields = Partial<Static<typeof RuleBody>>;
type HandleFields = Partial<Static<typeof HandleBody>>;

/** Only the columns a client may set on a hashtag rule */
const ruleFields = (b: RuleFields) => ({
  ...(b.matchType !== undefined && { matchType: b.matchType }),
  ...(b.name !== undefined && { name: b.name }),
  ...(b.aliases !== undefined && { aliases: b.aliases }),
  ...(b.hashtagLatin !== undefined && { hashtagLatin: b.hashtagLatin }),
  ...(b.hashtagDevanagari !== undefined && { hashtagDevanagari: b.hashtagDevanagari }),
  ...(b.priority !== undefined && { priority: b.priority }),
  ...(b.negativePhrases !== undefined && { negativePhrases: b.negativePhrases }),
});

/** Only the columns a client may set on a handle */
const handleFields = (b: HandleFields) => ({
  ...(b.entityName !== undefined && { entityName: b.entityName }),
  ...(b.entityNameHi !== undefined && { entityNameHi: b.entityNameHi }),
  ...(b.aliases !== undefined && { aliases: b.aliases }),
  ...(b.handle !== undefined && { handle: bare(b.handle) }),
  ...(b.priority !== undefined && { priority: b.priority }),
});


export const libraryRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db }) => {
  // ─── Hashtag rules ─────────────────────────────────────────────────────────

  app.get("/hashtag-rules", async (req) => {
    const { user } = guard(req);
    return { items: await db.select().from(hashtagRules).where(and(eq(hashtagRules.orgId, user.orgId), eq(hashtagRules.active, true))).orderBy(desc(hashtagRules.priority), asc(hashtagRules.name)) };
  });

  app.post("/hashtag-rules", { schema: { body: RuleBody } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    const b = req.body;
    const [row] = await db
      .insert(hashtagRules)
      .values({ orgId: user.orgId, matchType: b.matchType, name: b.name, aliases: b.aliases, hashtagLatin: b.hashtagLatin, hashtagDevanagari: b.hashtagDevanagari ?? null, priority: b.priority, negativePhrases: b.negativePhrases ?? [] })
      .returning();
    await audit(db, { orgId: user.orgId, actorId: user.id, action: "hashtag_rule.create", entityType: "hashtag_rule", entityId: row!.id, after: row });
    return row;
  });

  app.patch("/hashtag-rules/:id", { schema: { params: Id, body: RulePatch } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    const [before] = await db.select().from(hashtagRules).where(and(eq(hashtagRules.id, req.params.id), eq(hashtagRules.orgId, user.orgId)));
    if (!before) throw new HttpError(404, "not_found", "This rule does not exist.");
    const [row] = await db
      .update(hashtagRules)
      .set({ ...ruleFields(req.body), updatedAt: sql`now()` })
      .where(and(eq(hashtagRules.id, req.params.id), eq(hashtagRules.orgId, user.orgId)))
      .returning();
    await audit(db, { orgId: user.orgId, actorId: user.id, action: "hashtag_rule.update", entityType: "hashtag_rule", entityId: req.params.id, before, after: row });
    return row;
  });

  app.delete("/hashtag-rules/:id", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    await db.update(hashtagRules).set({ active: false, updatedAt: sql`now()` }).where(and(eq(hashtagRules.id, req.params.id), eq(hashtagRules.orgId, user.orgId)));
    await audit(db, { orgId: user.orgId, actorId: user.id, action: "hashtag_rule.delete", entityType: "hashtag_rule", entityId: req.params.id });
    return { ok: true };
  });

  // ─── Handle directory (verified only) ──────────────────────────────────────

  app.get("/handles", { schema: { querystring: Search } }, async (req) => {
    const { user } = guard(req);
    const q = req.query.q?.trim();
    const like = q ? `%${q.replace(/[%_]/g, "\\$&")}%` : null;
    return {
      items: await db
        .select()
        .from(handleDirectory)
        .where(
          and(
            eq(handleDirectory.orgId, user.orgId),
            isNotNull(handleDirectory.verifiedAt),
            like ? or(ilike(handleDirectory.entityName, like), ilike(handleDirectory.entityNameHi, like), ilike(handleDirectory.handle, like), sql`array_to_string(${handleDirectory.aliases}, ' ') ILIKE ${like}`) : undefined,
          ),
        )
        .orderBy(desc(handleDirectory.priority), asc(handleDirectory.entityName))
        .limit(50),
    };
  });

  app.post("/handles", { schema: { body: HandleBody } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    const [row] = await db
      .insert(handleDirectory)
      .values({
        orgId: user.orgId, entityName: req.body.entityName, entityNameHi: req.body.entityNameHi ?? null, aliases: req.body.aliases, handle: bare(req.body.handle),
        priority: req.body.priority, source: "manual", verifiedAt: new Date(), verifiedBy: user.id,
      })
      .returning();
    await audit(db, { orgId: user.orgId, actorId: user.id, action: "handle.create", entityType: "handle", entityId: row!.id, after: row });
    return row;
  });

  app.patch("/handles/:id", { schema: { params: Id, body: HandlePatch } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    const [before] = await db.select().from(handleDirectory).where(and(eq(handleDirectory.id, req.params.id), eq(handleDirectory.orgId, user.orgId)));
    if (!before) throw new HttpError(404, "not_found", "This handle does not exist.");
    // Changing who a handle points at is a new verification
    const [row] = await db
      .update(handleDirectory)
      .set({ ...handleFields(req.body), verifiedAt: new Date(), verifiedBy: user.id })
      .where(and(eq(handleDirectory.id, req.params.id), eq(handleDirectory.orgId, user.orgId)))
      .returning();
    await audit(db, { orgId: user.orgId, actorId: user.id, action: "handle.update", entityType: "handle", entityId: req.params.id, before, after: row });
    return row;
  });

  app.delete("/handles/:id", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    const [before] = await db.delete(handleDirectory).where(and(eq(handleDirectory.id, req.params.id), eq(handleDirectory.orgId, user.orgId))).returning();
    if (before) await audit(db, { orgId: user.orgId, actorId: user.id, action: "handle.delete", entityType: "handle", entityId: req.params.id, before });
    return { ok: true };
  });

  // ─── Wikidata staging ──────────────────────────────────────────────────────

  app.get("/handles/staging", { schema: { querystring: Search } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    const like = req.query.q ? `%${req.query.q.trim().replace(/[%_]/g, "\\$&")}%` : null;
    return {
      items: await db
        .select()
        .from(handleDirectoryStaging)
        .where(
          and(
            eq(handleDirectoryStaging.orgId, user.orgId),
            isNull(handleDirectoryStaging.promotedAt),
            isNull(handleDirectoryStaging.dismissedAt),
            like ? or(ilike(handleDirectoryStaging.entityName, like), ilike(handleDirectoryStaging.entityNameHi, like), ilike(handleDirectoryStaging.handle, like)) : undefined,
          ),
        )
        .orderBy(asc(handleDirectoryStaging.entityName))
        .limit(100),
    };
  });

  app.post(
    "/handles/staging/:id/promote",
    { schema: { params: Id, body: Type.Object(
          { aliases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 })), priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requirePermission(user, "page.settings");
      return db.transaction(async (tx) => {
        const [s] = await tx.select().from(handleDirectoryStaging).where(and(eq(handleDirectoryStaging.id, req.params.id), eq(handleDirectoryStaging.orgId, user.orgId))).for("update");
        if (!s || s.promotedAt) throw new HttpError(404, "not_found", "This suggestion is gone or already added.");
        const [row] = await tx
          .insert(handleDirectory)
          .values({
            orgId: user.orgId, entityName: s.entityName, entityNameHi: s.entityNameHi, aliases: req.body.aliases ?? s.aliases, platform: s.platform,
            handle: s.handle, priority: req.body.priority ?? 0, source: `${s.source}:${s.sourceId}`, verifiedAt: new Date(), verifiedBy: user.id,
          })
          .returning();
        await tx.update(handleDirectoryStaging).set({ promotedAt: new Date() }).where(eq(handleDirectoryStaging.id, s.id));
        await audit(tx, { orgId: user.orgId, actorId: user.id, action: "handle.promote", entityType: "handle", entityId: row!.id, before: s, after: row });
        return row;
      });
    },
  );

  app.post("/handles/staging/:id/dismiss", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "page.settings");
    await db.update(handleDirectoryStaging).set({ dismissedAt: new Date() }).where(and(eq(handleDirectoryStaging.id, req.params.id), eq(handleDirectoryStaging.orgId, user.orgId)));
    return { ok: true };
  });
};
