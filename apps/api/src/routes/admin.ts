// Users, roles, exceptions and the audit trail (contract: handoff/access-control-contract.md §4).
// Users need users.manage, roles need roles.manage, the change history needs audit.view. Every change
// writes its audit row in the same transaction. The user and audit routes answer at both /users… and
// /admin/users… (the old paths stay).
//
// No escalation: an actor hands out only permissions they hold, cannot change a user or role that can
// do more than they can, cannot change their own role, access, exceptions or password here, and (unless
// they hold every permission) cannot edit the role they have.

import { ADMIN_ALWAYS, PERMISSION_KEYS, roleKeyFromLabel, type PermissionKey } from "@socia/core";
import { audit, auditLog, rolePermissions, roles, sessions, userPermissionOverrides, users } from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accessChanged, assertActorCovers, assertAdminRemains, assertLabelFree, assertWithinOwn, builtInDefaults, effectiveOf, getRole,
  isFullAdmin, listRoleViews, lockAccess, oneRoleView, parsePermissionList, roleAllowed, roleUserIds, userPermissionView,
  writeRolePermissions, type RoleRow,
} from "../access";
import { HttpError, guard, hashPassword, requirePermission, type SessionUser } from "../auth";
import type { AppDeps } from "../app";

const PLATFORMS = ["x", "instagram", "facebook", "youtube"] as const;
export const PASSWORD_MIN = 12;
const RoleKey = Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" });
const Platforms = Type.Array(Type.Union(PLATFORMS.map((p) => Type.Literal(p))), { maxItems: PLATFORMS.length });
const PermissionList = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 200 });
const Label = Type.String({ minLength: 1, maxLength: 40 });
const Description = Type.String({ maxLength: 200 });
const Password = Type.String({ minLength: PASSWORD_MIN, maxLength: 200 });
const Id = Type.Object({ id: Type.String({ format: "uuid" }) });

const dedupe = (list: readonly string[]) => [...new Set(list)];
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
/** Postgres compares uuids in any case; our own string compares must not */
const uuid = (id: string) => id.toLowerCase();

export const adminRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db }) => {
  const userColumns = {
    u: users,
    roleLabel: roles.label,
    overrideCount: sql<number>`(SELECT count(*)::int FROM ${userPermissionOverrides} WHERE ${userPermissionOverrides.userId} = ${users.id})`,
  };
  const publicUser = ({ u, roleLabel, overrideCount }: { u: typeof users.$inferSelect; roleLabel: string | null; overrideCount: number }) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: roleLabel ?? u.role, platforms: u.platforms, active: u.active,
    totpEnabled: u.totpEnabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, overrideCount,
  });
  const selectUsers = () => db.select(userColumns).from(users).leftJoin(roles, and(eq(roles.orgId, users.orgId), eq(roles.key, users.role)));
  async function oneUser(orgId: string, id: string) {
    const [row] = await selectUsers().where(and(eq(users.id, id), eq(users.orgId, orgId)));
    if (!row) throw new HttpError(404, "not_found", "This user does not exist.");
    return publicUser(row);
  }
  const entry = (user: SessionUser, action: string, entityType: "role" | "user", entityId: string, before?: unknown, after?: unknown) => ({
    orgId: user.orgId, actorId: user.id, action, entityType, entityId, before, after,
  });
  /** The role the actor may change: not their own (unless they hold everything), not a stronger one */
  async function assertMayEditRole(user: SessionUser, role: RoleRow, allowed: ReadonlySet<PermissionKey>) {
    if (role.key === user.role && !isFullAdmin(user)) throw new HttpError(403, "own_role", "You cannot change the role you have. Ask a full admin.");
    assertActorCovers(user, allowed, `The role "${role.label}"`);
  }

  // ─── Users (users.manage) ──────────────────────────────────────────────────

  for (const base of ["", "/admin"]) {
    app.get(`${base}/users`, async (req) => {
      const { user } = guard(req);
      requirePermission(user, "users.manage");
      return { items: (await selectUsers().where(eq(users.orgId, user.orgId)).orderBy(users.name)).map(publicUser) };
    });

    app.post(
      `${base}/users`,
      {
        schema: {
          body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), email: Type.String({ minLength: 3, maxLength: 200 }), role: RoleKey, platforms: Platforms, password: Password }),
        },
      },
      async (req) => {
        const { user } = guard(req);
        requirePermission(user, "users.manage");
        const passwordHash = await hashPassword(req.body.password);
        const id = await db.transaction(async (tx) => {
          await lockAccess(tx, user.orgId);
          // A new user has no exceptions: they get exactly the role
          assertWithinOwn(user, await effectiveOf(tx, { id: "", orgId: user.orgId, role: req.body.role }, []), "create users");
          const [row] = await tx
            .insert(users)
            .values({ orgId: user.orgId, name: req.body.name.trim(), email: req.body.email.trim().toLowerCase(), role: req.body.role, platforms: dedupe(req.body.platforms), passwordHash })
            .onConflictDoNothing()
            .returning();
          if (!row) throw new HttpError(409, "email_taken", "Someone already uses this email.");
          await audit(tx, entry(user, "user.created", "user", row.id, undefined, { name: row.name, email: row.email, role: row.role, platforms: row.platforms }));
          return row.id;
        });
        return oneUser(user.orgId, id);
      },
    );

    app.patch(
      `${base}/users/:id`,
      {
        schema: {
          params: Id,
          body: Type.Object({
            role: Type.Optional(RoleKey),
            platforms: Type.Optional(Platforms),
            active: Type.Optional(Type.Boolean()),
            password: Type.Optional(Password),
            resetTotp: Type.Optional(Type.Boolean()),
          }),
        },
      },
      async (req) => {
        const { user } = guard(req);
        requirePermission(user, "users.manage");
        const { password, resetTotp, ...rest } = req.body;
        if (rest.platforms) rest.platforms = dedupe(rest.platforms) as typeof rest.platforms;
        const passwordHash = password ? await hashPassword(password) : null;
        await db.transaction(async (tx) => {
          await lockAccess(tx, user.orgId);
          const [before] = await tx.select().from(users).where(and(eq(users.id, uuid(req.params.id)), eq(users.orgId, user.orgId))).for("update");
          if (!before) throw new HttpError(404, "not_found", "This user does not exist.");
          if (before.id === user.id) {
            if (password || resetTotp) throw new HttpError(409, "self_change", "Change your own password under your profile (POST /me/password); ask another admin to reset your two-step sign-in.");
            if (rest.role || rest.active === false || (rest.platforms && !isFullAdmin(user))) {
              throw new HttpError(409, "self_change", "Ask another admin to change your own role, platforms or access.");
            }
          } else {
            assertActorCovers(user, await effectiveOf(tx, before), before.name);
          }
          const roleChanged = !!rest.role && rest.role !== before.role;
          if (roleChanged) assertWithinOwn(user, await effectiveOf(tx, { ...before, role: rest.role! }), "assign roles");
          const [row] = await tx
            .update(users)
            .set({
              ...rest,
              ...(passwordHash && { passwordHash }),
              ...(resetTotp && { totpEnabled: false, totpSecretEnc: null }),
            })
            .where(eq(users.id, before.id))
            .returning();
          const after = row!;
          const platformsChanged = !sameSet(before.platforms, after.platforms);
          const activeChanged = before.active !== after.active;
          if (roleChanged) await audit(tx, entry(user, "user.role_changed", "user", after.id, { role: before.role }, { role: after.role }));
          if (platformsChanged) await audit(tx, entry(user, "user.platforms_changed", "user", after.id, { platforms: before.platforms }, { platforms: after.platforms }));
          if (activeChanged) await audit(tx, entry(user, after.active ? "user.activated" : "user.deactivated", "user", after.id, { active: before.active }, { active: after.active }));
          if (password) await audit(tx, entry(user, "user.password_reset", "user", after.id));
          if (resetTotp) await audit(tx, entry(user, "user.totp_reset", "user", after.id));
          if (roleChanged || activeChanged) await assertAdminRemains(tx, user.orgId);
          // Changed sign-in or access takes effect now: sign the user out everywhere
          if (password || resetTotp || !after.active || roleChanged) await tx.delete(sessions).where(eq(sessions.userId, after.id));
          if (roleChanged || activeChanged || platformsChanged) await accessChanged(tx, user.orgId, [after.id]);
        });
        return oneUser(user.orgId, uuid(req.params.id));
      },
    );
  }

  app.get("/admin/users/:id/permissions", { schema: { params: Id } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "users.manage");
    const [target] = await db.select().from(users).where(and(eq(users.id, uuid(req.params.id)), eq(users.orgId, user.orgId)));
    if (!target) throw new HttpError(404, "not_found", "This user does not exist.");
    return userPermissionView(db, target);
  });

  app.put(
    "/admin/users/:id/overrides",
    {
      schema: {
        params: Id,
        body: Type.Object(
          {
            overrides: Type.Array(
              Type.Object({ permission: Type.String({ minLength: 1, maxLength: 64 }), allowed: Type.Boolean() }, { additionalProperties: false }),
              { maxItems: PERMISSION_KEYS.length },
            ),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requirePermission(user, "users.manage");
      const wanted = req.body.overrides;
      parsePermissionList(wanted.map((o) => o.permission));
      if (new Set(wanted.map((o) => o.permission)).size !== wanted.length) throw new HttpError(400, "invalid", "Each permission may appear only once.");
      return db.transaction(async (tx) => {
        await lockAccess(tx, user.orgId);
        const [target] = await tx.select().from(users).where(and(eq(users.id, uuid(req.params.id)), eq(users.orgId, user.orgId))).for("update");
        if (!target) throw new HttpError(404, "not_found", "This user does not exist.");
        if (target.id === user.id) throw new HttpError(409, "self_change", "Ask another admin to set exceptions for you.");
        assertActorCovers(user, await effectiveOf(tx, target), target.name);
        assertWithinOwn(user, await effectiveOf(tx, target, wanted), "give exceptions");
        const before = new Map(
          (await tx.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, target.id))).map((o) => [o.permission, o.allowed]),
        );
        const after = new Map(wanted.map((o) => [o.permission, o.allowed]));
        // Unchanged exceptions keep who set them and when
        const removed = [...before.keys()].filter((k) => !after.has(k) || after.get(k) !== before.get(k));
        if (removed.length) await tx.delete(userPermissionOverrides).where(and(eq(userPermissionOverrides.userId, target.id), inArray(userPermissionOverrides.permission, removed)));
        const added = [...after].filter(([k, v]) => before.get(k) !== v);
        if (added.length) await tx.insert(userPermissionOverrides).values(added.map(([permission, allowed]) => ({ userId: target.id, permission, allowed, setBy: user.id })));
        for (const [permission, allowed] of added) {
          await audit(tx, entry(user, "user.override_set", "user", target.id, before.has(permission) ? { permission, allowed: before.get(permission) } : null, { permission, allowed }));
        }
        for (const permission of [...before.keys()].filter((k) => !after.has(k))) {
          await audit(tx, entry(user, "user.override_cleared", "user", target.id, { permission, allowed: before.get(permission) }, null));
        }
        await assertAdminRemains(tx, user.orgId);
        return userPermissionView(tx, target);
      });
    },
  );

  // ─── Roles (roles.manage; users.manage may list them, to pick a user's role) ──

  app.get("/admin/roles", async (req) => {
    const { user } = guard(req);
    requirePermission(user, ["roles.manage", "users.manage"]);
    return { roles: await listRoleViews(db, user.orgId) };
  });

  app.post(
    "/admin/roles",
    {
      schema: {
        body: Type.Object(
          {
            label: Label,
            description: Type.Optional(Description),
            platformScoped: Type.Optional(Type.Boolean()),
            permissions: Type.Optional(PermissionList),
            copyFrom: Type.Optional(RoleKey),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req, reply) => {
      const { user } = guard(req);
      requirePermission(user, "roles.manage");
      const label = req.body.label.trim();
      if (!label) throw new HttpError(400, "invalid", "Give the role a name.");
      const source = req.body.copyFrom ? await getRole(db, user.orgId, req.body.copyFrom) : null;
      if (req.body.copyFrom && !source) throw new HttpError(400, "invalid", `There is no role "${req.body.copyFrom}" to copy from.`);
      if (!source && (req.body.permissions === undefined || req.body.platformScoped === undefined)) {
        throw new HttpError(400, "invalid", "Send permissions and platformScoped, or copyFrom to start from another role.");
      }
      const allowed = req.body.permissions ? parsePermissionList(req.body.permissions) : await roleAllowed(db, source!);
      assertWithinOwn(user, allowed, "create roles");
      // Labels without Latin letters (e.g. Hindi) still get a stable key
      const key = roleKeyFromLabel(label) || `role-${randomBytes(3).toString("hex")}`;
      const view = await db.transaction(async (tx) => {
        await lockAccess(tx, user.orgId);
        await assertLabelFree(tx, user.orgId, label);
        const [role] = await tx
          .insert(roles)
          .values({ orgId: user.orgId, key, label, description: req.body.description?.trim() ?? "", builtIn: false, platformScoped: req.body.platformScoped ?? source!.platformScoped })
          .onConflictDoNothing()
          .returning();
        if (!role) throw new HttpError(409, "role_exists", `A role with the key "${key}" already exists. Choose another name.`);
        await writeRolePermissions(tx, role, allowed);
        const created = await oneRoleView(tx, role);
        await audit(tx, entry(user, "role.created", "role", key, null, { ...created, copyFrom: req.body.copyFrom ?? null }));
        return created;
      });
      return reply.status(201).send(view);
    },
  );

  app.patch(
    "/admin/roles/:key",
    {
      schema: {
        params: Type.Object({ key: RoleKey }),
        body: Type.Object(
          { label: Type.Optional(Label), description: Type.Optional(Description), platformScoped: Type.Optional(Type.Boolean()), permissions: Type.Optional(PermissionList) },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requirePermission(user, "roles.manage");
      const wanted = req.body.permissions ? parsePermissionList(req.body.permissions) : null;
      const label = req.body.label?.trim();
      if (label === "") throw new HttpError(400, "invalid", "Give the role a name.");
      return db.transaction(async (tx) => {
        await lockAccess(tx, user.orgId);
        const role = await getRole(tx, user.orgId, req.params.key);
        if (!role) throw new HttpError(404, "not_found", "This role does not exist.");
        const beforeView = await oneRoleView(tx, role);
        await assertMayEditRole(user, role, new Set(beforeView.permissions));
        if (wanted) assertWithinOwn(user, wanted, "edit roles");
        if (role.builtIn && ((label !== undefined && label !== role.label) || (req.body.platformScoped !== undefined && req.body.platformScoped !== role.platformScoped))) {
          throw new HttpError(409, "built_in", "A built-in role keeps its name and platform setting; only its description and permissions can change.");
        }
        if (wanted && role.key === "admin" && ADMIN_ALWAYS.some((k) => !wanted.has(k))) {
          throw new HttpError(409, "last_admin", "The Admin role always keeps Manage users and Manage roles.");
        }
        if (label !== undefined && label.toLowerCase() !== role.label.toLowerCase()) await assertLabelFree(tx, user.orgId, label, role.key);
        const fields = {
          ...(label !== undefined && { label }),
          ...(req.body.description !== undefined && { description: req.body.description.trim() }),
          ...(req.body.platformScoped !== undefined && { platformScoped: req.body.platformScoped }),
        };
        let current = role;
        if (Object.keys(fields).length) {
          const [row] = await tx.update(roles).set({ ...fields, updatedAt: sql`now()` }).where(and(eq(roles.orgId, role.orgId), eq(roles.key, role.key))).returning();
          current = row!;
          const pick = (v: RoleRow) => ({ label: v.label, description: v.description, platformScoped: v.platformScoped });
          if (JSON.stringify(pick(role)) !== JSON.stringify(pick(current))) await audit(tx, entry(user, "role.updated", "role", role.key, pick(role), pick(current)));
        }
        const permissionsChanged = !!wanted && !sameSet(beforeView.permissions, [...wanted]);
        if (wanted && permissionsChanged) {
          await writeRolePermissions(tx, current, wanted);
          if (!Object.keys(fields).length) await tx.update(roles).set({ updatedAt: sql`now()` }).where(and(eq(roles.orgId, role.orgId), eq(roles.key, role.key)));
          const after = PERMISSION_KEYS.filter((k) => wanted.has(k));
          await audit(tx, entry(user, "role.permissions_changed", "role", role.key, { permissions: beforeView.permissions }, {
            permissions: after,
            added: after.filter((k) => !beforeView.permissions.includes(k)),
            removed: beforeView.permissions.filter((k) => !wanted.has(k as PermissionKey)),
          }));
          await assertAdminRemains(tx, user.orgId);
        }
        if (permissionsChanged || current.platformScoped !== role.platformScoped) await accessChanged(tx, user.orgId, await roleUserIds(tx, user.orgId, role.key));
        return oneRoleView(tx, current);
      });
    },
  );

  app.post("/admin/roles/:key/reset", { schema: { params: Type.Object({ key: RoleKey }) } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "roles.manage");
    return db.transaction(async (tx) => {
      await lockAccess(tx, user.orgId);
      const role = await getRole(tx, user.orgId, req.params.key);
      if (!role) throw new HttpError(404, "not_found", "This role does not exist.");
      const defaults = builtInDefaults(role.key);
      if (!role.builtIn || !defaults) throw new HttpError(409, "not_built_in", "Only built-in roles have a default to reset to.");
      const beforeView = await oneRoleView(tx, role);
      await assertMayEditRole(user, role, new Set(beforeView.permissions));
      await tx.delete(rolePermissions).where(and(eq(rolePermissions.orgId, role.orgId), eq(rolePermissions.roleKey, role.key)));
      const [row] = await tx
        .update(roles)
        .set({ label: defaults.label, description: defaults.description, platformScoped: defaults.platformScoped, updatedAt: sql`now()` })
        .where(and(eq(roles.orgId, role.orgId), eq(roles.key, role.key)))
        .returning();
      const after = await oneRoleView(tx, row!);
      assertWithinOwn(user, after.permissions, "reset roles");
      await audit(tx, entry(user, "role.reset", "role", role.key, beforeView, after));
      await assertAdminRemains(tx, user.orgId);
      await accessChanged(tx, user.orgId, await roleUserIds(tx, user.orgId, role.key));
      return after;
    });
  });

  app.delete("/admin/roles/:key", { schema: { params: Type.Object({ key: RoleKey }) } }, async (req) => {
    const { user } = guard(req);
    requirePermission(user, "roles.manage");
    return db.transaction(async (tx) => {
      await lockAccess(tx, user.orgId);
      const role = await getRole(tx, user.orgId, req.params.key);
      if (!role) throw new HttpError(404, "not_found", "This role does not exist.");
      if (role.builtIn) throw new HttpError(409, "built_in", "Built-in roles cannot be deleted.");
      const [n] = await tx.select({ n: count() }).from(users).where(and(eq(users.orgId, role.orgId), eq(users.role, role.key)));
      const inUse = Number(n?.n ?? 0);
      if (inUse) throw new HttpError(409, "in_use", `${inUse} ${inUse === 1 ? "user has" : "users have"} this role. Give them another role first.`);
      const beforeView = await oneRoleView(tx, role);
      await tx.delete(roles).where(and(eq(roles.orgId, role.orgId), eq(roles.key, role.key)));
      await audit(tx, entry(user, "role.deleted", "role", role.key, beforeView, null));
      return { ok: true };
    });
  });

  // ─── Audit trail ───────────────────────────────────────────────────────────
  // With entityId: one item's trail, for anyone signed in, except roles and users (audit.view, users.manage
  // or roles.manage). Without: the role/user change history, which needs audit.view. Newest first by
  // (at, id); `before` is the nextBefore (an audit id) of the previous page.

  for (const path of ["/audit", "/admin/audit"]) {
    app.get(
      path,
      {
        schema: {
          querystring: Type.Object({
            entityType: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
            entity: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
            entityId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
            before: Type.Optional(Type.String({ pattern: "^\\d{1,15}$" })),
          }),
        },
      },
      async (req) => {
        const { user } = guard(req);
        const q = req.query;
        const type = q.entityType ?? q.entity;
        const people = type === "role" || type === "user";
        if (q.entityId) {
          if (!type) throw new HttpError(400, "invalid", "Say which kind of item (entityType) the id belongs to.");
          if (people) requirePermission(user, ["audit.view", "users.manage", "roles.manage"]);
        } else {
          requirePermission(user, "audit.view");
          if (type && !people) throw new HttpError(400, "invalid", 'The change history covers entity "role" or "user".');
        }
        const limit = q.limit ?? 50;
        // A user id may come in upper case; role keys and other ids are matched as sent
        const entityId = q.entityId && type === "user" ? q.entityId.toLowerCase() : q.entityId;
        const items = await db
          .select({ a: auditLog, actor: users.name })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.actorId))
          .where(
            and(
              eq(auditLog.orgId, user.orgId),
              type ? eq(auditLog.entityType, type) : inArray(auditLog.entityType, ["role", "user"]),
              entityId ? eq(auditLog.entityId, entityId) : undefined,
              q.before
                ? sql`(${auditLog.at}, ${auditLog.id}) < (SELECT c.at, c.id FROM ${auditLog} c WHERE c.id = ${Number(q.before)} AND c.org_id = ${user.orgId})`
                : undefined,
            ),
          )
          .orderBy(desc(auditLog.at), desc(auditLog.id))
          .limit(limit);
        const last = items.at(-1);
        return { items, nextBefore: items.length === limit && last ? String(last.a.id) : null };
      },
    );
  }
};
