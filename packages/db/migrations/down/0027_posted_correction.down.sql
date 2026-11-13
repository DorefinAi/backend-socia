-- Rollback of 0027_posted_correction. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0027 API code deployed (the new API reads and writes published_posts.corrected_at/corrected_by),
-- e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE for the correction record only: who corrected a posted story and when is lost (the audit trail's
-- draft.correct_posted rows keep it). The posts themselves, their text and card are untouched.
-- Refuses (raises, nothing changed) unless 0027 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794593982992 THEN
    RAISE EXCEPTION '0027_posted_correction is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "published_posts" DROP CONSTRAINT IF EXISTS "published_posts_corrected_by_users_id_fk";
ALTER TABLE "published_posts" DROP COLUMN IF EXISTS "corrected_by";
ALTER TABLE "published_posts" DROP COLUMN IF EXISTS "corrected_at";
-- So the migrator applies 0027 again on the next deploy ("when" of 0027 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794593982992;
COMMIT;
