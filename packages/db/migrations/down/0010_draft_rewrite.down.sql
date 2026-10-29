-- Rollback of 0010_draft_rewrite. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0010 API deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE: the rewrite note (similarity, sources) of every Web Scraper draft is dropped; drafts stay.
BEGIN;
ALTER TABLE "post_drafts" DROP COLUMN IF EXISTS "rewrite";
-- So the migrator applies 0010 again on the next deploy ("when" of 0010 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793294825236;
COMMIT;
