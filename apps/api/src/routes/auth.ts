import { newTotpSecret, totpUri, verifyTotp } from "@socia/core";
import { sessions, users } from "@socia/db";
import { decryptSecret, encryptSecret } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { eq } from "drizzle-orm";
import { COOKIE, HttpError, checkPassword, createSession, guard, permissions, setSessionCookie } from "../auth";
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

  app.get("/me", async (req) => {
    const s = guard(req);
    return {
      user: { id: s.user.id, name: s.user.name, email: s.user.email, role: s.user.role, platforms: s.user.platforms },
      csrfToken: s.csrfToken,
      verified: s.verified,
      next: s.verified ? "done" : s.user.totpEnabled ? "totp" : "totp_setup",
      permissions: permissions(s.user),
    };
  });
};
