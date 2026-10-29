import { PERMISSIONS, PERMISSION_KEYS, newTotpSecret, totpUri, verifyTotp } from "@socia/core";
import { audit, sessions, users } from "@socia/db";
import { decryptSecret, encryptSecret } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, eq, ne, sql } from "drizzle-orm";
import { COOKIE, HttpError, checkPassword, createSession, guard, hashPassword, legacyAccess, setSessionCookie, type SessionInfo } from "../auth";
import type { AppDeps } from "../app";

export const authRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, config }) => {
  app.post(
    "/auth/login",
    { schema: { body: Type.Object({ email: Type.String({ minLength: 3 }), password: Type.String({ minLength: 1 }) }) } },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const [user] = await db.select().from(users).where(eq(users.email, email));
      // Same answer for an unknown email and a wrong password
      if (!user || !user.active || !(await checkPassword(user.passwordHash, req.body.password))) {
        throw new HttpError(401, "bad_login", "That email and password do not match.");
      }
      await db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user.id));
      const verified = !user.totpEnabled && !config.requireTotp;
      const { token, session } = await createSession(db, user.id, verified, config.sessionHours);
      setSessionCookie(reply, token, config.cookieSecure, config.sessionHours);
      return {
        csrfToken: session.csrfToken,
        next: verified ? "done" : user.totpEnabled ? "totp" : "totp_setup",
      };
    },
  );

  app.post("/auth/totp", { schema: { body: Type.Object({ code: Type.String({ pattern: "^\\s*\\d{6}\\s*$" }) }) } }, async (req) => {
    const s = guard(req);
    const [user] = await db.select().from(users).where(eq(users.id, s.user.id));
    if (!user?.totpEnabled || !user.totpSecretEnc) throw new HttpError(409, "totp_not_set_up", "Set up two-step sign-in first.");
    if (!verifyTotp(decryptSecret(user.totpSecretEnc, config.secretKey), req.body.code, new Date())) {
      throw new HttpError(401, "bad_code", "That code is wrong or has expired. Try the current one.");
    }
    await db.update(sessions).set({ verified: true }).where(eq(sessions.id, s.id));
    return { ok: true };
  });

  /** Step 1 of setup: a new secret to scan. Not active until /auth/totp/enable proves it works. */
  app.post("/auth/totp/setup", async (req) => {
    const s = guard(req);
    if (s.user.totpEnabled) throw new HttpError(409, "totp_already_on", "Two-step sign-in is already on. Ask an admin to reset it.");
    const secret = newTotpSecret();
    await db.update(users).set({ totpSecretEnc: encryptSecret(secret, config.secretKey) }).where(eq(users.id, s.user.id));
    return { secret, otpauthUri: totpUri(secret, s.user.email) };
  });

  app.post("/auth/totp/enable", { schema: { body: Type.Object({ code: Type.String({ pattern: "^\\s*\\d{6}\\s*$" }) }) } }, async (req) => {
    const s = guard(req);
    const [user] = await db.select().from(users).where(eq(users.id, s.user.id));
    if (!user?.totpSecretEnc) throw new HttpError(409, "totp_not_set_up", "Start setup first.");
    if (!verifyTotp(decryptSecret(user.totpSecretEnc, config.secretKey), req.body.code, new Date())) {
      throw new HttpError(401, "bad_code", "That code is wrong. Check the time on your phone and try again.");
    }
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, s.user.id));
    await db.update(sessions).set({ verified: true }).where(eq(sessions.id, s.id));
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    const s = guard(req);
    await db.delete(sessions).where(eq(sessions.id, s.id));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  /** Who is signed in and what they may do (contract §4). csrfToken/verified/next drive sign-in. */
  const meView = (s: SessionInfo) => ({
    user: {
      id: s.user.id, name: s.user.name, email: s.user.email, role: s.user.role, roleLabel: s.user.roleLabel, platforms: s.user.platforms,
      active: s.user.active, totpEnabled: s.user.totpEnabled, createdAt: s.user.createdAt, lastLoginAt: s.user.lastLoginAt,
      platformScoped: s.user.platformScoped,
    },
    permissions: PERMISSION_KEYS.filter((k) => s.user.permissions.has(k)),
    overrides: s.user.overrides,
    catalogue: PERMISSIONS,
    csrfToken: s.csrfToken,
    verified: s.verified,
    next: s.verified ? "done" : s.user.totpEnabled ? "totp" : "totp_setup",
    /** The pre-0009 "permissions" object, for clients that have not moved to the list */
    access: legacyAccess(s.user),
  });

  app.get("/me", async (req) => meView(guard(req)));

  app.patch(
    "/me",
    { schema: { body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }) } },
    async (req) => {
      const s = guard(req);
      const name = req.body.name.replace(/\s+/g, " ").trim();
      if (!name) throw new HttpError(400, "invalid", "Type your name.");
      if (name !== s.user.name) {
        await db.transaction(async (tx) => {
          await tx.update(users).set({ name }).where(eq(users.id, s.user.id));
          await audit(tx, { orgId: s.user.orgId, actorId: s.user.id, action: "user.name_changed", entityType: "user", entityId: s.user.id, before: { name: s.user.name }, after: { name } });
        });
      }
      return meView({ ...s, user: { ...s.user, name } });
    },
  );

  /** Change your own password; every other session of yours is signed out. */
  app.post(
    "/me/password",
    { schema: { body: Type.Object({ current: Type.String({ minLength: 1, maxLength: 200 }), next: Type.String({ minLength: 12, maxLength: 200 }) }, { additionalProperties: false }) } },
    async (req) => {
      const s = guard(req);
      const [user] = await db.select().from(users).where(eq(users.id, s.user.id));
      if (!user || !(await checkPassword(user.passwordHash, req.body.current))) {
        throw new HttpError(400, "wrong_password", "Your current password is not right.");
      }
      if (req.body.next === req.body.current) throw new HttpError(400, "invalid", "Choose a new password that is different from the current one.");
      const passwordHash = await hashPassword(req.body.next);
      await db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash }).where(eq(users.id, s.user.id));
        await tx.delete(sessions).where(and(eq(sessions.userId, s.user.id), ne(sessions.id, s.id)));
        await audit(tx, { orgId: s.user.orgId, actorId: s.user.id, action: "user.password_changed", entityType: "user", entityId: s.user.id });
      });
      return { ok: true };
    },
  );
};
