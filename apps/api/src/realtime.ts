// Live queue updates over Socket.IO. Every API instance LISTENs on Postgres and forwards events to
// its own sockets, so several instances need no extra fan-out service. Operators join only the
// rooms of their platforms. Events carry ids; the browser refetches what it shows.

import { EVENTS_CHANNEL, type Db, type SociaEventEnvelope } from "@socia/db";
import type { FastifyBaseLogger } from "fastify";
import type { Server as HttpServer } from "node:http";
import pg from "pg";
import { Server } from "socket.io";
import { COOKIE, loadSession, permissions, type SessionUser } from "./auth";

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export const room = (orgId: string, platform: string) => `org:${orgId}:${platform}`;

export function attachRealtime(server: HttpServer, opts: { db: Db; databaseUrl: string; corsOrigins: string[]; log: FastifyBaseLogger }): () => Promise<void> {
  const io = new Server(server, { cors: { origin: opts.corsOrigins, credentials: true } });

  io.use(async (socket, next) => {
    const session = await loadSession(opts.db, readCookie(socket.handshake.headers.cookie, COOKIE)).catch(() => null);
    if (!session?.verified) return next(new Error("signed_out"));
    socket.data.user = session.user;
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as SessionUser;
    for (const platform of permissions(user).platforms) void socket.join(room(user.orgId, platform));
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
    await client?.end().catch(() => undefined);
    await new Promise<void>((resolve) => io.close(() => resolve()));
  };
}
