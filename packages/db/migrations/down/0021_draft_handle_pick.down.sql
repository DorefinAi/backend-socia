-- Rollback of 0021_draft_handle_pick. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0021 API and worker code deployed (the new code writes post_drafts.handle_pick on every breaking
-- compose and reads it in the draft view), e.g.
-- psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE only for post_drafts.handle_pick: the audit line behind each breaking draft's handles (the story
-- class, the reason and the warnings). The handles and mentions themselves are separate columns and are untouched.
-- Refuses (raises, nothing changed) unless 0021 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1794341863044 THEN
    RAISE EXCEPTION '0021_draft_handle_pick is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "post_drafts" DROP COLUMN IF EXISTS "handle_pick";
-- So the migrator applies 0021 again on the next deploy ("when" of 0021 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1794341863044;
COMMIT;
