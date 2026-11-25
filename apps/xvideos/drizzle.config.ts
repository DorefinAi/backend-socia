// X Videos migrations: only the "xvideos" schema, into their own folder (pnpm --filter @socia/xvideos generate)
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  schemaFilter: ["xvideos"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
