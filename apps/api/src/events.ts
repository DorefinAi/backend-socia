// One Postgres LISTEN connection per API process, shared by everything that wants the desk's events: the SSE
// stream (/live, routes/live.ts) and Socket.IO when REALTIME=true (realtime.ts). The connection opens with the first
// subscriber, reconnects with backoff (1 s doubling to 30 s) when it drops, and after every (re)connect tells each
// subscriber "resync": anything sent while it was down was missed, so browsers refetch.

import { EVENTS_CHANNEL, type SociaEventEnvelope } from "@socia/db";
import pg from "pg";

export type FeedEvent = SociaEventEnvelope | { type: "resync" };
export type FeedListener = (event: FeedEvent) => void;

interface FeedLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface EventFeed {
  /** Adds a listener (and starts listening if this is the first); returns the unsubscribe */
  subscribe(fn: FeedListener): () => void;
  close(): Promise<void>;
}

export function createEventFeed(opts: { databaseUrl: string; log: FeedLog }): EventFeed {
  const listeners = new Set<FeedListener>();
  let client: pg.Client | null = null;
  let started = false;
  let closed = false;
  let retry = 1000;
  let timer: NodeJS.Timeout | null = null;

  const deliver = (event: FeedEvent) => {
    for (const fn of [...listeners]) {
      try {
        fn(event);
      } catch (err) {
        opts.log.warn({ err, type: event.type }, "event listener failed");
      }
    }
  };

  const again = () => {
    if (closed) return;
    timer = setTimeout(listen, retry);
    retry = Math.min(retry * 2, 30_000);
  };

  const listen = async () => {
    timer = null;
    if (closed) return;
    const c = new pg.Client({ connectionString: opts.databaseUrl });
    client = c;
    try {
      c.on("notification", (msg) => {
        let event: SociaEventEnvelope;
        try {
          const parsed = JSON.parse(msg.payload ?? "{}") as SociaEventEnvelope;
          event = { ...parsed, platform: parsed.platform ?? "x" };
        } catch (err) {
          opts.log.warn({ err }, "bad event payload");
          return;
        }
        deliver(event);
      });
      c.on("error", (err) => {
        if (client !== c) return;
        opts.log.error({ err }, "event listener lost its connection; reconnecting");
        client = null;
        void c.end().catch(() => undefined);
        again();
      });
      await c.connect();
      await c.query(`LISTEN ${EVENTS_CHANNEL}`);
      if (closed || client !== c) {
        await c.end().catch(() => undefined);
        return;
      }
      retry = 1000;
      // Anything missed while disconnected is picked up by a refetch on the client's side
      deliver({ type: "resync" });
    } catch (err) {
      void c.end().catch(() => undefined);
      // Only the current client schedules a retry: when its "error" handler already did (or close() ran), a second
      // retry here would open a second LISTEN and every event would arrive twice
      if (client !== c || closed) return;
      client = null;
      opts.log.error({ err }, "could not start the event listener; retrying");
      again();
    }
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      if (!started && !closed) {
        started = true;
        void listen();
      }
      return () => {
        listeners.delete(fn);
      };
    },
    async close() {
      closed = true;
      listeners.clear();
      if (timer) clearTimeout(timer);
      const c = client;
      client = null;
      await c?.end().catch(() => undefined);
    },
  };
}
