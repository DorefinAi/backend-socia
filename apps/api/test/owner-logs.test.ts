// GET /owner/logs (dev-docs/ops-logs-contract.md §2): param parsing, auth reuse and the answer's shape against a
// stub database (always runs); the same route on a real Postgres when TEST_DATABASE_URL is set (wiped). Also checks
// the logger wiring: stdout unchanged next to the ops-log stream.

import { Writable } from "node:stream";
import { OpsLog, runMigrations, createDb, type Db, type DbHandle } from "@socia/db";
import type { Storage } from "@socia/providers";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { ApiConfig } from "../src/config";
import { parseLogsAfter } from "../src/routes/owner";

const KEY = "k".repeat(40);
const URL = process.env.TEST_DATABASE_URL;
const config: ApiConfig = {
  databaseUrl: URL ?? "", port: 0, corsOrigins: [], cookieSecure: false, sessionHours: 12, requireTotp: false,
  secretKey: Buffer.alloc(32, 9).toString("base64"), storageDir: null, rewriteMode: "rules", trustProxy: false, ownerApiKey: KEY,
};
const headers = { authorization: `Bearer ${KEY}`, "x-owner-actor": "sentry-sync" };

describe("parseLogsAfter", () => {
  it("missing or 0 → newest; a non-negative integer → bigint", () => {
    expect(parseLogsAfter(undefined)).toBeNull();
    expect(parseLogsAfter("0")).toBeNull();
    expect(parseLogsAfter("000")).toBeNull();
    expect(parseLogsAfter("42")).toBe(42n);
    expect(parseLogsAfter("9223372036854775807")).toBe(9223372036854775807n);
  });

  it.each(["", "-1", "1.5", "abc", "1e3", " 1", "0x10", "9223372036854775808", "12345678901234567890"])("refuses %j", (v) => {
    expect(() => parseLogsAfter(v)).toThrowError(expect.objectContaining({ status: 400, code: "invalid" }));
  });
});

describe("GET /owner/logs (stub database)", () => {
  const dialect = new PgDialect();
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = {
    execute: async (q: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(q);
      seen.push({ sql: text, params });
      if (text.includes("ops_heartbeat")) {
        return { rows: [{ process: "api", system: "socia-api", host: "h", pid: 7, started_at: "2026-11-06T10:00:00.000Z", beat_at: "2026-11-06T10:05:00.000Z", info: { version: null } }] };
      }
      return {
        rows: [
          { id: "9007199254740993", at: "2026-11-06T10:00:01.000Z", system: "socia-api", level: "info", logger: null, message: "a", slug: null, item_id: null, fields: null },
          { id: "9007199254740994", at: "2026-11-06T10:00:02.000Z", system: "socia-render", level: "error", logger: "render-0", message: "b", slug: "s", item_id: "x", fields: { n: 1 } },
        ],
      };
    },
  } as unknown as Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    app = await buildApp({ db, storage: {} as Storage, config, opsLog: { dropped: 3 } }, false);
  });
  afterAll(async () => app?.close());
  const get = (url: string, h: Record<string, string> = headers) => app.inject({ method: "GET", url, headers: h });

  it("uses the owner key and actor checks", async () => {
    expect((await get("/owner/logs", {})).statusCode).toBe(401);
    expect((await get("/owner/logs", { authorization: `Bearer ${KEY}` })).json()).toMatchObject({ error: "invalid_actor" });
  });

  it.each(["after=-1", "after=abc", "after=", "after=1.5", "after=99999999999999999999", "limit=0", "limit=1001", "limit=abc", "after=1&after=2", "other=1"])(
    "400 invalid for ?%s",
    async (qs) => {
      const res = await get(`/owner/logs?${qs}`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid" });
    },
  );

  it("first call: the newest `limit` lines, ascending; ids as strings; heartbeats and this process's drops", async () => {
    seen.length = 0;
    const res = await get("/owner/logs");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      system: "socia",
      entries: [
        { id: "9007199254740993", at: "2026-11-06T10:00:01.000Z", system: "socia-api", level: "info", logger: null, message: "a", slug: null, itemId: null, fields: null },
        { id: "9007199254740994", at: "2026-11-06T10:00:02.000Z", system: "socia-render", level: "error", logger: "render-0", message: "b", slug: "s", itemId: "x", fields: { n: 1 } },
      ],
      next: "9007199254740994",
      heartbeats: [{ process: "api", system: "socia-api", host: "h", pid: 7, startedAt: "2026-11-06T10:00:00.000Z", beatAt: "2026-11-06T10:05:00.000Z", info: { version: null } }],
      dropped: 3,
    });
    const log = seen.find((q) => q.sql.includes("ops_log"))!;
    expect(log.sql).toContain("ORDER BY id DESC LIMIT");
    expect(log.params).toEqual([500]);
  });

  it("after=<id>: lines with a greater id, bigint-safe, at most limit", async () => {
    seen.length = 0;
    await get("/owner/logs?after=9007199254740993&limit=1000");
    const log = seen.find((q) => q.sql.includes("ops_log"))!;
    expect(log.sql).toContain("t.id > $1::bigint ORDER BY t.id LIMIT $2");
    expect(log.params).toEqual(["9007199254740993", 1000]);
    seen.length = 0;
    await get("/owner/logs?after=0&limit=1");
    expect(seen.find((q) => q.sql.includes("ops_log"))!.params).toEqual([1]);
  });
});

describe("logger wiring", () => {
  it("stdout gets every line as before; the ops stream only OPS_LOG_LEVEL and above", async () => {
    const out: string[] = [];
    const stdout = new Writable({ write: (c, _e, cb) => (out.push(String(c)), cb()) });
    const values: string[][][] = [];
    const sink = new OpsLog({ databaseUrl: "", system: "socia-api", flushMs: 60_000, query: async (_t, v) => void values.push(v as string[][]) });
    const log = pino({ level: "info" }, pino.multistream([{ level: "info", stream: stdout }, { level: "warn", stream: sink.stream }]));
    log.debug("d");
    log.info("i");
    log.warn({ reqId: "r1" }, "w");
    log.error({ err: new Error("boom") }, "e");
    expect(out.map((l) => JSON.parse(l).msg)).toEqual(["i", "w", "e"]);
    await sink.close();
    expect(values[0]![2]).toEqual(["warn", "error"]);
    expect(values[0]![4]![1]).toMatch(/^e: boom\nat /);
    expect(values[0]![7]![0]).toBe(JSON.stringify({ reqId: "r1" }));
  });
});

(URL ? describe : describe.skip)("GET /owner/logs (Postgres)", () => {
  let h: DbHandle;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    h = createDb(URL!, 3);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
    app = await buildApp({ db: h.db, storage: {} as Storage, config }, false);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  it("pages through the lines with next", async () => {
    await h.db.execute(sql`INSERT INTO ops_log (system, level, message) SELECT 'socia-api', 'info', 'm' || g FROM generate_series(1, 5) g`);
    const first = (await app.inject({ method: "GET", url: "/owner/logs?limit=2", headers })).json();
    expect(first.entries.map((e: { message: string }) => e.message)).toEqual(["m4", "m5"]);
    expect(first.dropped).toBe(0);
    await h.db.execute(sql`INSERT INTO ops_log (system, level, message) VALUES ('socia-api', 'warn', 'm6')`);
    const next = (await app.inject({ method: "GET", url: `/owner/logs?after=${first.next}`, headers })).json();
    expect(next.entries.map((e: { message: string }) => e.message)).toEqual(["m6"]);
    const empty = (await app.inject({ method: "GET", url: `/owner/logs?after=${next.next}`, headers })).json();
    expect(empty).toMatchObject({ entries: [], next: null, heartbeats: [] });
  });
});
