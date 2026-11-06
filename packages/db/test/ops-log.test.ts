// Ops logs (dev-docs/ops-logs-contract.md): level mapping, redaction (§3), pino line → row, the bounded queue and
// its batching. The last block needs TEST_DATABASE_URL (wiped): inserts, the cursor reads, retention and the 0019
// rollback.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "../src/client";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrate";
import {
  MAX_FIELDS, OpsLog, opsLevelOf, opsLogSettings, parseLogLine, pruneOps, readOpsHeartbeats, readOpsLog, redactFields, redactText, workerSystemOf,
} from "../src/ops-log";
import { TEST_URL, freshDb } from "./helpers";

const api = () => "socia-api";

describe("level mapping", () => {
  it("maps pino's numbers to the contract's four levels", () => {
    expect([10, 20, 30, 40, 50, 60].map(opsLevelOf)).toEqual(["debug", "debug", "info", "warn", "error", "error"]);
    expect(["warning", "critical", "fatal", "trace", "INFO"].map(opsLevelOf)).toEqual(["warn", "error", "error", "debug", "info"]);
    expect(opsLevelOf(undefined)).toBe("info");
  });

  it("reads OPS_LOG_LEVEL / OPS_LOG_ENABLED with safe defaults", () => {
    expect(opsLogSettings({})).toEqual({ enabled: true, level: "info" });
    expect(opsLogSettings({ OPS_LOG_LEVEL: "warning", OPS_LOG_ENABLED: "true" })).toEqual({ enabled: true, level: "warn" });
    expect(opsLogSettings({ OPS_LOG_LEVEL: "debug" }).level).toBe("debug");
    expect(opsLogSettings({ OPS_LOG_LEVEL: "loud" }).level).toBe("info");
    expect(opsLogSettings({ OPS_LOG_ENABLED: "false" }).enabled).toBe(false);
    expect(opsLogSettings({ OPS_LOG_ENABLED: " OFF " }).enabled).toBe(false);
  });
});

describe("redaction (§3)", () => {
  it.each([
    ["Authorization: Bearer abc.def-123", "Bearer abc.def-123"],
    ["password=hunter2 next", "hunter2"],
    ['{"api_key": "sk-123456", "ok": 1}', "sk-123456"],
    ["sessionId: 9f8e7d left", "9f8e7d"],
    ["otp=123456", "123456"],
    ["X-Signature='a1b2c3'", "a1b2c3"],
    ["GET /cb?code=1&access_token=tok123&state=x", "tok123"],
    ["https://u.s3/x.png?X-Amz-Signature=deadbeef&X-Amz-Date=1", "deadbeef"],
    ["postgres://socia:s3cretpw@db.example.com:5432/socia", "s3cretpw"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3"],
  ])("removes the secret from %s", (input, secret) => {
    const out = redactText(input);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("masks emails and phone numbers, keeping a hint", () => {
    expect(redactText("mail priya.sharma@firstindia.co.in now")).toBe("mail p***@firstindia.co.in now");
    expect(redactText("call +919876541234")).toBe("call +91******1234");
    expect(redactText("call 9876541234.")).toBe("call ******1234.");
  });

  it("leaves ordinary text alone", () => {
    const text =
      "render-0 finished draft 3f2b9c1e-1234-4c3d-9a7b-123456789012 in 1532 ms on socia-render.onrender.com; post 1853012345678901234; file a.b.c.png";
    expect(redactText(text)).toBe(text);
  });

  it("is idempotent", () => {
    const input = "token=abc password: \"x\" Authorization: Bearer q a@b.co +919876541234 https://u:p@h/x?api_key=1";
    const once = redactText(input);
    expect(redactText(once)).toBe(once);
  });

  it("redacts fields by key and by value, flattens one level, keeps at most 20", () => {
    const fields = redactFields({
      token: "abc",
      cookieJar: { a: 1 },
      user: "priya@x.com",
      req: { method: "GET", url: "/a?secret=1", headers: { authorization: "Bearer x" } },
      tags: ["#Jaipur", "#Metro"],
      deep: [{ a: 1 }],
      big: 10n,
      n: Number.NaN,
    });
    expect(fields).toEqual({
      token: "[redacted]",
      cookieJar: "[redacted]",
      user: "p***@x.com",
      "req.method": "GET",
      "req.url": "/a?secret=[redacted]",
      tags: '["#Jaipur","#Metro"]',
      big: "10",
      n: "NaN",
    });
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(redactFields(many)!)).toHaveLength(MAX_FIELDS);
    expect(redactFields({})).toBeNull();
  });
});

describe("pino line → row", () => {
  const line = (rec: Record<string, unknown>) => JSON.stringify({ level: 30, time: 1793963787563, pid: 1, hostname: "h", service: "socia-worker", ...rec });

  it("takes msg, slug, item id, logger and the error; drops pino's own keys", () => {
    const err = { type: "Error", message: "connect ECONNREFUSED 10.0.0.1:5432", stack: "Error: connect ECONNREFUSED\n    at a (x.js:1:1)\n    at b (y.js:2:2)" };
    const row = parseLogLine(line({ level: 50, msg: "loop tick failed", loop: "render-0", stage: "render", slug: "jaipur-metro", storyId: "s-1", err, attempt: 2 }), workerSystemOf)!;
    expect(row).toEqual({
      at: new Date(1793963787563),
      system: "socia-render",
      level: "error",
      logger: "render-0",
      message: "loop tick failed: connect ECONNREFUSED 10.0.0.1:5432\nat a (x.js:1:1)\nat b (y.js:2:2)",
      slug: "jaipur-metro",
      itemId: "s-1",
      fields: { storyId: "s-1", attempt: 2 },
    });
  });

  it("prefers itemId / item_id, files stage-less worker lines under ingest, clips and redacts the message", () => {
    expect(parseLogLine(line({ msg: "x", item_id: 42, storyId: "s" }), workerSystemOf)).toMatchObject({ itemId: "42", system: "socia-ingest", fields: { storyId: "s" } });
    expect(parseLogLine(line({ msg: "x", stage: "crons" }), workerSystemOf)!.system).toBe("socia-crons");
    expect(parseLogLine(line({ msg: "x", stage: "publish" }), workerSystemOf)!.system).toBe("socia-publish");
    expect(parseLogLine(line({ msg: "x", stage: "nope" }), workerSystemOf)!.system).toBe("socia-ingest");
    const long = parseLogLine(line({ msg: `password=hunter2 ${"y".repeat(5000)}` }), api)!;
    expect(long.message).toHaveLength(2000);
    expect(long.message).not.toContain("hunter2");
    expect(long.fields).toBeNull();
  });

  it("an error with no msg becomes the message; a string err too", () => {
    expect(parseLogLine(line({ err: { message: "boom" } }), api)!.message).toBe("boom");
    expect(parseLogLine(line({ msg: "unhandled", err: "nope" }), api)!.message).toBe("unhandled: nope");
  });

  it("is null for anything that is not a JSON object", () => {
    expect(parseLogLine("not json", api)).toBeNull();
    expect(parseLogLine("[1,2]", api)).toBeNull();
  });
});

describe("the sink", () => {
  afterEach(() => vi.restoreAllMocks());

  const capture = () => {
    const calls: { text: string; values: unknown[][] }[] = [];
    const query = vi.fn(async (text: string, values: unknown[]) => {
      calls.push({ text, values: values as unknown[][] });
    });
    return { calls, query };
  };
  const opts = { databaseUrl: "", system: "socia-api", flushMs: 60_000, heartbeatMs: 60_000 };

  it("queues raw lines and inserts them in batches, skipping unreadable ones", async () => {
    const { calls, query } = capture();
    const sink = new OpsLog({ ...opts, query, batchSize: 2 });
    sink.stream.write(`${JSON.stringify({ level: 40, msg: "w", slug: "s" })}\n`);
    sink.stream.write("garbage\n");
    sink.stream.write(JSON.stringify({ level: 50, msg: "e" }));
    sink.stream.write(JSON.stringify({ level: 60, msg: "f" }));
    expect(sink.queued).toBe(4);
    await sink.flush();
    expect(calls.map((c) => c.values[1]!.length)).toEqual([1, 2]);
    expect(calls.flatMap((c) => c.values[2])).toEqual(["warn", "error", "error"]);
    expect(calls.flatMap((c) => c.values[4])).toEqual(["w", "e", "f"]);
    expect(calls[0]!.values[5]).toEqual(["s"]);
    expect(sink.queued).toBe(0);
    await sink.close();
  });

  it("drops the oldest line when the queue is full, and counts it", async () => {
    const { calls, query } = capture();
    const sink = new OpsLog({ ...opts, query, maxQueue: 3 });
    for (let i = 0; i < 5; i++) sink.stream.write(JSON.stringify({ level: 30, msg: `m${i}` }));
    expect(sink.dropped).toBe(2);
    await sink.flush();
    expect(calls[0]!.values[4]).toEqual(["m2", "m3", "m4"]);
    await sink.close();
  });

  it("retries a refused batch twice, then drops and counts it; complains on stderr at most once a minute", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const query = vi.fn(async () => {
      throw new Error("connection refused for postgres://u:pw@h/db");
    });
    const sink = new OpsLog({ ...opts, query });
    sink.stream.write(JSON.stringify({ level: 30, msg: "a" }));
    await sink.flush();
    await sink.flush();
    expect(sink.dropped).toBe(0);
    expect(sink.queued).toBe(1);
    await sink.flush();
    expect(sink.dropped).toBe(1);
    expect(sink.queued).toBe(0);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]![0])).not.toContain("pw@");
    await sink.close();
  });

  it("stores nothing when disabled, but the heartbeat still beats", async () => {
    const { calls, query } = capture();
    const sink = new OpsLog({ ...opts, query, enabled: false });
    sink.stream.write(JSON.stringify({ level: 50, msg: "x" }));
    expect(sink.queued).toBe(0);
    sink.startHeartbeat({ process: "api", system: "socia-api", info: { phase: 1 } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.text).toContain("ops_heartbeat");
    const [proc, system, host, pid, startedAt, info] = calls[0]!.values as unknown as [string, string, string, number, string, string];
    expect([proc, system, pid]).toEqual(["api", "socia-api", process.pid]);
    expect(host).toBeTruthy();
    expect(Date.parse(startedAt)).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(info)).toMatchObject({ phase: 1 });
    await sink.close();
  });
});

(TEST_URL ? describe : describe.skip)("ops_log on Postgres", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  }, 60_000);
  afterAll(async () => h?.close());

  it("inserts batches, reads after a cursor or the newest lines, and keeps heartbeats", async () => {
    const sink = new OpsLog({ databaseUrl: TEST_URL!, system: "socia-ingest", systemOf: workerSystemOf, flushMs: 60_000 });
    sink.startHeartbeat({ process: "worker:render", system: "socia-render", info: { roles: ["render"] } });
    for (let i = 1; i <= 7; i++) {
      sink.stream.write(JSON.stringify({ level: 30, time: Date.UTC(2026, 10, 6, 10, 0, i), msg: `line ${i}`, stage: "render", fields: "x", n: i, quote: 'a"b\\c' }));
    }
    await sink.flush();
    await sink.close();

    const newest = await readOpsLog(h.db, null, 3);
    expect(newest.map((e) => e.message)).toEqual(["line 5", "line 6", "line 7"]);
    expect(newest[0]).toMatchObject({ at: "2026-11-06T10:00:05.000Z", system: "socia-render", level: "info", logger: null, fields: { fields: "x", n: 5, quote: 'a"b\\c' } });
    expect(typeof newest[0]!.id).toBe("string");
    // line 5's id − 4 = line 1's id: the two lines after it
    const after = await readOpsLog(h.db, BigInt(newest[0]!.id) - 4n, 2);
    expect(after.map((e) => e.message)).toEqual(["line 2", "line 3"]);
    expect(await readOpsLog(h.db, BigInt(newest[2]!.id), 10)).toEqual([]);

    const [beat] = await readOpsHeartbeats(h.db);
    expect(beat).toMatchObject({ process: "worker:render", system: "socia-render", pid: process.pid, info: { roles: ["render"] } });
    expect(Date.parse(beat!.beatAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("prunes lines after 14 days and heartbeats after 7", async () => {
    await h.db.execute(sql`INSERT INTO ops_log (at, system, level, message) VALUES (now() - interval '15 days', 'socia-api', 'info', 'old'), (now() - interval '13 days', 'socia-api', 'info', 'kept')`);
    await h.db.execute(sql`INSERT INTO ops_heartbeat (process, system, host, pid, started_at, beat_at) VALUES ('gone', 'socia-api', 'h', 1, now() - interval '9 days', now() - interval '8 days')`);
    expect(await pruneOps(h.db)).toEqual({ lines: 1, heartbeats: 1 });
    expect((await h.db.execute(sql`SELECT count(*)::int AS n FROM ops_log WHERE message = 'kept'`)).rows).toEqual([{ n: 1 }]);
  });

  it("0019 rolls back and migrates forward again", async () => {
    await h.pool.query(await readFile(join(MIGRATIONS_DIR, "down", "0019_ops_log.down.sql"), "utf8"));
    expect((await h.db.execute(sql`SELECT to_regclass('ops_log') AS t, to_regclass('ops_heartbeat') AS b`)).rows).toEqual([{ t: null, b: null }]);
    await runMigrations(TEST_URL!);
    expect((await h.db.execute(sql`SELECT to_regclass('ops_log')::text AS t`)).rows).toEqual([{ t: "ops_log" }]);
  });
});
