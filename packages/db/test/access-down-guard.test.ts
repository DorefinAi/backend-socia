// The hand-run rollback of 0009 refuses unless 0009 is the newest applied migration, and signs out the users it
// moves to viewer. Needs TEST_DATABASE_URL (the database is wiped).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { MIGRATIONS_DIR, runMigrations } from "../src/migrate";
import { orgs, roles, sessions, users } from "../src/schema";
import { TEST_URL, freshDb } from "./helpers";

const settings = { hashtagScript: "latin" as const, fixedHashtags: [], maxHashtags: 4, dailyCaps: { x: 800 }, headlineWords: 9 };
const down = (tag: string) => readFile(join(MIGRATIONS_DIR, "down", `${tag}.down.sql`), "utf8");

(TEST_URL ? describe : describe.skip)("0009 rollback guard", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  }, 60_000);
  afterAll(async () => h?.close());

  /** Runs a down script on its own connection, as psql would; on failure the open transaction is rolled back */
  async function runDown(text: string) {
    const client = await h.pool.connect();
    try {
      await client.query(text);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  it("refuses while a newer migration is applied, changing nothing", async () => {
    const [org] = await h.db.insert(orgs).values({ name: "A", settings }).returning();
    await h.db.insert(roles).values({ orgId: org!.id, key: "video-desk", label: "Video Desk" });
    const [v] = await h.db.insert(users).values({ orgId: org!.id, name: "V", email: "v@test", passwordHash: "x", role: "video-desk" }).returning();
    const [e] = await h.db.insert(users).values({ orgId: org!.id, name: "E", email: "e@test", passwordHash: "x", role: "editor" }).returning();
    const expiresAt = new Date(Date.now() + 3600_000);
    await h.db.insert(sessions).values([
      { userId: v!.id, tokenHash: "v-token", csrfToken: "c", verified: true, expiresAt },
      { userId: e!.id, tokenHash: "e-token", csrfToken: "c", verified: true, expiresAt },
    ]);
    // Whatever the journal holds now, a row newer than 0009 is applied
    await h.db.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('later', 9999999999999)`);

    await expect(runDown(await down("0009_access_control"))).rejects.toThrow(/not the newest applied migration/);
    expect((await h.db.execute(sql`SELECT to_regclass('public.roles') AS t`)).rows).toEqual([{ t: "roles" }]);
    expect((await h.db.select().from(users).where(eq(users.id, v!.id)))[0]!.role).toBe("video-desk");
    expect(await h.db.select().from(sessions)).toHaveLength(2);
    await h.db.execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 9999999999999`);
  });

  it("runs once the newer ones are rolled back, and signs out the users it moves to viewer", async () => {
    // Roll back every migration after 0009, newest first, with its own down script
    const journal = JSON.parse(await readFile(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const at = journal.entries.findIndex((x) => x.tag === "0009_access_control");
    for (const later of journal.entries.slice(at + 1).reverse()) await runDown(await down(later.tag));

    await runDown(await down("0009_access_control"));
    const left = (await h.db.execute(sql`SELECT u.email, u.role, count(s.id)::int AS sessions FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.email, u.role ORDER BY u.email`)).rows;
    expect(left).toEqual([{ email: "e@test", role: "editor", sessions: 1 }, { email: "v@test", role: "viewer", sessions: 0 }]);

    // And forward again
    await runMigrations(TEST_URL!);
    expect((await h.db.select().from(roles)).map((r) => r.key).sort()).toEqual(["admin", "editor", "operator", "viewer"]);
  });
});
