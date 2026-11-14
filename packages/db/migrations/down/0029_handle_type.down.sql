-- Rollback of 0029_handle_type. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0029 API and worker code deployed (the new code reads and writes handle_directory.entity_type),
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE for the types only: every Settings handle's type is dropped (the rows, names and keywords stay).
-- Refuses (raises, nothing changed) unless 0029 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794661607219 THEN
    RAISE EXCEPTION '0029_handle_type is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "handle_directory" DROP CONSTRAINT IF EXISTS "handle_directory_entity_type_check";
ALTER TABLE "handle_directory" DROP COLUMN IF EXISTS "entity_type";
-- So the migrator applies 0029 again on the next deploy ("when" of 0029 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794661607219;
COMMIT;
