-- Rollback of 0023_story_district_from. Not run by the migrator (it only reads meta/_journal.json); run it by
-- hand, with the pre-0023 API and worker code deployed (the new code writes stories.district_from on every
-- breaking convert and reads it on compose), e.g.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE only for stories.district_from: whether each breaking story's district was written by the desk
-- or inferred. stories.district itself is untouched. NOTE: the pre-0023 composer puts an inferred district
-- on the post again (line 1 and the district police), which is what this migration's code change stopped.
-- Refuses (raises, nothing changed) unless 0023 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794492058216 THEN
    RAISE EXCEPTION '0023_story_district_from is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "stories" DROP COLUMN IF EXISTS "district_from";
-- So the migrator applies 0023 again on the next deploy ("when" of 0023 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794492058216;
COMMIT;
