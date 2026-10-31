-- Rollback of 0017_org_card_templates. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0017 API code deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE for org_card_templates: the shared templates' rows (and any layout changed in Settings) are dropped.
-- Their image files stay in storage under card-templates/org/<org id>/; re-running seed-card-templates after
-- migrating up again writes the rows back with the default layouts.
-- Refuses (raises, nothing changed) unless 0017 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793433428183 THEN
    RAISE EXCEPTION '0017_org_card_templates is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
DROP TABLE IF EXISTS "org_card_templates";
-- So the migrator applies 0017 again on the next deploy ("when" of 0017 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793433428183;
COMMIT;
