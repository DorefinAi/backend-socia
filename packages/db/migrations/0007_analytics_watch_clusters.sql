CREATE TABLE "trend_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- post_metrics may already hold rows from the old 6-hourly X pull: add org_id empty, fill it (and the
-- platform and capture time) from the posted record, then make it required. Nothing is dropped.
ALTER TABLE "post_metrics" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "platform" text DEFAULT 'x' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "captured_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "post_metrics" AS m SET "org_id" = p."org_id", "platform" = p."platform", "captured_at" = m."fetched_at" FROM "published_posts" AS p WHERE p."id" = m."post_id";--> statement-breakpoint
ALTER TABLE "post_metrics" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "age_bucket" text;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "reposts" integer;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "replies" integer;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "quotes" integer;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "bookmarks" integer;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD COLUMN "raw" jsonb;--> statement-breakpoint
ALTER TABLE "trend_items" ADD COLUMN "cluster_id" text;--> statement-breakpoint
ALTER TABLE "trend_items" ADD COLUMN "cluster_rank" integer;--> statement-breakpoint
ALTER TABLE "trend_items" ADD COLUMN "sources" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trend_watches" ADD CONSTRAINT "trend_watches_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_watches" ADD CONSTRAINT "trend_watches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trend_watches_user_keyword_key" ON "trend_watches" USING btree ("user_id",lower("keyword"));--> statement-breakpoint
CREATE INDEX "trend_watches_org_idx" ON "trend_watches" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("org_id","action","at");--> statement-breakpoint
CREATE UNIQUE INDEX "post_metrics_post_bucket_key" ON "post_metrics" USING btree ("post_id","age_bucket");--> statement-breakpoint
CREATE INDEX "stories_org_created_idx" ON "stories" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_age_bucket_check" CHECK ("post_metrics"."age_bucket" IS NULL OR "post_metrics"."age_bucket" IN ('1h', '6h', '24h', '3d', '7d'));