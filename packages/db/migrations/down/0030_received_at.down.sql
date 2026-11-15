-- Rollback of 0030_received_at. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0030 API and worker code deployed (the new code reads and writes stories.received_at),
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE for the times only: each story's time on the share is dropped (the queue goes back to created_at).
-- Refuses (raises, nothing changed) unless 0030 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794735850080 THEN
    RAISE EXCEPTION '0030_received_at is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP INDEX IF EXISTS "stories_org_received_idx";
ALTER TABLE "stories" DROP COLUMN IF EXISTS "received_at";
-- So the migrator applies 0030 again on the next deploy ("when" of 0030 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794735850080;
COMMIT;
