ALTER TABLE "assets" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "storage_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "source_path" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "bytes" bigint;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "source" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "external" jsonb;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "district" text;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_story_source_path_key" ON "assets" USING btree ("story_id","source_path") WHERE "assets"."source_path" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stories_external_key" ON "stories" USING btree ("org_id","source","external_id") WHERE "stories"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stories_source_recent_idx" ON "stories" USING btree ("source","created_at");