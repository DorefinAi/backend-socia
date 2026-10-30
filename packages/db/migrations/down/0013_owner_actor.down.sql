-- Rollback of 0013_owner_actor. Not run by the migrator (it only reads meta/_journal.json); run it by hand, with
-- the pre-0013 API code deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- Not destructive for the record: before the column is dropped, each owner-console row's actor ("owner:<name>") is
-- copied into its "after" JSON as "ownerActor" (an object gets the key; null becomes {"ownerActor": …}; any other
-- value becomes {"value": <old after>, "ownerActor": …}), so the history still says which owner made the change.
-- Refuses (raises, nothing changed) unless 0013 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793326913161 THEN
    RAISE EXCEPTION '0013_owner_actor is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
UPDATE "audit_log"
SET "after" = CASE
  WHEN "after" IS NULL OR jsonb_typeof("after") = 'object' THEN coalesce("after", '{}'::jsonb) || jsonb_build_object('ownerActor', "actor")
  ELSE jsonb_build_object('value', "after", 'ownerActor', "actor")
END
WHERE "actor" IS NOT NULL;
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "actor";
-- So the migrator applies 0013 again on the next deploy ("when" of 0013 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793326913161;
COMMIT;
