-- Rollback of 0032_ops_status_indexes. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>. Drops only the six indexes; no data is lost.
-- Refuses (raises, nothing changed) unless 0032 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1795194987633 THEN
    RAISE EXCEPTION '0032_ops_status_indexes is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP INDEX IF EXISTS "post_drafts_created_idx";
DROP INDEX IF EXISTS "post_drafts_moving_idx";
DROP INDEX IF EXISTS "post_drafts_card_due_idx";
DROP INDEX IF EXISTS "published_posts_recalled_idx";
DROP INDEX IF EXISTS "stories_created_idx";
DROP INDEX IF EXISTS "stories_received_idx";
-- So the migrator applies 0032 again on the next deploy ("when" of 0032 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1795194987633;
COMMIT;
