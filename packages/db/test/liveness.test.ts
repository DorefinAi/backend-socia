// A Postgres restart must not kill the API or worker (the pool's error listener), and a stopped worker is
// noticed (workerLiveness). The pool tests need TEST_DATABASE_URL; the liveness ones do not.

import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, DB_STATEMENT_TIMEOUT_MS, type DbHandle } from "../src/client";
import { WORKER_POLL_STALE_AFTER_MS, WORKER_STALE_AFTER_MS, workerLiveness, type IngestStatus } from "../src/ingest-status";
import { TEST_URL } from "./helpers";

const NOW = new Date("2026-11-06T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const polled = (at: string): IngestStatus => ({ mode: "folder", lastPollAt: at, lastOkAt: at, lastError: null, cursor: null, recentErrors: [] });

describe("workerLiveness", () => {
  it("never ran: not stopped, nothing seen", () => {
    expect(workerLiveness(null, null, NOW)).toEqual({ lastSeenAt: null, stopped: false });
  });

  it("is stopped only after 90 s without a poll or a heartbeat", () => {
    expect(WORKER_STALE_AFTER_MS).toBe(90_000);
    expect(workerLiveness(polled(ago(89_000)), null, NOW)).toEqual({ lastSeenAt: ago(89_000), stopped: false });
    expect(workerLiveness(polled(ago(90_000)), null, NOW).stopped).toBe(false);
    expect(workerLiveness(polled(ago(91_000)), null, NOW)).toEqual({ lastSeenAt: ago(91_000), stopped: true });
  });

  it("a fresh heartbeat keeps a worker in a long scan alive; the newer of the two counts", () => {
    expect(workerLiveness(polled(ago(600_000)), { at: ago(20_000), pid: 1 }, NOW)).toEqual({ lastSeenAt: ago(20_000), stopped: false });
    expect(workerLiveness(polled(ago(5_000)), { at: ago(600_000), pid: 1 }, NOW)).toEqual({ lastSeenAt: ago(5_000), stopped: false });
    expect(workerLiveness(null, { at: ago(120_000), pid: 1 }, NOW).stopped).toBe(true);
  });

  it("a poll stuck past 15 min is stopped even while the process keeps beating", () => {
    expect(WORKER_POLL_STALE_AFTER_MS).toBe(15 * 60_000);
    const beat = { at: ago(10_000), pid: 1 };
    expect(workerLiveness(polled(ago(14 * 60_000)), beat, NOW).stopped).toBe(false);
    expect(workerLiveness(polled(ago(16 * 60_000)), beat, NOW)).toEqual({ lastSeenAt: ago(10_000), stopped: true });
  });

  it("ignores a broken timestamp", () => {
    expect(workerLiveness(polled("not a date"), null, NOW)).toEqual({ lastSeenAt: null, stopped: false });
  });
});

describe("pool error listener", () => {
  it("is attached, and an 'error' from the pool is logged instead of thrown", async () => {
    const errors: string[] = [];
    // No connection is made: the pool connects lazily
    const h = createDb("postgres://nobody@127.0.0.1:1/none", 1, { log: { error: (_obj, msg) => errors.push(msg) } });
    expect(h.pool.listenerCount("error")).toBeGreaterThan(0);
    expect(() => h.pool.emit("error", new Error("terminating connection due to administrator command"), {} as never)).not.toThrow();
    expect(errors).toEqual(["database connection lost; the pool will reconnect"]);
    await h.close();
  });

  it("sets the connection, idle and statement timeouts", async () => {
    const h = createDb("postgres://nobody@127.0.0.1:1/none", 1);
    const opts = (h.pool as unknown as { options: Record<string, unknown> }).options;
    expect(opts).toMatchObject({ connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, statement_timeout: DB_STATEMENT_TIMEOUT_MS, keepAlive: true });
    const migrations = createDb("postgres://x@127.0.0.1:1/none", 1, { statementTimeoutMs: 0 });
    expect((migrations.pool as unknown as { options: Record<string, unknown> }).options.statement_timeout).toBe(0);
    await h.close();
    await migrations.close();
  });
});

(TEST_URL ? describe : describe.skip)("pool against a real server", () => {
  let h: DbHandle;
  afterAll(async () => {
    await h?.close();
  });

  it("survives its idle connection being killed (as in a Postgres restart) and reconnects", async () => {
    const errors: string[] = [];
    h = createDb(TEST_URL!, 1, { log: { error: (_obj, msg) => errors.push(msg) } });
    const pid = Number((await h.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
    // The one pooled connection is idle now; end it from another session
    const killer = createDb(TEST_URL!, 1);
    await killer.db.execute(sql`select pg_terminate_backend(${pid})`);
    await killer.close();
    await expect.poll(() => errors.length, { timeout: 5_000 }).toBeGreaterThan(0);
    // A new connection for the next query
    const again = Number((await h.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid);
    expect(again).not.toBe(pid);
  });

  it("runs with the statement timeout set", async () => {
    const { rows } = await h.db.execute<{ statement_timeout: string }>(sql`show statement_timeout`);
    expect(rows[0]!.statement_timeout).toBe("1min");
  });
});
