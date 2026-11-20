-- Rollback of 0031_login_event. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0031 API code deployed (the new login handlers write to login_event; a failed write never fails a
-- sign-in, but it is logged on every attempt), e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE for the sign-in history only: every recorded attempt is dropped.
-- Refuses (raises, nothing changed) unless 0031 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1795155114261 THEN
    RAISE EXCEPTION '0031_login_event is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP TABLE IF EXISTS "login_event";
-- So the migrator applies 0031 again on the next deploy ("when" of 0031 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1795155114261;
COMMIT;
