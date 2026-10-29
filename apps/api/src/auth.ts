// Sessions for 8–9 internal users: password, then TOTP. The session cookie is httpOnly and holds a
// random token; only its sha256 is stored. Every POST/PATCH/PUT/DELETE also needs the X-CSRF header
// that /me and /auth/login return.

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import {
  effectivePermissionSet, isPermissionKey, permissionLabel, rolePermissionSet, type PermissionKey, type PermissionSetting,
} from "@socia/core";
import { rolePermissions, roles, sessions, userPermissionOverrides, users, type Db } from "@socia/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

export const COOKIE = "socia_session";

export interface SessionUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  /** roles.key */
  role: string;
  roleLabel: string;
  /** The role limits its users to their own platforms (operator, or a custom role) */
  platformScoped: boolean;
  platforms: string[];
  totpEnabled: boolean;
  active: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Effective permissions, resolved once per request (exception, else role) */
  permissions: ReadonlySet<PermissionKey>;
  /** This user's exceptions to their role */
  overrides: { permission: PermissionKey; allowed: boolean }[];
}

export interface SessionInfo {
  id: string;
  csrfToken: string;
  verified: boolean;
  user: SessionUser;
}

declare module "fastify" {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

export const hashPassword = (password: string) => hash(password);
export const checkPassword = (stored: string, password: string) => verify(stored, password).catch(() => false);

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(db: Db, userId: string, verified: boolean, hours: number) {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  const [row] = await db.insert(sessions).values({ userId, tokenHash: tokenHash(token), csrfToken, verified, expiresAt }).returning();
  return { token, session: row! };
}

export async function loadSession(db: Db, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  // One round trip: the session, its user, the role, the role's stored settings and the user's exceptions
  const [row] = await db
    .select({
      s: sessions,
      u: users,
      roleLabel: roles.label,
      builtIn: roles.builtIn,
      platformScoped: roles.platformScoped,
      roleRows: sql<PermissionSetting[]>`coalesce((SELECT json_agg(json_build_object('permission', ${rolePermissions.permission}, 'allowed', ${rolePermissions.allowed})) FROM ${rolePermissions} WHERE ${rolePermissions.orgId} = ${users.orgId} AND ${rolePermissions.roleKey} = ${users.role}), '[]'::json)`,
      overrideRows: sql<PermissionSetting[]>`coalesce((SELECT json_agg(json_build_object('permission', ${userPermissionOverrides.permission}, 'allowed', ${userPermissionOverrides.allowed})) FROM ${userPermissionOverrides} WHERE ${userPermissionOverrides.userId} = ${users.id}), '[]'::json)`,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(roles, and(eq(roles.orgId, users.orgId), eq(roles.key, users.role)))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, sql`now()`), eq(users.active, true)));
  if (!row) return null;
  const { s, u } = row;
  const overrides = row.overrideRows.filter((o): o is { permission: PermissionKey; allowed: boolean } => isPermissionKey(o.permission));
  return {
    id: s.id,
    csrfToken: s.csrfToken,
    verified: s.verified,
    user: {
      id: u.id, orgId: u.orgId, name: u.name, email: u.email, role: u.role, roleLabel: row.roleLabel, platformScoped: row.platformScoped,
      platforms: u.platforms, totpEnabled: u.totpEnabled, active: u.active, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
      permissions: effectivePermissionSet(rolePermissionSet(u.role, row.builtIn, row.roleRows), overrides),
      overrides,
    },
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Allowed between password and TOTP: method and route */
const UNVERIFIED_OK = new Set(["GET /me", "POST /auth/totp", "POST /auth/totp/setup", "POST /auth/totp/enable", "POST /auth/logout"]);
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Runs before every route that is not public. */
export function guard(req: FastifyRequest): SessionInfo {
  const s = req.session;
  if (!s) throw new HttpError(401, "signed_out", "Sign in to continue.");
  const path = req.routeOptions.url ?? req.url;
  if (!s.verified && !UNVERIFIED_OK.has(`${req.method} ${path}`)) {
    throw new HttpError(403, s.user.totpEnabled ? "totp_required" : "totp_setup_required", s.user.totpEnabled ? "Enter the code from your authenticator app." : "Set up two-step sign-in to continue.");
  }
  if (MUTATING.has(req.method) && req.headers["x-csrf"] !== s.csrfToken) {
    throw new HttpError(403, "csrf", "This request is missing its security token. Reload the page and try again.");
  }
  return s;
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, hours: number): void {
  reply.setCookie(COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: hours * 3600 });
}

// ─── Permissions ─────────────────────────────────────────────────────────────
// Every check names a permission key from @socia/core (permissions.ts); the built-in defaults give each
// role exactly what the old role checks gave it. A platform-scoped role (operator) acts only on the
// user's own platforms; other roles act on any platform.

export const can = (user: SessionUser, key: PermissionKey): boolean => user.permissions.has(key);

/** Throws 403 unless the user has (any one of) the permission(s), on this platform when one is given. */
export function requirePermission(user: SessionUser, keys: PermissionKey | readonly PermissionKey[], platform?: string): void {
  const list: readonly PermissionKey[] = typeof keys === "string" ? [keys] : keys;
  if (!list.some((k) => user.permissions.has(k))) {
    const names = list.map((k) => `"${permissionLabel(k)}"`).join(" or ");
    throw new HttpError(403, "forbidden", `You need the ${names} permission to do this. Ask an admin.`);
  }
  if (platform !== undefined && user.platformScoped && !user.platforms.includes(platform)) {
    throw new HttpError(403, "forbidden", "Your role cannot do this on this platform.");
  }
}

/** The platforms whose live events the user receives: their own for a platform-scoped role, else X. */
export const livePlatforms = (user: SessionUser): string[] => (user.platformScoped ? user.platforms : ["x"]);

/** The old /me "permissions" object, kept as "access" for clients that still read it. */
export function legacyAccess(user: SessionUser) {
  return {
    platforms: livePlatforms(user),
    canAct: can(user, "post.publish") || can(user, "draft.edit"),
    canEditLibrary: can(user, "page.settings"),
    canManageUsers: can(user, "users.manage"),
  };
}
