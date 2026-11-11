-- Rollback of 0022_hashtag_suggestions. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0022 API and worker code deployed (the new code writes post_drafts.hashtag_suggestions on every
-- breaking compose, reads it in the draft view, and writes hashtag_staging when an editor adds a tag), e.g.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE: drops hashtag_staging entirely (every hashtag the desk typed that we had no rule for, and the
-- counts behind the weekly review) and post_drafts.hashtag_suggestions (the offered topic tags). The hashtags
-- actually on the posts live in post_drafts.hashtags and are untouched.
-- NOTE: rolling back puts the topic rules back on the post automatically, which is the behaviour this
-- migration was made to stop. Only do it alongside the matching code.
-- Refuses (raises, nothing changed) unless 0022 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794348387953 THEN
    RAISE EXCEPTION '0022_hashtag_suggestions is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP TABLE IF EXISTS "hashtag_staging";
ALTER TABLE "post_drafts" DROP COLUMN IF EXISTS "hashtag_suggestions";
-- So the migrator applies 0022 again on the next deploy ("when" of 0022 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794348387953;
COMMIT;
