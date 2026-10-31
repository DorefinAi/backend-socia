-- Rollback of 0018_org_card_templates_created_by. Not run by the migrator (it only reads meta/_journal.json); run it
-- by hand, with the pre-0018 API code deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE only for org_card_templates.created_by (who uploaded each template). Uploaded templates stay; after
-- this they count as unowned, so only an admin can rename them or move their areas.
-- Refuses (raises, nothing changed) unless 0018 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793436640046 THEN
    RAISE EXCEPTION '0018_org_card_templates_created_by is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
ALTER TABLE "org_card_templates" DROP CONSTRAINT IF EXISTS "org_card_templates_created_by_users_id_fk";
ALTER TABLE "org_card_templates" DROP COLUMN IF EXISTS "created_by";
-- So the migrator applies 0018 again on the next deploy ("when" of 0018 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793436640046;
COMMIT;
