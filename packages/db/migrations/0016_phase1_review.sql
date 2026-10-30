-- Phase 1 review (handoff/phase1-contract.md "Changes"). Additive and not destructive.
-- stories.update_of_draft_id: a breaking file saved again after its post went out links its new story to the
-- posted draft. Indexes: the breaking share's path lookups, the posted/rejected views' keyset paging, who posted
-- a draft, and at most one live Copy & Posted record per draft (two racing clicks: one wins). Plain CREATE INDEX
-- (the migrator runs in a transaction, so not CONCURRENTLY); the tables are small enough for a short block.
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "update_of_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_update_of_draft_id_post_drafts_id_fk" FOREIGN KEY ("update_of_draft_id") REFERENCES "public"."post_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingested_files_path_idx" ON "ingested_files" USING btree ("org_id","source_path","ingested_at");--> statement-breakpoint
CREATE INDEX "post_drafts_queue_updated_idx" ON "post_drafts" USING btree ("org_id","platform","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "published_posts_draft_idx" ON "published_posts" USING btree ("draft_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "published_posts_copied_draft_key" ON "published_posts" USING btree ("draft_id") WHERE "published_posts"."permalink" IS NULL AND "published_posts"."recalled_at" IS NULL;