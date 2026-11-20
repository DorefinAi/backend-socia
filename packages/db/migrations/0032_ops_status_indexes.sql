-- Indexes for GET /owner/ops/summary (dev-docs/ops-status-contract.md), which the Sentry control centre polls every
-- 30 s and which reads across orgs, so the org-leading indexes do not serve it.
--
-- Additive only: six new indexes, IF NOT EXISTS, no table or row changes. A separate migration rather than an edit of
-- 0031, which may already be applied (an applied migration is never run again). Plain CREATE INDEX (the migrator runs
-- in a transaction): each briefly blocks writes to its table while it builds, a second or two at today's sizes.
CREATE INDEX IF NOT EXISTS "post_drafts_created_idx" ON "post_drafts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_drafts_moving_idx" ON "post_drafts" USING btree ("status") WHERE "post_drafts"."status" IN ('rendering', 'queued', 'publishing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "post_drafts_card_due_idx" ON "post_drafts" USING btree ("story_id") WHERE "post_drafts"."card_rendered_rev" < "post_drafts"."card_rev";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "published_posts_recalled_idx" ON "published_posts" USING btree ("recalled_at") WHERE "published_posts"."recalled_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stories_created_idx" ON "stories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stories_received_idx" ON "stories" USING btree ("received_at");
