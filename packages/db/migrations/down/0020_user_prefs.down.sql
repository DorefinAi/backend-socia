-- Rollback of 0020_user_prefs. Not run by the migrator (it only reads meta/_journal.json); run it by hand, with the
-- pre-0020 API code deployed (the new code reads users.prefs on every request), e.g.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE only for users.prefs: every user's saved keyboard shortcuts (they fall back to the desk's defaults).
-- Refuses (raises, nothing changed) unless 0020 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794258175817 THEN
    RAISE EXCEPTION '0020_user_prefs is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "users" DROP COLUMN IF EXISTS "prefs";
-- So the migrator applies 0020 again on the next deploy ("when" of 0020 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794258175817;
COMMIT;
