// Migration 0009 (access control): built-in roles seeded per org, and its hand-run rollback round-trips.
// Needs TEST_DATABASE_URL (the database is wiped).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrate";
import { orgs, roles, users } from "../src/schema";
import { TEST_URL, freshDb } from "./helpers";

const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };

(TEST_URL ? describe : describe.skip)("migration 0009", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  }, 60_000);
  afterAll(async () => h?.close());

  const rows = async (q: ReturnType<typeof sql>) => (await h.db.execute(q)).rows as Record<string, unknown>[];

  it("seeds the built-ins for a new org and refuses unknown roles", async () => {
    const [org] = await h.db.insert(orgs).values({ name: "A", settings }).returning();
    expect((await h.db.select().from(roles)).map((r) => r.key).sort()).toEqual(["admin", "editor", "operator", "viewer"]);
    await expect(h.db.insert(users).values({ orgId: org!.id, name: "X", email: "x@test", passwordHash: "x", role: "ghost" })).rejects.toThrow();
  });

  it("rolls back to the 4 fixed roles and migrates forward again", async () => {
    const [org] = await h.db.select().from(orgs);
    await h.db.insert(roles).values({ orgId: org!.id, key: "video-desk", label: "Video Desk" });
    await h.db.insert(users).values([
      { orgId: org!.id, name: "V", email: "v@test", passwordHash: "x", role: "video-desk" },
      { orgId: org!.id, name: "E", email: "e@test", passwordHash: "x", role: "editor" },
    ]);
    // Rollbacks run newest first: the migrator only applies what is newer than the last one it recorded
    const journal = JSON.parse(await readFile(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    const at = journal.entries.findIndex((e) => e.tag === "0009_access_control");
    for (const later of journal.entries.slice(at + 1).reverse()) {
      await h.pool.query(await readFile(join(MIGRATIONS_DIR, "down", `${later.tag}.down.sql`), "utf8"));
    }
    expect(await rows(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'post_drafts' AND column_name = 'rewrite'`)).toEqual([]);
    await h.pool.query(await readFile(join(MIGRATIONS_DIR, "down", "0009_access_control.down.sql"), "utf8"));

    expect(await rows(sql`SELECT email, role FROM users ORDER BY email`)).toEqual([{ email: "e@test", role: "editor" }, { email: "v@test", role: "viewer" }]);
    expect(await rows(sql`SELECT to_regclass('public.roles') AS t`)).toEqual([{ t: null }]);
    expect(await rows(sql`SELECT conname FROM pg_constraint WHERE conname = 'users_role_check'`)).toHaveLength(1);
    await expect(h.db.execute(sql`UPDATE users SET role = 'video-desk'`)).rejects.toThrow();

    await runMigrations(TEST_URL!);
    expect((await h.db.select().from(roles)).map((r) => r.key).sort()).toEqual(["admin", "editor", "operator", "viewer"]);
    expect(await rows(sql`SELECT conname FROM pg_constraint WHERE conname IN ('users_role_check', 'users_org_role_fk')`)).toEqual([{ conname: "users_org_role_fk" }]);
    // 0010 came back too (post_drafts.rewrite, nullable jsonb)
    expect(await rows(sql`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'post_drafts' AND column_name = 'rewrite'`)).toEqual([
      { data_type: "jsonb", is_nullable: "YES" },
    ]);
  });
});
