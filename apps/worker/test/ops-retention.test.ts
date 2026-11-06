// Ops-log retention from the maintenance loop's housekeeping (dev-docs/ops-logs-contract.md §1): once an hour, lines
// older than 14 days and heartbeats older than 7. Needs TEST_DATABASE_URL (wiped).

import { createDb, runMigrations, type DbHandle } from "@socia/db";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPS_PRUNE_EVERY_MS, housekeeping } from "../src/stages/crons";

const URL = process.env.TEST_DATABASE_URL;

(URL ? describe : describe.skip)("ops retention", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = createDb(URL!, 3);
    await h.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`);
    await runMigrations(URL!);
  }, 60_000);
  afterAll(async () => h?.close());

  const oldLine = () => h.db.execute(sql`INSERT INTO ops_log (at, system, level, message) VALUES (now() - interval '15 days', 'socia-crons', 'info', 'old')`);
  const count = async () => ((await h.db.execute(sql`SELECT count(*)::int AS n FROM ops_log`)).rows[0] as { n: number }).n;

  it("prunes on the first run, then not again within the hour", async () => {
    const log = pino({ level: "silent" });
    const t0 = 10 * OPS_PRUNE_EVERY_MS;
    await oldLine();
    await h.db.execute(sql`INSERT INTO ops_log (system, level, message) VALUES ('socia-crons', 'info', 'new')`);
    await housekeeping(h.db, log, t0);
    expect(await count()).toBe(1);
    await oldLine();
    await housekeeping(h.db, log, t0 + OPS_PRUNE_EVERY_MS - 1);
    expect(await count()).toBe(2);
    await housekeeping(h.db, log, t0 + OPS_PRUNE_EVERY_MS);
    expect(await count()).toBe(1);
  });
});
