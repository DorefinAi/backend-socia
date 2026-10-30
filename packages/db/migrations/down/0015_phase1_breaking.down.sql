-- Rollback of 0015_phase1_breaking. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0015 API and worker code deployed and 0016 rolled back first:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>
-- DESTRUCTIVE for the story columns: the breaking files' town, file-name tags, needs-check reasons and removed
-- desk notes are dropped (the stories, their text and their drafts stay). While any story still has them, it
-- REFUSES; to drop them anyway set socia.force_rollback for the session (a setting, not a psql variable, so the
-- script also runs outside psql):  PGOPTIONS="-c socia.force_rollback=on" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>
-- "Copy & Posted" records are kept, but get a placeholder X id ('manual:<row id>') and an empty link so the
-- NOT NULL constraints can come back. After a rollback they can NOT be recalled from Socia (the old code would
-- ask X to delete post 'manual:...', which fails): delete those posts on X by hand.
-- Refuses (raises, nothing changed) unless 0015 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793349418670 THEN
    RAISE EXCEPTION '0015_phase1_breaking is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DO $data$
BEGIN
  IF coalesce(current_setting('socia.force_rollback', true), '') <> 'on' AND EXISTS (
    SELECT 1 FROM "stories"
    WHERE "file_tags" IS NOT NULL OR "town" IS NOT NULL OR "desk_note" IS NOT NULL OR cardinality("needs_check") > 0
  ) THEN
    RAISE EXCEPTION 'Stories still carry phase-1 data (file tags, town, desk note or needs-check reasons); dropping it loses it. Run again with PGOPTIONS="-c socia.force_rollback=on" to drop it anyway.';
  END IF;
END
$data$;
UPDATE "published_posts" SET "platform_post_id" = 'manual:' || "id" WHERE "platform_post_id" IS NULL;
UPDATE "published_posts" SET "permalink" = '' WHERE "permalink" IS NULL;
ALTER TABLE "published_posts" ALTER COLUMN "platform_post_id" SET NOT NULL;
ALTER TABLE "published_posts" ALTER COLUMN "permalink" SET NOT NULL;
ALTER TABLE "stories" DROP COLUMN IF EXISTS "layout";
ALTER TABLE "stories" DROP COLUMN IF EXISTS "town";
ALTER TABLE "stories" DROP COLUMN IF EXISTS "file_tags";
ALTER TABLE "stories" DROP COLUMN IF EXISTS "needs_check";
ALTER TABLE "stories" DROP COLUMN IF EXISTS "desk_note";
-- So the migrator applies 0015 again on the next deploy ("when" of 0015 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793349418670;
COMMIT;
