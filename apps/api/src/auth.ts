// Sessions for 8–9 internal users: password, then TOTP. The session cookie is httpOnly and holds a
// random token; only its sha256 is stored. Every POST/PATCH/PUT/DELETE also needs the X-CSRF header
// that /me and /auth/login return.

import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { sessions, users, type Db, type UserRole } from "@socia/db";
import { and, eq, gt, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

export const COOKIE = "socia_session";

export interface SessionUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: UserRole;
  platforms: string[];
  totpEnabled: boolean;
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
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, sql`now()`), eq(users.active, true)));
  if (!row) return null;
  const { s, u } = row;
  return {
    id: s.id,
    csrfToken: s.csrfToken,
    verified: s.verified,
    user: { id: u.id, orgId: u.orgId, name: u.name, email: u.email, role: u.role, platforms: u.platforms, totpEnabled: u.totpEnabled },
  };
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const UNVERIFIED_OK = new Set(["/me", "/auth/totp", "/auth/totp/setup", "/auth/totp/enable", "/auth/logout"]);
const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Runs before every route that is not public. */
export function guard(req: FastifyRequest): SessionInfo {
  const s = req.session;
  if (!s) throw new HttpError(401, "signed_out", "Sign in to continue.");
  const path = req.routeOptions.url ?? req.url;
  if (!s.verified && !UNVERIFIED_OK.has(path)) {
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
// operator: only their platforms, posts directly (no editor check, so undo and recall exist)
// editor: any platform, plus hashtag rules and the handle directory
// admin: everything, plus users and tokens · viewer: read only

export function canAct(user: SessionUser, platform: string): boolean {
  if (user.role === "viewer") return false;
  return user.role !== "operator" || user.platforms.includes(platform);
}

export function requireAct(user: SessionUser, platform = "x"): void {
  if (!canAct(user, platform)) throw new HttpError(403, "forbidden", "Your role cannot do this on this platform.");
}

export function requireRole(user: SessionUser, ...roles: UserRole[]): void {
  if (!roles.includes(user.role)) throw new HttpError(403, "forbidden", "Your role cannot do this.");
}

export function permissions(user: SessionUser) {
  return {
    platforms: user.role === "operator" ? user.platforms : ["x"],
    canAct: user.role !== "viewer",
    canEditLibrary: user.role === "editor" || user.role === "admin",
    canManageUsers: user.role === "admin",
  };
}
