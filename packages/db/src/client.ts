import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run a query: the db or an open transaction */
export type Executor = Db | Tx;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** The part of a pino logger the pool needs (the API and worker pass theirs) */
export interface DbLogger {
  error: (obj: object, msg: string) => void;
}

export interface DbOptions {
  /** Server-side limit per statement; 0 = none (migrations). Default DB_STATEMENT_TIMEOUT_MS */
  statementTimeoutMs?: number;
  /** How long to wait for a new connection before the query fails. Default DB_CONNECT_TIMEOUT_MS */
  connectTimeoutMs?: number;
  /** An idle connection is closed after this. Default DB_IDLE_TIMEOUT_MS */
  idleTimeoutMs?: number;
  log?: DbLogger;
}

// Desk, worker and housekeeping statements take well under a second; migrations (CREATE INDEX on a full
// table) turn the limit off. A minute only stops a runaway query or one stuck behind a lock.
export const DB_STATEMENT_TIMEOUT_MS = 60_000;
export const DB_CONNECT_TIMEOUT_MS = 10_000;
export const DB_IDLE_TIMEOUT_MS = 30_000;

const consoleLog: DbLogger = { error: (obj, msg) => console.error(msg, obj) };

/**
 * An idle pooled connection that the server drops (Postgres restarted by Windows Update, a network blip) makes
 * pg-pool emit "error"; with no listener Node exits. The listener logs it and the pool simply opens a fresh
 * connection for the next query. A query that was running at that moment still fails to its caller.
 */
export function onPoolError(pool: pg.Pool, log: DbLogger = consoleLog): void {
  pool.on("error", (err) => {
    const e = err as Error & { code?: string };
    log.error({ err: { message: e.message, code: e.code } }, "database connection lost; the pool will reconnect");
  });
}

export function createDb(url: string, max = 10, opts: DbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: opts.idleTimeoutMs ?? DB_IDLE_TIMEOUT_MS,
    // 0 is not sent, so the server's own setting (none) applies
    statement_timeout: opts.statementTimeoutMs ?? DB_STATEMENT_TIMEOUT_MS,
    // Notice a dead peer on a half-open socket instead of waiting on it for hours
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  onPoolError(pool, opts.log);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
