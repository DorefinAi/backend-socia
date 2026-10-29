// Roles, their permissions and per-user exceptions: reads and the rules every change must keep
// (contract: handoff/access-control-contract.md §1, §3). Routes are in routes/admin.ts.

import {
  BUILT_IN_ROLE_INFO, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, effectivePermissionSet, isBuiltInRole, isPermissionKey,
  permissionLabel, rolePermissionSet, type PermissionKey,
} from "@socia/core";
import { notify, rolePermissions, roles, userPermissionOverrides, users, type Executor } from "@socia/db";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { HttpError, type SessionUser } from "./auth";

export type RoleRow = typeof roles.$inferSelect;

/** Catalogue order, so lists read the same everywhere */
const ordered = (set: ReadonlySet<PermissionKey>): PermissionKey[] => PERMISSION_KEYS.filter((k) => set.has(k));

/** A client's permission list: every key must be in the catalogue (else 400), duplicates are dropped. */
export function parsePermissionList(list: readonly string[]): Set<PermissionKey> {
  const unknown = list.filter((k) => !isPermissionKey(k));
  if (unknown.length) throw new HttpError(400, "invalid", `Unknown permission: ${unknown.slice(0, 5).join(", ")}.`);
  return new Set(list as PermissionKey[]);
}

/** One access change at a time per org, so two admins cannot each remove the other. Inside a transaction. */
export async function lockAccess(tx: Executor, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`socia:access:${orgId}`}))`);
}

export async function getRole(ex: Executor, orgId: string, key: string): Promise<RoleRow | null> {
  const [row] = await ex.select().from(roles).where(and(eq(roles.orgId, orgId), eq(roles.key, key)));
  return row ?? null;
}

export async function roleAllowed(ex: Executor, role: RoleRow): Promise<Set<PermissionKey>> {
  const rows = await ex
    .select({ permission: rolePermissions.permission, allowed: rolePermissions.allowed })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.orgId, role.orgId), eq(rolePermissions.roleKey, role.key)));
  return rolePermissionSet(role.key, role.builtIn, rows);
}

/** Stores the role's full set: one row per catalogue key, so the role no longer follows the defaults. */
export async function writeRolePermissions(tx: Executor, role: RoleRow, allowed: ReadonlySet<PermissionKey>): Promise<void> {
  await tx.delete(rolePermissions).where(and(eq(rolePermissions.orgId, role.orgId), eq(rolePermissions.roleKey, role.key)));
  await tx.insert(rolePermissions).values(PERMISSION_KEYS.map((permission) => ({ orgId: role.orgId, roleKey: role.key, permission, allowed: allowed.has(permission) })));
}

export function roleView(role: RoleRow, allowed: ReadonlySet<PermissionKey>, userCount: number) {
  return {
    key: role.key,
    label: role.label,
    description: role.description,
    builtIn: role.builtIn,
    platformScoped: role.platformScoped,
    userCount,
    permissions: ordered(allowed),
    /** Built-ins: what "Reset to default" restores; null for custom roles */
    defaultPermissions: role.builtIn && isBuiltInRole(role.key) ? [...DEFAULT_ROLE_PERMISSIONS[role.key]] : null,
  };
}

export async function roleUserCounts(ex: Executor, orgId: string): Promise<Map<string, number>> {
  const rows = await ex.select({ role: users.role, n: count() }).from(users).where(eq(users.orgId, orgId)).groupBy(users.role);
  return new Map(rows.map((r) => [r.role, Number(r.n)]));
}

export async function listRoleViews(ex: Executor, orgId: string) {
  const [rows, settings, counts] = await Promise.all([
    ex.select().from(roles).where(eq(roles.orgId, orgId)).orderBy(sql`${roles.builtIn} DESC`, sql`array_position(ARRAY['admin','editor','operator','viewer'], ${roles.key})`, asc(roles.label)),
    ex.select().from(rolePermissions).where(eq(rolePermissions.orgId, orgId)),
    roleUserCounts(ex, orgId),
  ]);
  return rows.map((r) => roleView(r, rolePermissionSet(r.key, r.builtIn, settings.filter((s) => s.roleKey === r.key)), counts.get(r.key) ?? 0));
}

export async function oneRoleView(ex: Executor, role: RoleRow) {
  const [n] = await ex.select({ n: count() }).from(users).where(and(eq(users.orgId, role.orgId), eq(users.role, role.key)));
  return roleView(role, await roleAllowed(ex, role), Number(n?.n ?? 0));
}

export const builtInDefaults = (key: string) => (isBuiltInRole(key) ? BUILT_IN_ROLE_INFO[key] : null);

// ─── Users ───────────────────────────────────────────────────────────────────

export async function userOverrides(ex: Executor, userId: string) {
  const rows = await ex
    .select({ permission: userPermissionOverrides.permission, allowed: userPermissionOverrides.allowed })
    .from(userPermissionOverrides)
    .where(eq(userPermissionOverrides.userId, userId));
  return rows.filter((r): r is { permission: PermissionKey; allowed: boolean } => isPermissionKey(r.permission));
}

/** What a user may do, from their role and exceptions (pass `overrides` to try a change before saving it). */
export async function effectiveOf(
  ex: Executor,
  target: { id: string; orgId: string; role: string },
  overrides?: readonly { permission: string; allowed: boolean }[],
): Promise<Set<PermissionKey>> {
  const role = await getRole(ex, target.orgId, target.role);
  if (!role) throw new HttpError(400, "invalid", `There is no role "${target.role}".`);
  return effectivePermissionSet(await roleAllowed(ex, role), overrides ?? (await userOverrides(ex, target.id)));
}

// ─── No escalation ───────────────────────────────────────────────────────────
// Someone who manages users or roles can only hand out what they hold themselves, and cannot change
// people (or roles) that can do more than they can. Only a full admin (every permission) is unlimited.

export const isFullAdmin = (actor: SessionUser): boolean => PERMISSION_KEYS.every((k) => actor.permissions.has(k));

const missingFrom = (actor: SessionUser, set: Iterable<PermissionKey>) => [...set].filter((k) => !actor.permissions.has(k));
const labels = (keys: PermissionKey[]) => keys.slice(0, 5).map((k) => `"${permissionLabel(k)}"`).join(", ") + (keys.length > 5 ? "…" : "");

/** 403 exceeds_own_access unless every permission in `set` is one the actor has. */
export function assertWithinOwn(actor: SessionUser, set: Iterable<PermissionKey>, what: string): void {
  const missing = missingFrom(actor, set);
  if (missing.length) throw new HttpError(403, "exceeds_own_access", `You can only ${what} with permissions you have yourself. You do not have ${labels(missing)}.`);
}

/** 403 exceeds_own_access when the user or role being changed can do something the actor cannot. */
export function assertActorCovers(actor: SessionUser, set: Iterable<PermissionKey>, who: string): void {
  const missing = missingFrom(actor, set);
  if (missing.length) throw new HttpError(403, "exceeds_own_access", `${who} can do things you cannot (${labels(missing)}). Ask a full admin.`);
}

/** Disconnect these users' live sockets once the change commits, so they rejoin with their new access. */
export async function accessChanged(tx: Executor, orgId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length) await notify(tx, orgId, { type: "access.changed", userIds: [...new Set(userIds)] });
}

export async function roleUserIds(ex: Executor, orgId: string, roleKey: string): Promise<string[]> {
  return (await ex.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, roleKey)))).map((r) => r.id);
}

/** 409 role_exists if another role of the org has this label (any case). */
export async function assertLabelFree(ex: Executor, orgId: string, label: string, exceptKey?: string): Promise<void> {
  const [clash] = await ex
    .select({ key: roles.key })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), sql`lower(${roles.label}) = lower(${label})`, exceptKey ? sql`${roles.key} <> ${exceptKey}` : undefined));
  if (clash) throw new HttpError(409, "role_exists", `The role "${clash.key}" already has the name "${label}". Choose another name.`);
}

/** Every catalogue key for one user: allowed or not, and whether that comes from the role or an exception. */
export async function userPermissionView(ex: Executor, target: { id: string; orgId: string; role: string }) {
  const role = await getRole(ex, target.orgId, target.role);
  if (!role) throw new HttpError(404, "not_found", "This user's role does not exist.");
  const [fromRole, overrides] = await Promise.all([roleAllowed(ex, role), userOverrides(ex, target.id)]);
  const effective = effectivePermissionSet(fromRole, overrides);
  const byKey = new Map(overrides.map((o) => [o.permission, o.allowed]));
  return {
    role: role.key,
    roleLabel: role.label,
    permissions: PERMISSION_KEYS.map((key) => ({
      key,
      allowed: effective.has(key),
      source: byKey.has(key) ? ("override" as const) : ("role" as const),
      /** What the role alone gives, so the drawer can show "Role default: allowed" next to an exception */
      roleAllowed: fromRole.has(key),
    })),
    overrides,
  };
}

/** The user's exception, else their role's setting (SQL, for every user at once). Only for ADMIN_ALWAYS keys. */
const has = (permission: PermissionKey) => sql`coalesce(
  (SELECT o.allowed FROM ${userPermissionOverrides} o WHERE o.user_id = ${users.id} AND o.permission = ${permission}),
  ${users.role} = 'admin' OR coalesce((SELECT rp.allowed FROM ${rolePermissions} rp WHERE rp.org_id = ${users.orgId} AND rp.role_key = ${users.role} AND rp.permission = ${permission}), false)
)`;

/**
 * At least one active user must still manage users and roles (§1). Run inside the change's transaction,
 * after the change and under lockAccess: a 409 rolls the change back.
 * users.manage and roles.manage default to admin only, so a missing role row means "not allowed" for
 * every other role; the admin role always has them.
 */
export async function assertAdminRemains(tx: Executor, orgId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.active, true), has("users.manage"), has("roles.manage")));
  if (!Number(row?.n ?? 0)) {
    throw new HttpError(409, "last_admin", "At least one active admin must remain who can manage users and roles. Make someone else an admin first.");
  }
}
