// Users and the audit trail. Admin only, except reading the audit trail of one item.

import { USER_ROLES, auditLog, sessions, users } from "@socia/db";
import { Type, type FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { and, desc, eq } from "drizzle-orm";
import { HttpError, guard, hashPassword, requireRole } from "../auth";
import type { AppDeps } from "../app";

const Role = Type.Union(USER_ROLES.map((r) => Type.Literal(r)));
const Platforms = Type.Array(Type.Literal("x"), { maxItems: 3 });

export const adminRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, { db }) => {
  const publicUser = (u: typeof users.$inferSelect) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, platforms: u.platforms, active: u.active, totpEnabled: u.totpEnabled, createdAt: u.createdAt,
  });

  app.get("/users", async (req) => {
    const { user } = guard(req);
    requireRole(user, "admin");
    return { items: (await db.select().from(users).where(eq(users.orgId, user.orgId))).map(publicUser) };
  });

  app.post(
    "/users",
    {
      schema: {
        body: Type.Object({ name: Type.String({ minLength: 1 }), email: Type.String({ minLength: 3 }), role: Role, platforms: Platforms, password: Type.String({ minLength: 10 }) }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requireRole(user, "admin");
      const [row] = await db
        .insert(users)
        .values({ orgId: user.orgId, name: req.body.name, email: req.body.email.trim().toLowerCase(), role: req.body.role, platforms: req.body.platforms, passwordHash: await hashPassword(req.body.password) })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new HttpError(409, "email_taken", "Someone already uses this email.");
      return publicUser(row);
    },
  );

  app.patch(
    "/users/:id",
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: "uuid" }) }),
        body: Type.Object({
          role: Type.Optional(Role),
          platforms: Type.Optional(Platforms),
          active: Type.Optional(Type.Boolean()),
          password: Type.Optional(Type.String({ minLength: 10 })),
          resetTotp: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req) => {
      const { user } = guard(req);
      requireRole(user, "admin");
      if (req.params.id === user.id && (req.body.role || req.body.active === false)) {
        throw new HttpError(409, "self_change", "Ask another admin to change your own role or access.");
      }
      const { password, resetTotp, ...rest } = req.body;
      const [row] = await db
        .update(users)
        .set({
          ...rest,
          ...(password && { passwordHash: await hashPassword(password) }),
          ...(resetTotp && { totpEnabled: false, totpSecretEnc: null }),
        })
        .where(and(eq(users.id, req.params.id), eq(users.orgId, user.orgId)))
        .returning();
      if (!row) throw new HttpError(404, "not_found", "This user does not exist.");
      // Changed access takes effect now: sign the user out everywhere
      if (password || resetTotp || rest.active === false || rest.role) await db.delete(sessions).where(eq(sessions.userId, row.id));
      return publicUser(row);
    },
  );

  app.get(
    "/audit",
    { schema: { querystring: Type.Object({ entityType: Type.String(), entityId: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) } },
    async (req) => {
      const { user } = guard(req);
      return {
        items: await db
          .select({ a: auditLog, actor: users.name })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.actorId))
          .where(and(eq(auditLog.orgId, user.orgId), eq(auditLog.entityType, req.query.entityType), eq(auditLog.entityId, req.query.entityId)))
          .orderBy(desc(auditLog.at))
          .limit(req.query.limit ?? 50),
      };
    },
  );
};
