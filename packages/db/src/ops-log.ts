// Ops logs and heartbeats for the Sentry control centre (dev-docs/ops-logs-contract.md §1, §3). Sentry pulls them
// through GET /owner/logs; the backends never call it.
//
// OpsLog.stream is one more pino.multistream destination next to stdout: pino hands it each JSON line, which is only
// queued (no parsing, no I/O while the app logs). Every ≤ 2 s the queue is parsed, redacted and batch-inserted into
// ops_log on the sink's own one-connection pool. It never blocks or crashes the app: the queue is bounded (oldest
// dropped first, counted), a failing batch is retried twice and then dropped (counted), and its own failures go to
// stderr at most once a minute, never through pino (no loops). OPS_LOG_ENABLED=false turns the lines off.
// The heartbeat (ops_heartbeat, every 30 s) runs on the same pool.

import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import pg from "pg";
import type { Executor } from "./client";

// ─── Settings ──────────────────────────────────────────────────────────────

export type OpsLevel = "debug" | "info" | "warn" | "error";
const OPS_LEVEL_NAMES: readonly OpsLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_ALIASES: Record<string, OpsLevel> = { trace: "debug", warning: "warn", critical: "error", fatal: "error" };

export interface OpsLogSettings {
  /** OPS_LOG_ENABLED: anything but false/0/off/no = on (the default) */
  enabled: boolean;
  /** OPS_LOG_LEVEL: the lowest level stored (default info); an unknown value is info */
  level: OpsLevel;
}

export function opsLogSettings(env: Record<string, string | undefined> = process.env): OpsLogSettings {
  const raw = (env.OPS_LOG_LEVEL ?? "").trim().toLowerCase();
  const level = (OPS_LEVEL_NAMES as readonly string[]).includes(raw) ? (raw as OpsLevel) : (LEVEL_ALIASES[raw] ?? "info");
  const off = ["false", "0", "off", "no"].includes((env.OPS_LOG_ENABLED ?? "").trim().toLowerCase());
  return { enabled: !off, level };
}

/** pino's numeric level → the contract's: 10/20 debug, 30 info, 40 warn, 50/60 error */
export function opsLevelOf(level: unknown): OpsLevel {
  if (typeof level === "string") {
    const l = level.toLowerCase();
    return (OPS_LEVEL_NAMES as readonly string[]).includes(l) ? (l as OpsLevel) : (LEVEL_ALIASES[l] ?? "info");
  }
  if (typeof level !== "number" || !Number.isFinite(level)) return "info";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  return "debug";
}

// ─── Redaction (contract §3) ───────────────────────────────────────────────

const REDACTED = "[redacted]";
const SENSITIVE = "pass(?:word)?|secret|token|api[_-]?key|authorization|cookie|session|otp|signature";
/** A key whose value is never stored */
export const SENSITIVE_KEY_RE = new RegExp(SENSITIVE, "i");

const BEARER_RE = /\bBearer\s+[^\s"',;]+/gi;
/** scheme://user:pass@ → scheme://[redacted]@ */
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/** ?access_token=…, &X-Amz-Signature=… */
const QUERY_RE = new RegExp(`([?&;][^=&#\\s]{0,40}(?:${SENSITIVE})[^=&#\\s]{0,40}=)[^&#\\s"']*`, "gi");
/**
 * key=value, key: value, "key": "value" in free text. Key lengths are bounded so a long run of word characters
 * cannot make the scan quadratic. A value already redacted is left as it is.
 */
const KV_RE = new RegExp(
  `(["']?)([\\w.-]{0,40}(?:${SENSITIVE})[\\w.-]{0,40})\\1(\\s*[:=]\\s*)(\\[redacted\\]|Bearer\\s+\\[redacted\\]|"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&)}\\]]+)`,
  "gi",
);
/** xxx.yyy.zzz base64url, each part 10+ characters (a JWT; host and file names are shorter or not three parts) */
const JWT_RE = /(?<![\w.-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![\w-])/g;
// Starts only at the start of a word, so a long run of letters with no "@" is scanned once, not from every character
const EMAIL_RE = /(?<![A-Za-z0-9_%+-])([A-Za-z0-9_%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
/**
 * 10–15 digits, optionally after "+" (E.164 is at most 15, so 18–19 digit X post ids are left alone). Not inside a
 * longer word, number or decimal.
 */
const PHONE_RE = /(?<![\w+*.-])(\+?)(\d{10,15})(?![\w-]|\.\d)/g;

const maskPhone = (_m: string, plus: string, d: string) =>
  plus ? `+${d.slice(0, 2)}${"*".repeat(d.length - 6)}${d.slice(-4)}` : `${"*".repeat(d.length - 4)}${d.slice(-4)}`;

/** Contract §3 on free text. Idempotent: redacting twice gives the same text. NUL bytes (Postgres refuses them) go. */
export function redactText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(URL_USERINFO_RE, `$1${REDACTED}@`)
    .replace(QUERY_RE, `$1${REDACTED}`)
    .replace(KV_RE, (_m, q: string, key: string, sep: string, val: string) => {
      const out = val.startsWith('"') ? `"${REDACTED}"` : val.startsWith("'") ? `'${REDACTED}'` : val.startsWith("Bearer") ? val : REDACTED;
      return `${q}${key}${q}${sep}${out}`;
    })
    .replace(JWT_RE, REDACTED)
    .replace(EMAIL_RE, "$1***@$2")
    .replace(PHONE_RE, maskPhone);
}

export type OpsScalar = string | number | boolean | null;
export type OpsFields = Record<string, OpsScalar>;

export const MAX_FIELDS = 20;
const MAX_FIELD_CHARS = 500;
const MAX_KEY_CHARS = 64;
export const MAX_MESSAGE_CHARS = 2000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function fieldValue(key: string, v: unknown): OpsScalar | undefined {
  if (SENSITIVE_KEY_RE.test(key)) return REDACTED;
  if (v === null) return null;
  switch (typeof v) {
    case "string":
      // Clipped before and after: a long value is not scanned in full, a cut token is not left half visible
      return clip(redactText(clip(v, MAX_FIELD_CHARS * 4)), MAX_FIELD_CHARS);
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "boolean":
      return v;
    case "bigint":
      return clip(redactText(v.toString()), MAX_FIELD_CHARS);
    default:
      if (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x))) {
        return clip(redactText(clip(JSON.stringify(v), MAX_FIELD_CHARS * 4)), MAX_FIELD_CHARS);
      }
      return undefined;
  }
}

/**
 * Small extra key/values (contract §1): scalars only, at most 20 keys, redacted. A nested plain object (Fastify's
 * req / res) is flattened one level ("req.url", "res.statusCode"); deeper values and object arrays are left out.
 */
export function redactFields(obj: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): OpsFields | null {
  const out: OpsFields = {};
  let n = 0;
  const put = (key: string, v: unknown) => {
    if (n >= MAX_FIELDS) return;
    const value = fieldValue(key, v);
    if (value === undefined) return;
    out[clip(key, MAX_KEY_CHARS)] = value;
    n += 1;
  };
  for (const [k, v] of Object.entries(obj)) {
    if (n >= MAX_FIELDS) break;
    if (skip.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && !SENSITIVE_KEY_RE.test(k)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 && typeof v2 === "object" && !Array.isArray(v2)) continue;
        put(`${k}.${k2}`, v2);
      }
    } else {
      put(k, v);
    }
  }
  return n ? out : null;
}

// ─── One pino line → one row ───────────────────────────────────────────────

export interface OpsRow {
  at: Date;
  system: string;
  level: OpsLevel;
  logger: string | null;
  message: string;
  slug: string | null;
  itemId: string | null;
  fields: OpsFields | null;
}

/** pino's own keys and the ones that become columns; never copied into fields */
const NOT_FIELDS = new Set(["pid", "hostname", "time", "level", "msg", "service", "v", "stage", "slug", "itemId", "item_id", "err", "name", "loop"]);
/** Ids worth a column when no itemId was given (they stay in fields too, so the kind of id is known) */
const ITEM_ID_KEYS = ["itemId", "item_id", "storyId", "draftId", "jobId"] as const;
const STACK_FRAMES = 6;

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return "";
  const e = err as { message?: unknown; stack?: unknown; type?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  const frames = typeof e.stack === "string" ? e.stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ")).slice(0, STACK_FRAMES) : [];
  const head = message || (typeof e.type === "string" ? e.type : "");
  return [head, ...frames].filter(Boolean).join("\n");
}

const textOrNull = (v: unknown, max: number) => (typeof v === "string" && v ? clip(redactText(v), max) : typeof v === "number" ? String(v) : null);

/** A JSON log line from pino → a row, or null when it is not one. `systemOf` picks the Sentry system id. */
export function parseLogLine(line: string, systemOf: (rec: Record<string, unknown>) => string): OpsRow | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  const at = typeof r.time === "number" ? new Date(r.time) : typeof r.time === "string" ? new Date(r.time) : new Date();

  let message = typeof r.msg === "string" ? r.msg : r.msg === undefined || r.msg === null ? "" : String(r.msg);
  const err = errorText(r.err);
  if (err) {
    const [first = "", ...stack] = err.split("\n");
    const head = !first || message.includes(first) ? message : message ? `${message}: ${first}` : first;
    message = [head, ...stack].filter(Boolean).join("\n");
  }
  const itemKey = ITEM_ID_KEYS.find((k) => r[k] !== undefined && r[k] !== null && r[k] !== "");
  const logger = [r.name, r.loop, r.logger].find((v) => typeof v === "string" && v);
  return {
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    system: systemOf(r),
    level: opsLevelOf(r.level),
    logger: logger ? clip(logger as string, 100) : null,
    // Redacting a little more than is kept is enough (a secret cut at the edge is beyond the kept part anyway)
    message: clip(redactText(clip(message, MAX_MESSAGE_CHARS * 2)), MAX_MESSAGE_CHARS),
    slug: textOrNull(r.slug, 200),
    itemId: itemKey ? textOrNull(r[itemKey], 200) : null,
    fields: redactFields(r, NOT_FIELDS),
  };
}

// ─── Systems ───────────────────────────────────────────────────────────────

/** Worker stages (the `stage` binding on its child loggers) → Sentry system ids */
export const WORKER_STAGE_SYSTEMS: Record<string, string> = {
  ingest: "socia-ingest",
  render: "socia-render",
  publish: "socia-publish",
  crons: "socia-crons",
};
/** A worker line with no (known) stage belongs to ingest (contract §1) */
export const workerSystemOf = (rec: Record<string, unknown>) =>
  (typeof rec.stage === "string" && WORKER_STAGE_SYSTEMS[rec.stage]) || "socia-ingest";

// ─── The sink ──────────────────────────────────────────────────────────────

export interface OpsLogOptions {
  databaseUrl: string;
  /** Sentry system id of every line, unless systemOf says otherwise */
  system: string;
  systemOf?: (rec: Record<string, unknown>) => string;
  /** Store log lines (OPS_LOG_ENABLED); the heartbeat runs either way. Default true */
  enabled?: boolean;
  maxQueue?: number;
  flushMs?: number;
  heartbeatMs?: number;
  batchSize?: number;
  /** Tests: run SQL here instead of a pool of our own */
  query?: OpsQuery;
}

export type OpsQuery = (text: string, values: unknown[]) => Promise<unknown>;

export interface OpsHeartbeatOptions {
  /** ops_heartbeat.process: "api", "worker:<roles>" */
  process: string;
  /** Sentry system id */
  system: string;
  /** Small facts; version (RENDER_GIT_COMMIT or the package version) is added */
  info?: Record<string, unknown>;
}

export const OPS_MAX_QUEUE = 5000;
export const OPS_FLUSH_MS = 2000;
export const OPS_HEARTBEAT_MS = 30_000;
const BATCH_SIZE = 500;
const TRIES = 3;
const COMPLAIN_EVERY_MS = 60_000;
/** Inserts take this lock so ids become visible in id order (a reader paging on id > after never skips a row) */
const INSERT_LOCK = 731_900_019;

const INSERT_SQL = `INSERT INTO ops_log (at, system, level, logger, message, slug, item_id, fields)
SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb[])`;

const HEARTBEAT_SQL = `INSERT INTO ops_heartbeat (process, system, host, pid, started_at, beat_at, info)
VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb)
ON CONFLICT (process) DO UPDATE SET system = excluded.system, host = excluded.host, pid = excluded.pid,
  started_at = excluded.started_at, beat_at = excluded.beat_at, info = excluded.info`;

export class OpsLog {
  /** For pino.multistream: { level, stream: opsLog.stream } */
  readonly stream: { write: (line: string) => void };
  private readonly queue: string[] = [];
  private pending: { rows: OpsRow[]; tries: number } | null = null;
  private flushing: Promise<void> | null = null;
  private droppedLines = 0;
  private lastComplaint = 0;
  private pool: pg.Pool | null = null;
  private closed = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly systemOf: (rec: Record<string, unknown>) => string;
  private readonly startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000));
  private heartbeat: OpsHeartbeatOptions | null = null;

  constructor(private readonly opts: OpsLogOptions) {
    this.maxQueue = opts.maxQueue ?? OPS_MAX_QUEUE;
    this.batchSize = opts.batchSize ?? BATCH_SIZE;
    this.systemOf = opts.systemOf ?? (() => opts.system);
    const enabled = opts.enabled ?? true;
    this.stream = { write: enabled ? (line) => this.push(line) : () => {} };
    if (enabled) this.every(opts.flushMs ?? OPS_FLUSH_MS, () => void this.flush());
  }

  private every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms);
    // Never what keeps the process alive
    t.unref();
    this.timers.push(t);
  }

  /** Upserts this process's ops_heartbeat row now and every 30 s (the process start is the started_at) */
  startHeartbeat(heartbeat: OpsHeartbeatOptions): void {
    if (this.heartbeat || this.closed) return;
    this.heartbeat = heartbeat;
    void this.beat();
    this.every(this.opts.heartbeatMs ?? OPS_HEARTBEAT_MS, () => void this.beat());
  }

  /** Lines this process dropped since it started (queue full, or a batch the database refused three times) */
  get dropped(): number {
    return this.droppedLines;
  }

  get queued(): number {
    return this.queue.length + (this.pending?.rows.length ?? 0);
  }

  private push(line: string): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.droppedLines += 1;
    }
    this.queue.push(line);
  }

  /** Writes everything queued so far (one flush at a time; a failed batch waits for the next round) */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.pending || this.queue.length) {
      if (!this.pending) {
        const rows: OpsRow[] = [];
        for (const line of this.queue.splice(0, this.batchSize)) {
          try {
            const row = parseLogLine(line, this.systemOf);
            if (row) rows.push(row);
          } catch {
            // A line that cannot be read is skipped, never fatal
          }
        }
        if (!rows.length) continue;
        this.pending = { rows, tries: 0 };
      }
      const batch = this.pending;
      try {
        await this.insert(batch.rows);
        this.pending = null;
      } catch (err) {
        batch.tries += 1;
        if (batch.tries >= TRIES) {
          this.droppedLines += batch.rows.length;
          this.pending = null;
        }
        this.complain("could not write to ops_log", err);
        return;
      }
    }
  }

  private async insert(rows: OpsRow[]): Promise<void> {
    const values = [
      rows.map((r) => r.at.toISOString()),
      rows.map((r) => r.system),
      rows.map((r) => r.level),
      rows.map((r) => r.logger),
      rows.map((r) => r.message),
      rows.map((r) => r.slug),
      rows.map((r) => r.itemId),
      rows.map((r) => (r.fields ? JSON.stringify(r.fields) : null)),
    ];
    if (this.opts.query) {
      await this.opts.query(INSERT_SQL, values);
      return;
    }
    const client = await this.getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [INSERT_LOCK]);
      await client.query(INSERT_SQL, values);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async beat(): Promise<void> {
    const hb = this.heartbeat;
    if (this.closed || !hb) return;
    const version = process.env.RENDER_GIT_COMMIT?.slice(0, 12) || process.env.npm_package_version || null;
    const values = [hb.process, hb.system, hostname(), process.pid, this.startedAt.toISOString(), JSON.stringify({ version, ...hb.info })];
    try {
      await (this.opts.query ? this.opts.query(HEARTBEAT_SQL, values) : this.getPool().query(HEARTBEAT_SQL, values));
    } catch (err) {
      this.complain("could not record the ops heartbeat", err);
    }
  }

  private getPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({
        connectionString: this.opts.databaseUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 10_000,
        keepAlive: true,
        application_name: "socia-ops-log",
      });
      // A dropped idle connection must not crash the app; the next batch opens a new one
      this.pool.on("error", (err) => this.complain("ops_log connection lost", err));
    }
    return this.pool;
  }

  /** Never through pino (that would feed the failure back into this queue): stderr, at most once a minute */
  private complain(what: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastComplaint < COMPLAIN_EVERY_MS) return;
    this.lastComplaint = now;
    try {
      const reason = redactText(String((err as Error)?.message ?? err)).slice(0, 300);
      process.stderr.write(`ops-log: ${what}: ${reason} (queued ${this.queued}, dropped ${this.droppedLines}; next note in a minute at the earliest)\n`);
    } catch {
      // stderr gone: nothing more to do
    }
  }

  /** Shutdown: stop the timers, write what is queued (best effort, at most `waitMs`), close the pool */
  async close(waitMs = 3000): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref());
    await Promise.race([this.flush().catch(() => {}), timeout]);
    this.closed = true;
    await this.pool?.end().catch(() => {});
  }
}

// ─── Reads and retention ───────────────────────────────────────────────────

export interface OpsLogEntry {
  id: string;
  at: string;
  system: string;
  level: string;
  logger: string | null;
  message: string;
  slug: string | null;
  itemId: string | null;
  fields: Record<string, unknown> | null;
}

export interface OpsHeartbeatEntry {
  process: string;
  system: string;
  host: string;
  pid: number;
  startedAt: string;
  beatAt: string;
  info: Record<string, unknown> | null;
}

const iso = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * Lines with id > after, ascending, at most `limit`. after null (or 0): the newest `limit` lines, still ascending,
 * so a first pull does not start with 14 days of history.
 */
export async function readOpsLog(db: Executor, after: bigint | null, limit: number): Promise<OpsLogEntry[]> {
  const cols = sql`t.id::text AS id, ${iso("t.at")} AS at, t.system, t.level, t.logger, t.message, t.slug, t.item_id, t.fields`;
  const q = after
    ? sql`SELECT ${cols} FROM ops_log t WHERE t.id > ${after.toString()}::bigint ORDER BY t.id LIMIT ${limit}`
    : sql`SELECT ${cols} FROM (SELECT * FROM ops_log ORDER BY id DESC LIMIT ${limit}) t ORDER BY t.id`;
  const { rows } = await db.execute(q);
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    at: String(r.at),
    system: String(r.system),
    level: String(r.level),
    logger: (r.logger as string | null) ?? null,
    message: String(r.message),
    slug: (r.slug as string | null) ?? null,
    itemId: (r.item_id as string | null) ?? null,
    fields: (r.fields as Record<string, unknown> | null) ?? null,
  }));
}

export async function readOpsHeartbeats(db: Executor): Promise<OpsHeartbeatEntry[]> {
  const { rows } = await db.execute(
    sql`SELECT process, system, host, pid, ${iso("started_at")} AS started_at, ${iso("beat_at")} AS beat_at, info FROM ops_heartbeat ORDER BY process`,
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    process: String(r.process),
    system: String(r.system),
    host: String(r.host),
    pid: Number(r.pid),
    startedAt: String(r.started_at),
    beatAt: String(r.beat_at),
    info: (r.info as Record<string, unknown> | null) ?? null,
  }));
}

export const OPS_LOG_KEEP_DAYS = 14;
export const OPS_HEARTBEAT_KEEP_DAYS = 7;

/** Retention (contract §1): log lines older than 14 days, heartbeats not beaten for 7 days */
export async function pruneOps(db: Executor): Promise<{ lines: number; heartbeats: number }> {
  const lines = await db.execute(sql`DELETE FROM ops_log WHERE at < now() - make_interval(days => ${OPS_LOG_KEEP_DAYS})`);
  const beats = await db.execute(sql`DELETE FROM ops_heartbeat WHERE beat_at < now() - make_interval(days => ${OPS_HEARTBEAT_KEEP_DAYS})`);
  return { lines: lines.rowCount ?? 0, heartbeats: beats.rowCount ?? 0 };
}
