-- Rollback of 0025_story_search. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0025 API and worker code deployed (the new worker sweeps story_search and GET /search/stories reads
-- it; with the table gone the sweep fails and backs off, and search answers 500),
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- Drops derived data only (the search index is rebuilt from stories by the sweep) and stories_updated_idx. pg_trgm is left installed:
-- other objects may use it, and it is harmless; DROP EXTENSION pg_trgm by hand if nothing else does.
-- Refuses (raises, nothing changed) unless 0025 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794569989780 THEN
    RAISE EXCEPTION '0025_story_search is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP TABLE IF EXISTS "story_search";
DROP INDEX IF EXISTS "stories_updated_idx";
-- So the migrator applies 0025 again on the next deploy ("when" of 0025 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794569989780;
COMMIT;
