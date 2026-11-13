-- Rollback of 0026_composer_line2. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0026 API and worker deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- Drops only the composer's stored line 2; Fit then treats every draft's line 2 as the desk's own text.
-- Refuses (raises, nothing changed) unless 0026 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794580000000 THEN
    RAISE EXCEPTION '0026_composer_line2 is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "post_drafts" DROP COLUMN IF EXISTS "composer_line2";
-- So the migrator applies 0026 again on the next deploy ("when" of 0026 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794580000000;
COMMIT;
