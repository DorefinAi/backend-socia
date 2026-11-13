-- Rollback of 0024_decision_log. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0024 API and worker code deployed (the new code writes post_decisions on every breaking compose
-- and desk decision; with the tables gone those writes fail, are caught and logged, and never block a draft),
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE: drops the decision log (every proposal and desk outcome recorded since 0024) and every
-- reporter_features snapshot. Export them first if they matter:
--   \copy post_decisions TO 'post_decisions.csv' CSV HEADER
--   \copy reporter_features TO 'reporter_features.csv' CSV HEADER
-- Refuses (raises, nothing changed) unless 0024 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794558377333 THEN
    RAISE EXCEPTION '0024_decision_log is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP TABLE IF EXISTS "reporter_features";
DROP TABLE IF EXISTS "post_decisions";
DROP FUNCTION IF EXISTS "reporter_features_no_update"();
DROP FUNCTION IF EXISTS "post_decisions_append_only"();
-- So the migrator applies 0024 again on the next deploy ("when" of 0024 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794558377333;
COMMIT;
