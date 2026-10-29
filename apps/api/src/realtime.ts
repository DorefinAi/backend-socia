// Live queue updates over Socket.IO. Every API instance LISTENs on Postgres and forwards events to
// its own sockets, so several instances need no extra fan-out service. Operators join only the
// rooms of their platforms. Events carry ids; the browser refetches what it shows.
//
// A socket lives only as long as its session: access.changed (sign-out, password/TOTP reset, deactivation,
// role/platform change) disconnects it at once, and every `recheckMs` the open sockets' sessions are
// checked again (expired, deleted, user deactivated → disconnected), in case a notify was missed.

import { EVENTS_CHANNEL, sessions, users, type Db, type SociaEventEnvelope } from "@socia/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Server as HttpServer } from "node:http";
import pg from "pg";
import { Server } from "socket.io";
import { COOKIE, livePlatforms, loadSession, type SessionUser } from "./auth";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const room = (orgId: string, platform: string) => `org:${orgId}:${platform}`;

export const SESSION_RECHECK_MS = 60_000;

/** Which of these sessions may still hold a socket: present, unexpired, verified, user active */
async function liveSessionIds(db: Db, ids: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(inArray(sessions.id, ids.slice(i, i + 500)), gt(sessions.expiresAt, sql`now()`), eq(sessions.verified, true), eq(users.active, true)));
    for (const r of rows) live.add(r.id);
  }
  return live;
}

export function attachRealtime(
  server: HttpServer,
  opts: { db: Db; databaseUrl: string; corsOrigins: string[]; log: FastifyBaseLogger; recheckMs?: number },
): () => Promise<void> {
  const io = new Server(server, { cors: { origin: opts.corsOrigins, credentials: true } });

  io.use(async (socket, next) => {
    const session = await loadSession(opts.db, readCookie(socket.handshake.headers.cookie, COOKIE)).catch(() => null);
    if (!session?.verified) return next(new Error("signed_out"));
    socket.data.user = session.user;
    socket.data.sessionId = session.id;
    next();
  });

  let checking = false;
  const recheck = setInterval(() => {
    if (checking) return;
    checking = true;
    const open = [...io.sockets.sockets.values()];
    const ids = [...new Set(open.map((s) => s.data.sessionId as string | undefined).filter((id): id is string => !!id))];
    void (ids.length ? liveSessionIds(opts.db, ids) : Promise.resolve(new Set<string>()))
      .then((live) => {
        for (const socket of open) if (!live.has(socket.data.sessionId as string)) socket.disconnect(true);
      })
      .catch((err) => opts.log.warn({ err }, "could not re-check socket sessions"))
      .finally(() => {
        checking = false;
      });
  }, opts.recheckMs ?? SESSION_RECHECK_MS);
  recheck.unref();

  io.on("connection", (socket) => {
    const user = socket.data.user as SessionUser;
    for (const platform of livePlatforms(user)) void socket.join(room(user.orgId, platform));
  });

  let client: pg.Client | null = null;
  let closed = false;
  let retry = 1000;

  const listen = async () => {
    if (closed) return;
    try {
      client = new pg.Client({ connectionString: opts.databaseUrl });
      client.on("notification", (msg) => {
        try {
          const { orgId, platform = "x", ...event } = JSON.parse(msg.payload ?? "{}") as SociaEventEnvelope;
          if (event.type === "access.changed") {
            const ids = new Set(event.userIds);
            const sessionIds = new Set(event.sessionIds ?? []);
            for (const socket of io.sockets.sockets.values()) {
              const u = socket.data.user as SessionUser | undefined;
              if (u && u.orgId === orgId && (ids.has(u.id) || sessionIds.has(socket.data.sessionId as string))) socket.disconnect(true);
            }
            return;
          }
          io.to(room(orgId, platform)).emit(event.type, event);
        } catch (err) {
          opts.log.warn({ err }, "bad event payload");
        }
      });
      client.on("error", (err) => {
        opts.log.error({ err }, "event listener lost its connection; reconnecting");
        void client?.end().catch(() => undefined);
        setTimeout(listen, retry);
        retry = Math.min(retry * 2, 30_000);
      });
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
      retry = 1000;
      // Anything missed while disconnected is picked up by a refetch on the client's reconnect
      io.emit("resync", {});
    } catch (err) {
      opts.log.error({ err }, "could not start the event listener; retrying");
      setTimeout(listen, retry);
      retry = Math.min(retry * 2, 30_000);
    }
  };
  void listen();

  return async () => {
    closed = true;
    clearInterval(recheck);
    await client?.end().catch(() => undefined);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  };
}
