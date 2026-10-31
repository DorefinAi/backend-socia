-- Shared X card templates per org (dev-docs/org-card-templates-contract.md). Additive: a new table only, no
-- existing data touched. Rows come from the CLI (seed-card-templates --org <id>), not from this migration.
SET lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "org_card_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" text DEFAULT 'x' NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"background_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"layout" jsonb NOT NULL,
	"default_for" text[] DEFAULT '{}'::text[] NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_card_templates_slug_check" CHECK ("org_card_templates"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("org_card_templates"."slug") <= 40),
	CONSTRAINT "org_card_templates_default_for_check" CHECK ("org_card_templates"."default_for" <@ ARRAY['big_breaking', 'breaking']::text[])
);
--> statement-breakpoint
ALTER TABLE "org_card_templates" ADD CONSTRAINT "org_card_templates_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_card_templates_org_platform_slug_key" ON "org_card_templates" USING btree ("org_id","platform","slug");