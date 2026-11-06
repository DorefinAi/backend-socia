-- Rollback of 0019_ops_log. Not run by the migrator (it only reads meta/_journal.json); run it by hand, with the
-- pre-0019 API and worker code deployed (the new code writes to these tables; it never crashes without them, but every
-- insert would fail), e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE only for ops_log / ops_heartbeat: the stored log lines (at most 14 days) and process heartbeats. Sentry
-- keeps its own copy of the lines it already pulled.
-- Refuses (raises, nothing changed) unless 0019 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793963787563 THEN
    RAISE EXCEPTION '0019_ops_log is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP TABLE IF EXISTS "ops_log";
DROP TABLE IF EXISTS "ops_heartbeat";
-- So the migrator applies 0019 again on the next deploy ("when" of 0019 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793963787563;
COMMIT;
