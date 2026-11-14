// The library: hashtag rules, the verified handle directory, and Wikidata staging. Changing them needs
// the Settings permission (editors and admins by default); every role can search handles (the @
// dropdown in the editor). One exception: anyone who can edit drafts adds a new handle straight from a
// post's tag line (POST /handles/desk, owner decision: no approval), with keywords found inside it.
//
// Schemas are strict (unknown keys → 400) and every insert/update is built from named fields only, so a
// client can never set orgId, id, verifiedAt, source or any other column.

import { fileLookalike } from "@socia/core";
import { audit, handleDirectory, handleDirectoryStaging, hashtagRules } from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox, type Static } from "@fastify/type-provider-typebox";
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { HttpError, guard, requirePermission } from "../auth";
import type { AppDeps } from "../app";
import { DeskHandleChecks } from "../handle-keywords";
import { HANDLE_SEARCH_LIMIT, HandleSearchFiles, mergeResults, prefixPattern, searchEntries, searchQuery, type HandleSearchItem } from "../handle-search";
import { SlidingLimiter } from "../limiter";

const Id = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
const bare = (handle: string) => handle.replace(/^@/, "");
const Search = Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false });
/**
 * GET /handles: without `mode`, the Settings list (substring match, full rows, 50). mode=prefix is the editor's @ / #
 * lookup (handle-search.ts): exact prefix, verified only, HANDLE_SEARCH_LIMIT results as HandleSearchItem.
 */
const HandleSearch = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  mode: Type.Optional(Type.Literal("prefix")),
  kind: Type.Optional(Type.Union([Type.Literal("mention"), Type.Literal("hashtag")])),
}, { additionalProperties: false });
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
const DeskHandleBody = Type.Object({ handle: Type.String({ pattern: "^@?\\w{1,15}$" }) }, { additionalProperties: false });
/** New handles one person may add from the desk per window; returning a handle the org already has is not counted */
export const DESK_HANDLE_ADDS = 20;
export const DESK_HANDLE_WINDOW_MS = 10 * 60_000;
const DEVANAGARI = /[ऀ-ॿ]/;
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
  const deskAdds = new SlidingLimiter(DESK_HANDLE_ADDS, DESK_HANDLE_WINDOW_MS);
  app.addHook("onClose", async () => deskAdds.close());
  const deskChecks = new DeskHandleChecks(app.log);
  const searchFiles = new HandleSearchFiles(app.log);

  /** The editor's @ lookup: verified directory rows whose handle, name, Hindi name or an alias starts with q; then the files */
  async function searchMentions(orgId: string, q: string): Promise<HandleSearchItem[]> {
    const like = prefixPattern(q);
    const rows = await db
      .select({ handle: handleDirectory.handle, entityName: handleDirectory.entityName, entityNameHi: handleDirectory.entityNameHi })
      .from(handleDirectory)
      .where(
        and(
          eq(handleDirectory.orgId, orgId),
          eq(handleDirectory.platform, "x"),
          isNotNull(handleDirectory.verifiedAt),
          or(
            ilike(sql`ltrim(${handleDirectory.handle}, '@')`, like),
            ilike(handleDirectory.entityName, like),
            ilike(handleDirectory.entityNameHi, like),
            sql`EXISTS (SELECT 1 FROM unnest(${handleDirectory.aliases}) AS a(alias) WHERE a.alias ILIKE ${like})`,
          ),
        ),
      )
      .orderBy(desc(handleDirectory.priority), asc(handleDirectory.entityName))
      .limit(HANDLE_SEARCH_LIMIT);
    const fromDb = rows.map((r): HandleSearchItem => ({ value: `@${bare(r.handle)}`, name: r.entityName, nameHi: r.entityNameHi, source: "directory" }));
    return mergeResults(fromDb, searchEntries(await searchFiles.handles(), q));
  }

  /** The editor's # lookup: the places file's tags, then the org's active hashtag rules, by tag prefix */
  async function searchHashtags(orgId: string, q: string): Promise<HandleSearchItem[]> {
    const like = prefixPattern(q);
    const places = searchEntries(await searchFiles.placeTags(), q);
    const rules = await db
      .select({ name: hashtagRules.name, latin: hashtagRules.hashtagLatin, hi: hashtagRules.hashtagDevanagari })
      .from(hashtagRules)
      .where(and(eq(hashtagRules.orgId, orgId), eq(hashtagRules.active, true), or(ilike(sql`ltrim(${hashtagRules.hashtagLatin}, '#')`, like), ilike(sql`ltrim(${hashtagRules.hashtagDevanagari}, '#')`, like))))
      .orderBy(desc(hashtagRules.priority), asc(hashtagRules.name))
      .limit(HANDLE_SEARCH_LIMIT);
    const fromRules = rules.flatMap((r) =>
      [r.latin, r.hi]
        .map((t) => (t ?? "").replace(/^#+/, ""))
        .filter((t) => t && t.normalize("NFC").toLowerCase().startsWith(q) && /^[\p{L}\p{M}\p{N}_]+$/u.test(t))
        .map((t): HandleSearchItem => ({ value: `#${t}`, name: r.name, nameHi: r.hi, source: "rules" })),
    );
    return mergeResults(places, fromRules);
  }

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

  app.get("/handles", { schema: { querystring: HandleSearch } }, async (req) => {
    const { user } = guard(req);
    if (req.query.mode === "prefix") {
      const q = searchQuery(req.query.q);
      if (!q) return { items: [] };
      return { items: req.query.kind === "hashtag" ? await searchHashtags(user.orgId, q) : await searchMentions(user.orgId, q) };
    }
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

  /**
   * A handle typed on a post's tag line that the directory does not have: added at once, verified by the person who
   * typed it (source "desk"), so the draft's PATCH accepts it as a mention straight away. Its keywords (the
   * district and subject names inside it) make the phase-1 composer suggest it later; a handle of the data files or
   * a lookalike of one (or of a handle already in the org's directory: "@JhalawarUpdatse" next to
   * "@JhalawarUpdates"), a party's or an official's handle gets none (`keywordsWithheld` says why) and is never
   * suggested, only tagged by hand. A handle the org already has (any case, with or without @) comes back as it is,
   * 200; a new one is 201; one the org has but has not verified is a 409 (an editor verifies it in Settings).
   */
  app.post("/handles/desk", { schema: { body: DeskHandleBody } }, async (req, reply) => {
    const { user } = guard(req);
    requirePermission(user, "draft.edit", "x");
    const handle = bare(req.body.handle);
    // Worked out before the lock: it may read the data files
    const checked = await deskChecks.keywords(handle);
    const { row, created, withheld } = await db.transaction(async (tx): Promise<{ row: typeof handleDirectory.$inferSelect; created: boolean; withheld: typeof checked.withheld }> => {
      // One add per handle at a time: two people typing the same new handle get one row
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`handle_directory:${user.orgId}:${handle.toLowerCase()}`}))`);
      const [existing] = await tx
        .select()
        .from(handleDirectory)
        .where(and(eq(handleDirectory.orgId, user.orgId), eq(handleDirectory.platform, "x"), sql`lower(ltrim(${handleDirectory.handle}, '@')) = ${handle.toLowerCase()}`))
        .orderBy(sql`${handleDirectory.verifiedAt} IS NULL`, asc(handleDirectory.createdAt))
        .limit(1);
      if (existing) {
        if (existing.verifiedAt === null) {
          throw new HttpError(409, "handle_unverified", `@${bare(existing.handle)} is in the handle directory but not verified yet. Ask an editor to verify it in Settings.`);
        }
        return { row: existing, created: false, withheld: null };
      }
      // Not atomic with the record() below: two adds by one person at the same moment can both pass at the limit.
      // Accepted: it is a per-instance brake on one person, not a quota.
      if (deskAdds.isOver(user.id)) {
        throw new HttpError(429, "rate_limited", `Up to ${DESK_HANDLE_ADDS} new handles in ${DESK_HANDLE_WINDOW_MS / 60_000} minutes. Wait a moment and try again.`);
      }
      // A near copy of a handle the directory already has (a typo of it, any source) is never suggested: two
      // handles would otherwise be tagged on every story naming the place
      let { keywords, withheld } = checked;
      if (keywords.length) {
        const others = await tx.select({ handle: handleDirectory.handle }).from(handleDirectory).where(and(eq(handleDirectory.orgId, user.orgId), eq(handleDirectory.platform, "x")));
        if (fileLookalike(handle, others.map((o) => o.handle)) !== null) ({ keywords, withheld } = { keywords: [], withheld: "lookalike" });
      }
      const [inserted] = await tx
        .insert(handleDirectory)
        .values({
          orgId: user.orgId, entityName: keywords[0] ?? handle, entityNameHi: keywords.find((k) => DEVANAGARI.test(k)) ?? null, aliases: keywords, platform: "x",
          handle, priority: 0, source: "desk", verifiedAt: new Date(), verifiedBy: user.id,
        })
        .returning();
      await audit(tx, { orgId: user.orgId, actorId: user.id, action: "handle.desk_add", entityType: "handle", entityId: inserted!.id, after: { ...inserted, keywordsWithheld: withheld } });
      return { row: inserted!, created: true, withheld };
    });
    // Counted only once the handle is in: a failed add costs nothing
    if (created) deskAdds.record(user.id);
    return reply.status(created ? 201 : 200).send({
      id: row.id, handle: `@${bare(row.handle)}`, entityName: row.entityName, keywords: row.aliases, source: row.source, verified: true, created,
      keywordsWithheld: created ? withheld : null,
    });
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
