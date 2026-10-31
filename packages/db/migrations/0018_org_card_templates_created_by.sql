-- Org card templates v2 (dev-docs/org-card-templates-contract.md "v2 additions"): who uploaded a template.
-- Additive and not destructive: a nullable column, so existing (seeded) rows get null. A user deleted later
-- leaves their uploads in place with created_by null. No index: an org has a handful of templates.
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "org_card_templates" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "org_card_templates" ADD CONSTRAINT "org_card_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
