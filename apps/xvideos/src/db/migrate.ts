import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@socia/db";

/** X Videos migrations: their own folder and journal (xvideos.__migrations), apart from the X post desk's */
export const XV_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** The live database's name: X Videos is built on a copy (socia_xvideos) and only moved here on purpose */
export const XV_LIVE_DB = "socia";

/**
 * Applies the X Videos migrations. Asks the server which database it is connected to (not the URL, which may leave
 * the name to PGDATABASE) and refuses the live one unless `allowLive`. A lock wait is capped, so the migration can
 * never queue the live app's queries behind it (its foreign key locks public.orgs briefly).
 */
export async function runXvMigrations(url: string, opts: { allowLive?: boolean } = {}): Promise<string> {
  const { db, close } = createDb(url, 1, { statementTimeoutMs: 0 });
  try {
    const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
    const name = rows.rows[0]?.name ?? "";
    if (name === XV_LIVE_DB && !opts.allowLive) {
      throw new Error(`This is the live database "${XV_LIVE_DB}". X Videos migrations go to the test copy first (allowLive when moving over).`);
    }
    // One connection (pool of 1), so this applies to the migration below
    await db.execute(sql`set lock_timeout = '5s'`);
    await migrate(db, { migrationsFolder: XV_MIGRATIONS_DIR, migrationsSchema: "xvideos", migrationsTable: "__migrations" });
    return name;
  } finally {
    await close();
  }
}
