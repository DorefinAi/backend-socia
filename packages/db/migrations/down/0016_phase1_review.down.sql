-- Rollback of 0016_phase1_review. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0016 API and worker code deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- Roll back 0016 before 0015. DESTRUCTIVE only for stories.update_of_draft_id (the link from an update to the
-- posted draft; the stories and drafts stay). The indexes are just dropped.
-- Refuses (raises, nothing changed) unless 0016 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793351191250 THEN
    RAISE EXCEPTION '0016_phase1_review is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP INDEX IF EXISTS "published_posts_copied_draft_key";
DROP INDEX IF EXISTS "published_posts_draft_idx";
DROP INDEX IF EXISTS "post_drafts_queue_updated_idx";
DROP INDEX IF EXISTS "ingested_files_path_idx";
ALTER TABLE "stories" DROP CONSTRAINT IF EXISTS "stories_update_of_draft_id_post_drafts_id_fk";
ALTER TABLE "stories" DROP COLUMN IF EXISTS "update_of_draft_id";
-- So the migrator applies 0016 again on the next deploy ("when" of 0016 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793351191250;
COMMIT;
