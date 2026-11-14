// Live desk over plain HTTP: one Server-Sent Events stream per tab (server → browser) and REST POSTs (browser →
// server) for presence and watch mode (presence.ts). Needs no extra port: the browser reaches it through the desk's
// /socia-api proxy like every other route. LIVE=false turns it off (every /live path is then a 404).
//
// GET /live/stream?platform=x   text/event-stream; first event "hello" { clientId }, then presence.list, presence's
//                               own events, the org's queue events for that platform (draft.claimed, story.arrived,
//                               …) and "resync" after the event listener reconnects. ": ping" every 15 s.
//                               "replaced" {} just before the server closes it for a newer stream of the same user
//                               (the browser should not reconnect). Headers: private, no-store, no-transform;
//                               X-Accel-Buffering: no; sent at once.
// GET /live/stream?platform=x&probe=1
//                               a reachability check: the same auth and the same headers, then the response ends.
//                               No client is registered, it is not counted towards the per-person stream limit and
//                               never makes another stream "replaced".
// POST /live/join | /live/leave | /live/state | /live/takeover/request | /live/takeover/answer
//                               body { clientId, … }, answer { ok, error?, mode? }. The clientId must be a stream
//                               opened by this same session (else 403). A take-over request on a posted story
//                               under a correction hold: 409 { ok: false, error: "correcting" }.
//
// A stream lives only as long as its session: access.changed closes it at once, and every recheckMs the open
// streams' sessions are checked again (gone, expired, user deactivated, or the user's platforms changed since the
// stream opened → closed). At most MAX_STREAMS_PER_USER streams per user; a new one closes the oldest.

import { randomUUID } from "node:crypto";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@fastify/type-provider-typebox";
import { postDrafts } from "@socia/db";
import { and, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";
import { HttpError, guard, liveSessionIds, type SessionUser } from "../auth";
import type { AppDeps } from "../app";
import { createEventFeed, type FeedEvent } from "../events";
import { PresenceHub, type LiveClient, type PresenceResult } from "../presence";

export const PING_MS = 15_000;
export const MAX_STREAMS_PER_USER = 8;
export const STREAM_RECHECK_MS = 60_000;
/** A stream whose unsent output passes this is too slow to keep up: closed, the browser reconnects */
const MAX_BUFFERED = 1 << 20;
/** Past this much unsent output a stream is skipped for live text (edit.state) */
const LAGGING_BUFFERED = 256 * 1024;

export interface LiveOptions {
  pingMs?: number;
  /** presence.ts: how often a draft with an editor re-reads its lock */
  refreshMs?: number;
  /** presence.ts: presence.list broadcasts per org at most this often */
  throttleMs?: number;
  /** presence.ts: how long a person waits before asking for the same story again */
  takeoverCooldownMs?: number;
  recheckMs?: number;
  maxStreamsPerUser?: number;
}

const STATUS: Record<string, number> = {
  bad_request: 400,
  unknown_client: 403,
  not_your_client: 403,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  cooldown: 429,
  correcting: 409,
};
const statusOf = (r: PresenceResult) => (r.ok ? 200 : (STATUS[r.error ?? ""] ?? 200));

/** Event names on the stream: plain lowercase words and dots, nothing that could break the SSE framing */
const EVENT_NAME = /^[a-z][\w.]*$/;

/** One SSE frame, or null for an event name that is not plain */
export function sseFrame(event: string, data: unknown): string | null {
  if (!EVENT_NAME.test(event)) return null;
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const StreamQuery = Type.Object({
  platform: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" })),
  /** 1: only check that the stream can be opened (auth, platform, headers through the proxy), then end */
  probe: Type.Optional(Type.String({ pattern: "^[01]$" })),
});

/** The stream's response headers (the probe sends the same) */
const STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "private, no-store, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
} as const;

interface Stream {
  client: LiveClient;
  ping(): void;
}

const samePlatforms = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export const liveRoutes: FastifyPluginAsyncTypebox<AppDeps> = async (app, deps) => {
  const opts = deps.live ?? {};
  const { db } = deps;

  /**
   * Whether the user could take the story if its holder let go, so asking makes sense: Edit drafts on the story's
   * platform. A posted story (status published) is held only under a correction hold, and that is never taken over:
   * "correcting", whoever asks.
   */
  const mayTakeOver = async (user: SessionUser, draftId: string): Promise<boolean | "correcting"> => {
    const [d] = await db.select({ status: postDrafts.status, platform: postDrafts.platform }).from(postDrafts).where(and(eq(postDrafts.id, draftId), eq(postDrafts.orgId, user.orgId)));
    if (!d) return false;
    if (d.status === "published") return "correcting";
    return user.permissions.has("draft.edit") && (!user.platformScoped || user.platforms.includes(d.platform));
  };

  const hub = new PresenceHub({
    db,
    log: app.log,
    refreshMs: opts.refreshMs,
    throttleMs: opts.throttleMs,
    takeoverCooldownMs: opts.takeoverCooldownMs,
    mayTakeOver,
  });
  const streams = new Map<string, Stream>();
  const maxStreams = opts.maxStreamsPerUser ?? MAX_STREAMS_PER_USER;

  // The process's shared LISTEN connection (index.ts); tests without one get a feed of their own, opened with the
  // first stream and closed with the app
  const feed = deps.events ?? createEventFeed({ databaseUrl: deps.config.databaseUrl, log: app.log });
  let unsubscribe: (() => void) | null = null;

  const onFeed = (event: FeedEvent) => {
    if (event.type === "resync") {
      // Locks may have moved while the listener was down
      void hub.refreshAll();
      for (const s of streams.values()) s.client.send("resync", {});
      return;
    }
    const { orgId, platform = "x", ...rest } = event;
    if (rest.type === "access.changed") {
      const ids = new Set(rest.userIds);
      const sessionIds = new Set(rest.sessionIds ?? []);
      for (const s of [...streams.values()]) {
        const c = s.client;
        if (c.user.orgId === orgId && (ids.has(c.user.id) || sessionIds.has(c.sessionId))) c.close();
      }
      return;
    }
    hub.onEvent(orgId, rest);
    for (const s of streams.values()) {
      if (s.client.user.orgId === orgId && s.client.platform === platform) s.client.send(rest.type, rest);
    }
  };

  const ping = setInterval(() => {
    for (const s of streams.values()) s.ping();
  }, opts.pingMs ?? PING_MS);
  ping.unref();

  let checking = false;
  const recheck = setInterval(() => {
    if (checking || !streams.size) return;
    checking = true;
    const open = [...streams.values()].map((s) => s.client);
    void liveSessionIds(db, [...new Set(open.map((c) => c.sessionId))])
      .then((live) => {
        for (const c of open) {
          const now = live.get(c.sessionId);
          // Gone, or the user's platform scope changed since the stream opened: it reconnects under the new one
          if (!now || now.platformScoped !== c.user.platformScoped || !samePlatforms(now.platforms, c.user.platforms)) c.close();
        }
      })
      .catch((err) => app.log.warn({ err }, "could not re-check live stream sessions"))
      .finally(() => {
        checking = false;
      });
  }, opts.recheckMs ?? STREAM_RECHECK_MS);
  recheck.unref();

  // Open streams never go idle: end them before the server waits for its connections to finish
  app.addHook("preClose", async () => {
    clearInterval(ping);
    clearInterval(recheck);
    for (const s of [...streams.values()]) s.client.close();
  });
  app.addHook("onClose", async () => {
    hub.close();
    unsubscribe?.();
    if (!deps.events) await feed.close();
  });

  app.get("/live/stream", { schema: { querystring: StreamQuery } }, async (req, reply) => {
    const session = guard(req);
    const { user } = session;
    const platform = req.query.platform ?? "x";
    if (user.platformScoped && !user.platforms.includes(platform)) throw new HttpError(403, "forbidden", "Your role cannot see this platform.");

    // The probe: the stream's answer and headers, then the end; nothing registered, counted or replaced
    if (req.query.probe === "1") {
      reply.hijack();
      reply.raw.writeHead(200, { ...(reply.getHeaders() as Record<string, string>), ...STREAM_HEADERS });
      reply.raw.end();
      return;
    }

    unsubscribe ??= feed.subscribe(onFeed);

    // The ninth stream of a user closes the oldest, which is told so it does not reconnect (and close this one)
    const mine = [...streams.values()].filter((s) => s.client.user.id === user.id);
    while (mine.length >= maxStreams) {
      const oldest = mine.shift()!.client;
      oldest.send("replaced", {});
      oldest.close();
    }

    const id = randomUUID();
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { ...(reply.getHeaders() as Record<string, string>), ...STREAM_HEADERS });
    // Headers out now, not with the first write: a proxy or browser sees the stream open at once
    raw.flushHeaders();

    let open = true;
    const finish = () => {
      if (!open) return;
      open = false;
      streams.delete(id);
      hub.disconnect(id);
      raw.end();
    };
    const write = (chunk: string) => {
      if (!open) return;
      if (raw.writableLength > MAX_BUFFERED) return finish();
      raw.write(chunk);
    };
    const client: LiveClient = {
      id,
      user,
      sessionId: session.id,
      platform,
      send: (event, data) => {
        const frame = sseFrame(event, data);
        if (frame) write(frame);
      },
      lagging: () => raw.writableLength > LAGGING_BUFFERED,
      close: finish,
    };
    streams.set(id, { client, ping: () => write(": ping\n\n") });
    req.raw.on("close", finish);
    raw.on("error", finish);

    client.send("hello", { clientId: id });
    hub.connect(client);
  });

  /** A POST that acts for one of this session's streams */
  const action = (path: string, run: (clientId: string, body: Record<string, unknown>) => PresenceResult | Promise<PresenceResult>) =>
    app.post(path, async (req, reply: FastifyReply) => {
      const session = guard(req);
      const body = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) return reply.status(400).send({ ok: false, error: "bad_request" });
      const { clientId } = body as Record<string, unknown>;
      if (typeof clientId !== "string") return reply.status(400).send({ ok: false, error: "bad_request" });
      const client = hub.get(clientId);
      if (!client) return reply.status(403).send({ ok: false, error: "unknown_client" });
      if (client.sessionId !== session.id) return reply.status(403).send({ ok: false, error: "not_your_client" });
      const res = await run(clientId, body as Record<string, unknown>);
      return reply.status(statusOf(res)).send(res);
    });

  action("/live/join", (id, body) => hub.join(id, body));
  action("/live/leave", (id, body) => hub.leave(id, body));
  action("/live/state", (id, body) => hub.state(id, body));
  action("/live/takeover/request", (id, body) => hub.takeoverRequest(id, body));
  action("/live/takeover/answer", (id, body) => hub.takeoverAnswer(id, body));
};
