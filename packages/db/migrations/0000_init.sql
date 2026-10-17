CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"story_id" uuid,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"seq" integer,
	"storage_key" text NOT NULL,
	"attached_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handle_directory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_name" text NOT NULL,
	"entity_name_hi" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"platform" text DEFAULT 'x' NOT NULL,
	"handle" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handle_directory_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_name" text NOT NULL,
	"entity_name_hi" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"platform" text DEFAULT 'x' NOT NULL,
	"handle" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hashtag_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"match_type" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"hashtag_latin" text NOT NULL,
	"hashtag_devanagari" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingested_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"source_path" text NOT NULL,
	"file_name" text NOT NULL,
	"bytes" bigint NOT NULL,
	"mtime" timestamp with time zone,
	"storage_key" text NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"seq" integer,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"account" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone,
	"rotated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"platform" text DEFAULT 'x' NOT NULL,
	"status" text DEFAULT 'rendering' NOT NULL,
	"body_text" text NOT NULL,
	"card_headline" text NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"mentions" text[] DEFAULT '{}'::text[] NOT NULL,
	"mention_suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compose_method" text DEFAULT 'rules' NOT NULL,
	"compose_version" text NOT NULL,
	"card_rev" integer DEFAULT 1 NOT NULL,
	"card_rendered_rev" integer DEFAULT 0 NOT NULL,
	"card_key" text,
	"card_font_px" integer,
	"render_error" text,
	"render_lease_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"claimed_by" uuid,
	"claim_expires_at" timestamp with time zone,
	"reject_reason" text,
	"reject_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"impressions" integer,
	"likes" integer,
	"comments" integer,
	"shares" integer,
	"saves" integer,
	"video_views" integer
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"kind" text DEFAULT 'post' NOT NULL,
	"idempotency_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"platform_post_id" text,
	"permalink" text,
	"reason" text,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publish_jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "published_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"platform_post_id" text NOT NULL,
	"permalink" text NOT NULL,
	"text" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"recalled_at" timestamp with time zone,
	"recalled_by" uuid,
	"recall_reason" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'ingested' NOT NULL,
	"source_text" text,
	"source_charset" text,
	"source_encoding" text,
	"conversion_confidence" real,
	"headline" text,
	"body" text,
	"parse_method" text,
	"parse_note" text,
	"media_state" text DEFAULT 'awaiting' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"role" text NOT NULL,
	"platforms" text[] DEFAULT '{x}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('operator', 'editor', 'admin', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_file_id_ingested_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ingested_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_directory" ADD CONSTRAINT "handle_directory_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_directory" ADD CONSTRAINT "handle_directory_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handle_directory_staging" ADD CONSTRAINT "handle_directory_staging_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hashtag_rules" ADD CONSTRAINT "hashtag_rules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingested_files" ADD CONSTRAINT "ingested_files_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_credentials" ADD CONSTRAINT "platform_credentials_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_drafts" ADD CONSTRAINT "post_drafts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_drafts" ADD CONSTRAINT "post_drafts_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_drafts" ADD CONSTRAINT "post_drafts_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_published_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."published_posts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_draft_id_post_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."post_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_draft_id_post_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."post_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_recalled_by_users_id_fk" FOREIGN KEY ("recalled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_file_id_ingested_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."ingested_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_slug_idx" ON "assets" USING btree ("org_id","slug","created_at");--> statement-breakpoint
CREATE INDEX "assets_story_idx" ON "assets" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","at");--> statement-breakpoint
CREATE INDEX "handle_directory_verified_idx" ON "handle_directory" USING btree ("org_id","platform") WHERE "handle_directory"."verified_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "handle_staging_source_key" ON "handle_directory_staging" USING btree ("org_id","source","source_id","platform");--> statement-breakpoint
CREATE INDEX "hashtag_rules_org_idx" ON "hashtag_rules" USING btree ("org_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "ingested_files_sha256_key" ON "ingested_files" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "ingested_files_slug_idx" ON "ingested_files" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_credentials_key" ON "platform_credentials" USING btree ("org_id","platform","account");--> statement-breakpoint
CREATE UNIQUE INDEX "post_drafts_story_platform_key" ON "post_drafts" USING btree ("story_id","platform");--> statement-breakpoint
CREATE INDEX "post_drafts_queue_idx" ON "post_drafts" USING btree ("org_id","platform","status","created_at");--> statement-breakpoint
CREATE INDEX "post_drafts_render_idx" ON "post_drafts" USING btree ("card_rendered_rev","card_rev");--> statement-breakpoint
CREATE INDEX "post_metrics_post_idx" ON "post_metrics" USING btree ("post_id","fetched_at");--> statement-breakpoint
CREATE INDEX "publish_jobs_pick_idx" ON "publish_jobs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "published_posts_platform_id_key" ON "published_posts" USING btree ("platform","platform_post_id");--> statement-breakpoint
CREATE INDEX "published_posts_day_idx" ON "published_posts" USING btree ("org_id","platform","published_at");--> statement-breakpoint
CREATE INDEX "stories_status_idx" ON "stories" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "stories_slug_idx" ON "stories" USING btree ("org_id","slug","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");