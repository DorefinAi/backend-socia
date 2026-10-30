-- Rollback of 0014_audit_type_at_idx. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>. Not destructive: drops an index only.
-- Refuses (raises, nothing changed) unless 0014 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793328483290 THEN
    RAISE EXCEPTION '0014_audit_type_at_idx is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP INDEX IF EXISTS "audit_log_type_at_idx";
-- So the migrator applies 0014 again on the next deploy ("when" of 0014 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793328483290;
COMMIT;
