// Builds every missing or stale story_search row in one go (the worker's search sweep does the same 500 at a time:
// recently edited stories every 10 s, every story on start and hourly). Waits while the worker is sweeping.
// Safe to run at any time, alongside the worker: rows are upserted and derived from stories.
//   pnpm local:search-backfill                       (root, reads backend/.env)
//   DATABASE_URL=... pnpm --filter @socia/db search:backfill

import { backfillStorySearch } from "../src/search";
import { createDb } from "../src/client";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const { db, close } = createDb(url, 1, { statementTimeoutMs: 0 });
const started = Date.now();
try {
  const total = await backfillStorySearch(
    db,
    (n, sum) => console.log(`story_search: +${n} (${sum})`),
    { warn: (obj, msg) => console.warn(msg, obj) },
  );
  console.log(`story_search: ${total} rows written in ${((Date.now() - started) / 1000).toFixed(1)} s; every story is indexed.`);
} finally {
  await close();
}
