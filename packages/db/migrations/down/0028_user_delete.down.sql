-- Rollback of 0028_user_delete. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0028 API code deployed (the new API reads and writes users.deleted_at),
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE for the delete mark only: every deleted user comes back as an inactive user (active stays false, so
-- they still cannot sign in) and shows up in the user lists again; an admin can then re-enable or leave them off.
-- Refuses (raises, nothing changed) unless 0028 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794650000000 THEN
    RAISE EXCEPTION '0028_user_delete is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "users" DROP COLUMN IF EXISTS "deleted_at";
-- So the migrator applies 0028 again on the next deploy ("when" of 0028 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794650000000;
COMMIT;
