-- Rollback of 0011_totp_last_step. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0011 API deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- Not destructive beyond the guard itself: the last accepted TOTP step of every user is dropped, so a code
-- already used once could be used again within its 90 s window after the rollback.
-- Refuses (raises, nothing changed) unless 0011 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793296973217 THEN
    RAISE EXCEPTION '0011_totp_last_step is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "users" DROP COLUMN IF EXISTS "totp_last_step";
-- So the migrator applies 0011 again on the next deploy ("when" of 0011 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793296973217;
COMMIT;
