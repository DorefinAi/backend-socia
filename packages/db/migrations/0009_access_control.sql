-- Roles, permissions and per-user exceptions (handoff/access-control-contract.md §3). Not destructive: no
-- rows are removed. users_role_check (the 4 fixed values) is replaced by users_org_role_fk to roles, so a
-- user's role can also be a custom role of their org. users.last_login_at starts null for everyone.
-- Rollback: migrations/down/0009_access_control.down.sql. On a large production audit_log, create
-- audit_log_org_type_idx beforehand with CREATE INDEX CONCURRENTLY (same name and columns); IF NOT EXISTS
-- below then skips it instead of locking audit_log inside this migration's transaction.
CREATE TABLE "role_permissions" (
	"org_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"permission" text NOT NULL,
	"allowed" boolean NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("org_id","role_key","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"platform_scoped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_pkey" PRIMARY KEY("org_id","key"),
	CONSTRAINT "roles_key_check" CHECK ("roles"."key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("roles"."key") <= 40),
	CONSTRAINT "roles_label_check" CHECK (length("roles"."label") BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE "user_permission_overrides" (
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"allowed" boolean NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY("user_id","permission")
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("org_id","role_key") REFERENCES "public"."roles"("org_id","key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_set_by_users_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-written (data, not schema): the 4 built-in roles for every org, now and for each new org. Their
-- permissions need no rows (a missing row is the built-in default, from packages/core/src/permissions.ts),
-- so every existing user keeps exactly today's access. Runs before users_org_role_fk so existing users'
-- roles (admin/editor/operator/viewer, the dropped check's values) all have their row.
CREATE OR REPLACE FUNCTION "seed_built_in_roles"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "roles" ("org_id", "key", "label", "description", "built_in", "platform_scoped") VALUES
    (NEW."id", 'admin', 'Admin', 'Everything, including users and roles.', true, false),
    (NEW."id", 'editor', 'Chief Editor', 'Every page and action except managing users and roles.', true, false),
    (NEW."id", 'operator', 'Digital Team', 'Posts on their own platforms.', true, true),
    (NEW."id", 'viewer', 'Viewer', 'Reads the desk; keeps their own keyword watch and card backgrounds.', true, false)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "orgs_seed_built_in_roles" AFTER INSERT ON "orgs" FOR EACH ROW EXECUTE FUNCTION "seed_built_in_roles"();--> statement-breakpoint
INSERT INTO "roles" ("org_id", "key", "label", "description", "built_in", "platform_scoped")
SELECT o."id", r."key", r."label", r."description", true, r."platform_scoped"
FROM "orgs" o
CROSS JOIN (VALUES
  ('admin', 'Admin', 'Everything, including users and roles.', false),
  ('editor', 'Chief Editor', 'Every page and action except managing users and roles.', false),
  ('operator', 'Digital Team', 'Posts on their own platforms.', true),
  ('viewer', 'Viewer', 'Reads the desk; keeps their own keyword watch and card backgrounds.', false)
) AS r("key", "label", "description", "platform_scoped")
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_role_fk" FOREIGN KEY ("org_id","role") REFERENCES "public"."roles"("org_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_org_type_idx" ON "audit_log" USING btree ("org_id","entity_type","at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_org_role_idx" ON "users" USING btree ("org_id","role");