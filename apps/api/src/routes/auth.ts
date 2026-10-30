import { PERMISSIONS, PERMISSION_KEYS, matchTotpStep, newTotpSecret, phaseFeatures, totpUri } from "@socia/core";
import { audit, sessions, users } from "@socia/db";
import { decryptSecret, encryptSecret } from "@socia/providers";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { accessChanged } from "../access";
import { COOKIE, HttpError, checkPassword, createSession, guard, hashPassword, legacyAccess, setSessionCookie, type SessionInfo } from "../auth";
import type { AppDeps } from "../app";
import { SlidingLimiter } from "../limiter";

/**
 * Sign-in throttling, per API instance (in memory). Only FAILURES count (a wrong password, an unknown email,
 * a wrong code), so signing in correctly never uses anyone's budget. Three sliding limits per step:
 * - per IP + account (strict, 1 minute): stops one client guessing one account, and is what a stranger can
 *   spend against someone else's account from their own IP;
 * - per IP (1 minute): stops one client spraying many accounts;
 * - per account (loose, 15 minutes): a ceiling for a guess spread over many IPs. A distributed attacker can
 *   use it to hold an account off for at most `accountWindowMs`; that is the price of the ceiling.
 */
export interface AuthLimits {
  loginFailuresPerIpAccount: number;
  loginFailuresPerIp: number;
  loginFailuresPerAccount: number;
  totpFailuresPerIpAccount: number;
  totpFailuresPerIp: number;
  totpFailuresPerAccount: number;
  /** Wrong codes one half-signed-in session may try; the last one deletes the session (sign in again) */
  totpFailuresPerSession: number;
  /** Window of the per IP + account and per IP limits */
  windowMs: number;
  /** Window of the per-account ceiling */
  accountWindowMs: number;
}
export const AUTH_LIMITS: AuthLimits = {
  loginFailuresPerIpAccount: 10, loginFailuresPerIp: 30, loginFailuresPerAccount: 30,
  totpFailuresPerIpAccount: 10, totpFailuresPerIp: 30, totpFailuresPerAccount: 30,
  totpFailuresPerSession: 5, windowMs: 60_000, accountWindowMs: 15 * 60_000,
};

/** The three failure limits of one sign-in step */
class FailureGate {
  private readonly ipAccount: SlidingLimiter;
  private readonly ip: SlidingLimiter;
  private readonly account: SlidingLimiter;

  constructor(perIpAccount: number, perIp: number, perAccount: number, private readonly limits: AuthLimits) {
    this.ipAccount = new SlidingLimiter(perIpAccount, limits.windowMs);
    this.ip = new SlidingLimiter(perIp, limits.windowMs);
    this.account = new SlidingLimiter(perAccount, limits.accountWindowMs);
  }

  /** Seconds to wait when a limit is used up, else 0 */
  retryAfter(ip: string, account: string): number {
    if (this.account.isOver(account)) return Math.ceil(this.limits.accountWindowMs / 1000);
    if (this.ipAccount.isOver(`${ip}|${account}`) || this.ip.isOver(ip)) return Math.ceil(this.limits.windowMs / 1000);
    return 0;
  }

  fail(ip: string, account: string): void {
    this.ipAccount.record(`${ip}|${account}`);
    this.ip.record(ip);
    this.account.record(account);
  }

  close(): void {
    for (const l of [this.ipAccount, this.ip, this.account]) l.close();
  }
}

export const authRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db, config, authLimits }) => {
  const limits = { ...AUTH_LIMITS, ...authLimits };
  const loginGate = new FailureGate(limits.loginFailuresPerIpAccount, limits.loginFailuresPerIp, limits.loginFailuresPerAccount, limits);
  const totpGate = new FailureGate(limits.totpFailuresPerIpAccount, limits.totpFailuresPerIp, limits.totpFailuresPerAccount, limits);
  /** session id -> wrong codes so far */
  const totpFailures = new Map<string, { n: number; at: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of totpFailures) if (now - v.at > 3600_000) totpFailures.delete(k);
  }, 600_000);
  sweep.unref();
  app.addHook("onClose", async () => {
    loginGate.close();
    totpGate.close();
    clearInterval(sweep);
  });
  // Unknown and inactive emails still pay for one argon2 verify, so the response time does not tell them apart
  const dummyHash = await hashPassword(randomBytes(24).toString("base64url"));

  const rateLimited = (reply: FastifyReply, seconds: number, message = "Too many failed sign-in attempts. Wait a while and try again.") => {
    reply.header("retry-after", String(seconds));
    return new HttpError(429, "rate_limited", message);
  };

  app.post(
    "/auth/login",
    {
      schema: {
        body: Type.Object({ email: Type.String({ minLength: 3, maxLength: 200 }), password: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const wait = loginGate.retryAfter(req.ip, email);
      if (wait) throw rateLimited(reply, wait);
      const [user] = await db.select().from(users).where(eq(users.email, email));
      const passwordOk = await checkPassword(user?.passwordHash ?? dummyHash, req.body.password);
      // Same answer (and the same work) for an unknown email, an inactive user and a wrong password
      if (!user || !user.active || !passwordOk) {
        loginGate.fail(req.ip, email);
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

  /**
   * Checks a code and claims its time step for the user in one statement: the step must be newer than the last
   * accepted one, so a code works once (no replay, and of two concurrent submits of one code only one wins).
   * `extra` columns are set in the same UPDATE. False for a wrong code or a replay alike.
   */
  const acceptCode = async (userId: string, secretEnc: string, code: string, extra: { totpEnabled?: true } = {}): Promise<boolean> => {
    const step = matchTotpStep(decryptSecret(secretEnc, config.secretKey), code, new Date());
    if (step === null) return false;
    const claimed = await db
      .update(users)
      .set({ totpLastStep: step, ...extra })
      .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))))
      .returning({ id: users.id });
    return claimed.length === 1;
  };

  app.post("/auth/totp", { schema: { body: Type.Object({ code: Type.String({ pattern: "^\\s*\\d{6}\\s*$" }) }, { additionalProperties: false }) } }, async (req, reply) => {
    const s = guard(req);
    const wait = totpGate.retryAfter(req.ip, s.user.id);
    if (wait) throw rateLimited(reply, wait, "Too many wrong codes. Wait a while and try again.");
    const [user] = await db.select().from(users).where(eq(users.id, s.user.id));
    if (!user?.totpEnabled || !user.totpSecretEnc) throw new HttpError(409, "totp_not_set_up", "Set up two-step sign-in first.");
    // A replayed code (its step already used) counts as a wrong one
    if (!(await acceptCode(user.id, user.totpSecretEnc, req.body.code))) {
      const now = Date.now();
      totpGate.fail(req.ip, s.user.id);
      const n = (totpFailures.get(s.id)?.n ?? 0) + 1;
      if (n >= limits.totpFailuresPerSession) {
        // Locked: this half-signed-in session is gone; more tries need a new password sign-in
        totpFailures.delete(s.id);
        await db.delete(sessions).where(eq(sessions.id, s.id));
        reply.clearCookie(COOKIE, { path: "/" });
        throw rateLimited(reply, 0, "Too many wrong codes. Sign in again with your password.");
      }
      totpFailures.set(s.id, { n, at: now });
      throw new HttpError(401, "bad_code", "That code is wrong or has expired. Try the current one.");
    }
    totpFailures.delete(s.id);
    await db.update(sessions).set({ verified: true }).where(eq(sessions.id, s.id));
    return { ok: true };
  });

  /** Step 1 of setup: a new secret to scan. Not active until /auth/totp/enable proves it works. */
  app.post("/auth/totp/setup", async (req) => {
    const s = guard(req);
    if (s.user.totpEnabled) throw new HttpError(409, "totp_already_on", "Two-step sign-in is already on. Ask an admin to reset it.");
    const secret = newTotpSecret();
    // A new secret starts with no used step
    await db.update(users).set({ totpSecretEnc: encryptSecret(secret, config.secretKey), totpLastStep: null }).where(eq(users.id, s.user.id));
    return { secret, otpauthUri: totpUri(secret, s.user.email) };
  });

  app.post("/auth/totp/enable", { schema: { body: Type.Object({ code: Type.String({ pattern: "^\\s*\\d{6}\\s*$" }) }, { additionalProperties: false }) } }, async (req, reply) => {
    const s = guard(req);
    const wait = totpGate.retryAfter(req.ip, s.user.id);
    if (wait) throw rateLimited(reply, wait, "Too many wrong codes. Wait a while and try again.");
    const [user] = await db.select().from(users).where(eq(users.id, s.user.id));
    if (!user?.totpSecretEnc) throw new HttpError(409, "totp_not_set_up", "Start setup first.");
    // Turns two-step on in the same UPDATE that claims the code's step; a replayed code counts as a wrong one
    if (!(await acceptCode(user.id, user.totpSecretEnc, req.body.code, { totpEnabled: true }))) {
      totpGate.fail(req.ip, s.user.id);
      throw new HttpError(401, "bad_code", "That code is wrong. Check the time on your phone and try again.");
    }
    await db.update(sessions).set({ verified: true }).where(eq(sessions.id, s.id));
    return { ok: true };
  });

  app.post("/auth/logout", async (req, reply) => {
    const s = guard(req);
    await db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, s.id));
      // This session's live socket goes too
      await accessChanged(tx, s.user.orgId, [], [s.id]);
    });
    totpFailures.delete(s.id);
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
    /** The backend's PHASE: the desk's one switch (handoff/phase1-contract.md §0) */
    phase: config.phase ?? 2,
    features: phaseFeatures(config.phase ?? 2),
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
        const gone = await tx.delete(sessions).where(and(eq(sessions.userId, s.user.id), ne(sessions.id, s.id))).returning({ id: sessions.id });
        // The other sessions' live sockets go too
        await accessChanged(tx, s.user.orgId, [], gone.map((g) => g.id));
        await audit(tx, { orgId: s.user.orgId, actorId: s.user.id, action: "user.password_changed", entityType: "user", entityId: s.user.id });
      });
      return { ok: true };
    },
  );
};
