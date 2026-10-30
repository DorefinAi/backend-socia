// The owner console's API (contract: handoff/owner-console-contract.md §2, §4): the Sentry control centre's
// server calls it to see and change who can do what. Registered only when OWNER_API_KEY is set (app.ts); then
// every request needs `Authorization: Bearer <key>` (constant-time compare; wrong or missing keys are rate limited
// per IP, a valid key always passes)
// and `X-Owner-Actor: <sentry username>`, written to the audit trail as "owner:<name>". No cookies, no CSRF.
//
// Owners are not users: the "hand out only what you hold", own-role and self-change rules do not apply to them.
// The safety rules do: changes run under lockAccess, and the last active admin cannot be disabled, demoted or lose
// users.manage / roles.manage (409 last_admin). Disabling deletes the user's sessions and drops their sockets.
// Socia runs one org today; the routes read across orgs and every change is checked within the target's org.
//
// Request schemas are strict (also enforced for every route in app.ts); unknown permission keys and roles are 422.

import { createHash, timingSafeEqual } from "node:crypto";
import { PERMISSIONS, isPermissionKey, type PermissionKey } from "@socia/core";
import { audit, auditLog, roles, sessions, userPermissionOverrides, users, type Executor } from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyRequest } from "fastify";
import { accessChanged, assertAdminRemains, getRole, lockAccess, replaceOverrides, userPermissionView, type ChangeBy } from "../access";
import { HttpError } from "../auth";
import type { AppDeps } from "../app";
import { SlidingLimiter } from "../limiter";

export interface OwnerLimits {
  /** Wrong or missing keys one IP may send in the window; further ones get 429 until they age out */
  failuresPerIp: number;
  windowMs: number;
}
export const OWNER_LIMITS: OwnerLimits = { failuresPerIp: 20, windowMs: 10 * 60_000 };

export const OWNER_ACTOR_RE = /^[a-z0-9._-]{1,64}$/;
const RoleKey = Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" });
const Id = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
/** ISO 8601 date-time, e.g. 2026-10-30T09:15:00.000Z */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest();
/** Postgres compares uuids in any case; our own string compares must not */
const uuid = (id: string) => id.toLowerCase();

const catalogue = PERMISSIONS.map(({ key, group, label, description }) => ({ key, group, label, description }));

export const ownerRoutes: FastifyPluginAsyncTypebox<AppDeps & { ownerKey: string }> = async (app, { db, ownerKey, ownerLimits }) => {
  const limits = { ...OWNER_LIMITS, ...ownerLimits };
  const failures = new SlidingLimiter(limits.failuresPerIp, limits.windowMs);
  app.addHook("onClose", async () => failures.close());
  // Hashing both sides gives equal lengths, so the compare takes the same time whatever was sent
  const expected = sha256(ownerKey);

  // Before body parsing and validation: nothing about a route's input is revealed without the key
  // The key is checked first: a valid key always passes (an attacker sharing the IP cannot lock the console
  // out); only wrong or missing keys are counted, and past the limit they get 429 instead of 401
  app.addHook("onRequest", async (req, reply) => {
    const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
    if (!m || !timingSafeEqual(sha256(m[1]!), expected)) {
      if (failures.isOver(req.ip)) {
        reply.header("retry-after", String(Math.ceil(limits.windowMs / 1000)));
        throw new HttpError(429, "rate_limited", "Too many failed requests. Wait a while and try again.");
      }
      failures.record(req.ip);
      throw new HttpError(401, "unauthorized", "A valid owner key is required.");
    }
    const actor = req.headers["x-owner-actor"];
    if (typeof actor !== "string" || !OWNER_ACTOR_RE.test(actor)) {
      throw new HttpError(400, "invalid_actor", "Send X-Owner-Actor: the owner's username (1–64 of a-z, 0-9, '.', '_', '-').");
    }
  });

  /** Checked in the onRequest hook */
  const ownerActor = (req: FastifyRequest) => `owner:${req.headers["x-owner-actor"] as string}`;

  // ─── Reads ───────────────────────────────────────────────────────────────

  const personColumns = {
    u: users,
    roleLabel: roles.label,
    overrides: sql<{ permission: string; allowed: boolean }[]>`coalesce((SELECT json_agg(json_build_object('permission', o.permission, 'allowed', o.allowed) ORDER BY o.permission) FROM ${userPermissionOverrides} o WHERE o.user_id = ${users.id}), '[]'::json)`,
  };
  const person = ({ u, roleLabel, overrides }: { u: typeof users.$inferSelect; roleLabel: string | null; overrides: { permission: string; allowed: boolean }[] }) => ({
    id: u.id,
    // Socia signs in by email and has no username
    username: null,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: roleLabel ?? u.role,
    active: u.active,
    lastLoginAt: u.lastLoginAt,
    overrides: overrides.filter((o): o is { permission: PermissionKey; allowed: boolean } => isPermissionKey(o.permission)),
  });
  const selectPeople = (ex: Executor) => ex.select(personColumns).from(users).leftJoin(roles, and(eq(roles.orgId, users.orgId), eq(roles.key, users.role)));
  async function onePerson(ex: Executor, id: string) {
    const [row] = await selectPeople(ex).where(eq(users.id, id));
    if (!row) throw new HttpError(404, "not_found", "This user does not exist.");
    return person(row);
  }
  async function target(ex: Executor, id: string, lock = false) {
    const q = ex.select().from(users).where(eq(users.id, uuid(id)));
    const [row] = lock ? await q.for("update") : await q;
    if (!row) throw new HttpError(404, "not_found", "This user does not exist.");
    return row;
  }
  /** The target's org locked (one access change at a time), then the target re-read under that lock */
  async function lockedTarget(tx: Executor, id: string) {
    await lockAccess(tx, (await target(tx, id)).orgId);
    return target(tx, id, true);
  }

  app.get("/owner/people", async () => {
    const [people, roleRows] = await Promise.all([
      selectPeople(db).orderBy(asc(users.name), asc(users.email)),
      db
        .select({ key: roles.key, label: roles.label })
        .from(roles)
        .orderBy(sql`${roles.builtIn} DESC`, sql`array_position(ARRAY['admin','editor','operator','viewer'], ${roles.key})`, asc(roles.label)),
    ]);
    // One org today; should there be more, a role key is listed once
    const seen = new Set<string>();
    return {
      system: "socia" as const,
      catalogue,
      roles: roleRows.filter((r) => !seen.has(r.key) && seen.add(r.key)),
      users: people.map(person),
    };
  });

  app.get("/owner/people/:id/permissions", { schema: { params: Id } }, async (req) => userPermissionView(db, await target(db, req.params.id)));

  // ─── Changes ─────────────────────────────────────────────────────────────

  app.patch(
    "/owner/people/:id",
    {
      schema: {
        params: Id,
        body: Type.Object({ role: Type.Optional(RoleKey), active: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      },
    },
    async (req) => {
      const { role, active } = req.body;
      const actor = ownerActor(req);
      const id = await db.transaction(async (tx) => {
        const before = await lockedTarget(tx, req.params.id);
        const by: ChangeBy = { orgId: before.orgId, actorId: null, actor };
        const entry = (action: string, b: unknown, a: unknown) => ({ ...by, action, entityType: "user", entityId: before.id, before: b, after: a });
        const roleChanged = role !== undefined && role !== before.role;
        if (roleChanged && !(await getRole(tx, before.orgId, role))) throw new HttpError(422, "unknown_role", `There is no role "${role}".`);
        const fields = { ...(roleChanged && { role }), ...(active !== undefined && { active }) };
        const after = Object.keys(fields).length ? (await tx.update(users).set(fields).where(eq(users.id, before.id)).returning())[0]! : before;
        const activeChanged = before.active !== after.active;
        if (roleChanged) await audit(tx, entry("user.role_changed", { role: before.role }, { role: after.role }));
        if (activeChanged) await audit(tx, entry(after.active ? "user.activated" : "user.deactivated", { active: before.active }, { active: after.active }));
        if (roleChanged || activeChanged) await assertAdminRemains(tx, before.orgId);
        // Disabling signs the user out everywhere at once. A role change does not (contract §2): permissions are
        // re-read on every request; their sockets still reconnect so they rejoin the rooms of the new role.
        if (!after.active) await tx.delete(sessions).where(eq(sessions.userId, after.id));
        if (roleChanged || activeChanged) await accessChanged(tx, after.orgId, [after.id]);
        return after.id;
      });
      return { user: await onePerson(db, id) };
    },
  );

  app.put(
    "/owner/people/:id/overrides",
    {
      schema: {
        params: Id,
        body: Type.Object(
          {
            overrides: Type.Array(
              Type.Object({ permission: Type.String({ minLength: 1, maxLength: 64 }), allowed: Type.Boolean() }, { additionalProperties: false }),
              { maxItems: PERMISSIONS.length },
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const wanted = req.body.overrides;
      const unknown = wanted.map((o) => o.permission).filter((k) => !isPermissionKey(k));
      if (unknown.length) throw new HttpError(422, "unknown_permission", `Unknown permission: ${unknown.slice(0, 5).join(", ")}.`);
      if (new Set(wanted.map((o) => o.permission)).size !== wanted.length) throw new HttpError(400, "invalid", "Each permission may appear only once.");
      const actor = ownerActor(req);
      return db.transaction(async (tx) => {
        const t = await lockedTarget(tx, req.params.id);
        await replaceOverrides(tx, t.id, wanted, { orgId: t.orgId, actorId: null, actor });
        await assertAdminRemains(tx, t.orgId);
        // Their sockets reconnect with the new access
        await accessChanged(tx, t.orgId, [t.id]);
        return userPermissionView(tx, t);
      });
    },
  );

  // ─── History ─────────────────────────────────────────────────────────────
  // Changes to users and their exceptions, by owners and by the desk's admins, newest first. Paged by the keyset
  // (at, id): `next` is an opaque cursor (at to the microsecond + id), sent back as `cursor`. `before=<ISO>` also
  // works (entries strictly older than that time). actorKind tells an owner ("owner:<name>", from the owner console)
  // from a user, whose free-text name could look the same.

  const actorUser = alias(users, "actor_user");
  const targetUser = alias(users, "target_user");
  app.get(
    "/owner/history",
    {
      schema: {
        querystring: Type.Object(
          {
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            before: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { limit = 50, cursor, before } = req.query;
      if (cursor !== undefined && before !== undefined) throw new HttpError(400, "invalid", "Send cursor or before, not both.");
      const after = cursor === undefined ? null : parseCursor(cursor);
      const beforeAt = before === undefined ? null : new Date(before);
      if (before !== undefined && (!ISO_RE.test(before) || Number.isNaN(beforeAt!.getTime()))) {
        throw new HttpError(400, "invalid", "before must be an ISO date-time, e.g. 2026-10-30T09:15:00Z.");
      }
      const rows = await db
        .select({
          id: auditLog.id,
          at: auditLog.at,
          /** Microsecond precision, for the cursor (a JS Date keeps milliseconds only) */
          atText: sql<string>`to_char(${auditLog.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          ownerActor: auditLog.actor,
          userActor: actorUser.name,
          actorId: auditLog.actorId,
          action: auditLog.action,
          targetId: auditLog.entityId,
          targetName: targetUser.name,
          before: auditLog.before,
          after: auditLog.after,
        })
        .from(auditLog)
        .leftJoin(actorUser, eq(actorUser.id, auditLog.actorId))
        // A user's entity_id is their uuid; anything else (never expected) simply has no target name
        .leftJoin(targetUser, eq(targetUser.id, sql`CASE WHEN ${auditLog.entityId} ~* ${UUID_SQL_RE} THEN ${auditLog.entityId}::uuid END`))
        .where(
          and(
            eq(auditLog.entityType, "user"),
            beforeAt ? lt(auditLog.at, beforeAt) : undefined,
            after ? sql`(${auditLog.at}, ${auditLog.id}) < (${after.at}::timestamptz, ${after.id})` : undefined,
          ),
        )
        .orderBy(desc(auditLog.at), desc(auditLog.id))
        .limit(limit);
      const last = rows.at(-1);
      return {
        entries: rows.map((r) => ({
          at: r.at,
          actor: r.ownerActor ?? r.userActor,
          actorKind: r.ownerActor !== null ? ("owner" as const) : r.actorId !== null ? ("user" as const) : null,
          action: r.action,
          target: { id: r.targetId, name: r.targetName },
          before: r.before,
          after: r.after,
        })),
        next: rows.length === limit && last ? makeCursor(last.atText, last.id) : null,
      };
    },
  );
};

const UUID_SQL_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Opaque to clients: base64url of "<at, UTC, microseconds>|<audit id>" */
export const makeCursor = (at: string, id: number) => Buffer.from(`${at}|${id}`).toString("base64url");

export function parseCursor(cursor: string): { at: string; id: number } {
  const [at, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (rest.length || !at || !CURSOR_AT_RE.test(at) || Number.isNaN(Date.parse(at)) || !id || !/^\d{1,15}$/.test(id)) {
    throw new HttpError(400, "invalid", "This cursor is not valid. Start again without one.");
  }
  return { at, id: Number(id) };
}
