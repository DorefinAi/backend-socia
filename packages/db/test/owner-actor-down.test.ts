// Migrations 0013 (audit_log.actor) and 0014 (history index): their hand-run rollbacks keep which owner made each
// change (copied into "after" as ownerActor) and the migrator applies both again. Needs TEST_DATABASE_URL (wiped).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrate";
import { auditLog, orgs } from "../src/schema";
import { TEST_URL, freshDb } from "./helpers";

const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

(TEST_URL ? describe : describe.skip)("0013/0014 rollback", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  }, 60_000);
  afterAll(async () => h?.close());

  const rows = async (q: ReturnType<typeof sql>) => (await h.db.execute(q)).rows as Record<string, unknown>[];

  it("keeps owner actors in the audit JSON and migrates forward again", async () => {
    const [org] = await h.db.insert(orgs).values({ name: "A", settings }).returning();
    const base = { orgId: org!.id, actorId: null, entityType: "user", entityId: "u" };
    await h.db.insert(auditLog).values([
      { ...base, action: "a.object", actor: "owner:vansh", after: { role: "viewer" } },
      { ...base, action: "b.null", actor: "owner:aditya", after: null },
      { ...base, action: "c.array", actor: "owner:vansh", after: [1] },
      { ...base, action: "d.user", actor: null, after: { role: "admin" } },
    ]);
    const journal = JSON.parse(await readFile(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex((e) => e.tag === "0013_owner_actor");
    for (const later of journal.entries.slice(at).reverse()) {
      await h.pool.query(await readFile(join(MIGRATIONS_DIR, "down", `${later.tag}.down.sql`), "utf8"));
    }
    expect(await rows(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'actor'`)).toEqual([]);
    expect(await rows(sql`SELECT indexname FROM pg_indexes WHERE indexname = 'audit_log_type_at_idx'`)).toEqual([]);
    expect(await rows(sql`SELECT action, after FROM audit_log ORDER BY action`)).toEqual([
      { action: "a.object", after: { role: "viewer", ownerActor: "owner:vansh" } },
      { action: "b.null", after: { ownerActor: "owner:aditya" } },
      { action: "c.array", after: { value: [1], ownerActor: "owner:vansh" } },
      { action: "d.user", after: { role: "admin" } },
    ]);

    await runMigrations(TEST_URL!);
    expect(await rows(sql`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'audit_log' AND column_name = 'actor'`)).toEqual([
      { data_type: "text", is_nullable: "YES" },
    ]);
    expect(await rows(sql`SELECT indexname FROM pg_indexes WHERE indexname = 'audit_log_type_at_idx'`)).toHaveLength(1);
  });
});
