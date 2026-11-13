// Live queue updates over Socket.IO. Every API instance LISTENs on Postgres and forwards events to
// its own sockets, so several instances need no extra fan-out service. Operators join only the
// rooms of their platforms. Events carry ids; the browser refetches what it shows.
//
// A socket lives only as long as its session: access.changed (sign-out, password/TOTP reset, deactivation,
// role/platform change) disconnects it at once, and every `recheckMs` the open sockets' sessions are
// checked again (expired, deleted, user deactivated → disconnected), in case a notify was missed.

import type { Db } from "@socia/db";
import type { FastifyBaseLogger } from "fastify";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { COOKIE, liveSessionIds, livePlatforms, loadSession, type SessionUser } from "./auth";
import { createEventFeed, type EventFeed } from "./events";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const room = (orgId: string, platform: string) => `org:${orgId}:${platform}`;

export const SESSION_RECHECK_MS = 60_000;

export function attachRealtime(
  server: HttpServer,
  opts: {
    db: Db;
    databaseUrl: string;
    corsOrigins: string[];
    log: FastifyBaseLogger;
    recheckMs?: number;
    /** The process's shared LISTEN connection (events.ts); without one, a feed of its own is opened and closed here */
    events?: EventFeed;
  },
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

  const feed = opts.events ?? createEventFeed({ databaseUrl: opts.databaseUrl, log: opts.log });
  const unsubscribe = feed.subscribe((event) => {
    // Anything missed while the listener was down is picked up by a refetch on the client's reconnect
    if (event.type === "resync") {
      io.emit("resync", {});
      return;
    }
    const { orgId, platform = "x", ...rest } = event;
    if (rest.type === "access.changed") {
      const ids = new Set(rest.userIds);
      const sessionIds = new Set(rest.sessionIds ?? []);
      for (const socket of io.sockets.sockets.values()) {
        const u = socket.data.user as SessionUser | undefined;
        if (u && u.orgId === orgId && (ids.has(u.id) || sessionIds.has(socket.data.sessionId as string))) socket.disconnect(true);
      }
      return;
    }
    io.to(room(orgId, platform)).emit(rest.type, rest);
  });

  return async () => {
    clearInterval(recheck);
    unsubscribe();
    if (!opts.events) await feed.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  };
}
