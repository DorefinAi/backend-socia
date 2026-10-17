import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client";

/** The migrations folder ships next to this package; the API runs this before every deploy. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(url: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const { db, close } = createDb(url, 1);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
