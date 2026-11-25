// Applies only the X Videos migrations (schema xvideos) to DATABASE_URL:
//   pnpm --filter @socia/xvideos migrate      (reads apps/xvideos/.env)
// Refuses the live database "socia" (checked on the server) unless XVIDEOS_MIGRATE_LIVE=yes.
import { runXvMigrations } from "../src/db/migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
try {
  const name = await runXvMigrations(url, { allowLive: process.env.XVIDEOS_MIGRATE_LIVE === "yes" });
  console.log(`X Videos migrations applied to ${name}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
