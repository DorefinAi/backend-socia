-- Rollback of 0009_access_control. Not run by the migrator (it only reads meta/_journal.json); run it by hand,
-- with the pre-0009 API and worker code deployed, e.g. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>.
-- DESTRUCTIVE: custom roles, every role permission setting, every user exception and users.last_login_at are
-- dropped; users on a custom role become viewer (their old role is not kept) and are signed out. Audit rows stay.
-- Refuses (raises, nothing changed) unless 0009 is the newest row in drizzle.__drizzle_migrations.
BEGIN;
-- Guard: only when 0009 is the newest applied migration. Roll back anything newer first (its own down
-- script), else this would remove 0009's journal row under a later schema and the migrator would re-apply it.
DO $guard$
DECLARE newest bigint;
BEGIN
  SELECT max("created_at") INTO newest FROM "drizzle"."__drizzle_migrations";
  IF newest IS DISTINCT FROM 1793255717558 THEN
    RAISE EXCEPTION '0009_access_control is not the newest applied migration (newest created_at: %). Roll back the newer migrations first.', newest;
  END IF;
END
$guard$;
-- Users moved to viewer lose their sessions, so nobody keeps a session minted under a removed role
DELETE FROM "sessions" WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "role" NOT IN ('operator', 'editor', 'admin', 'viewer'));
UPDATE "users" SET "role" = 'viewer' WHERE "role" NOT IN ('operator', 'editor', 'admin', 'viewer');
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_org_role_fk";
DROP INDEX IF EXISTS "users_org_role_idx";
DROP INDEX IF EXISTS "audit_log_org_type_idx";
DROP TRIGGER IF EXISTS "orgs_seed_built_in_roles" ON "orgs";
DROP FUNCTION IF EXISTS "seed_built_in_roles"();
DROP TABLE IF EXISTS "user_permission_overrides";
DROP TABLE IF EXISTS "role_permissions";
DROP TABLE IF EXISTS "roles";
ALTER TABLE "users" DROP COLUMN IF EXISTS "last_login_at";
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('operator', 'editor', 'admin', 'viewer'));
-- So the migrator applies 0009 again on the next deploy ("when" of 0009 in meta/_journal.json)
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1793255717558;
COMMIT;
