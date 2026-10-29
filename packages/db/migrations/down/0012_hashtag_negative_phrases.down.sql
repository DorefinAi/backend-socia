-- Rollback of 0012_hashtag_negative_phrases. Not run by the migrator (it only reads meta/_journal.json); run it
-- by hand, with the pre-0012 API and worker code deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE: every hashtag rule's negative phrases are dropped (the rules stay), so the accident rule tags
-- averted accidents again.
-- Refuses (raises, nothing changed) unless 0012 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793297121317 THEN
    RAISE EXCEPTION '0012_hashtag_negative_phrases is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "hashtag_rules" DROP COLUMN IF EXISTS "negative_phrases";
-- So the migrator applies 0012 again on the next deploy ("when" of 0012 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793297121317;
COMMIT;
