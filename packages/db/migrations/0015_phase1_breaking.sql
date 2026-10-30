-- Phase 1 (handoff/phase1-contract.md): breaking .txt files become X posts that the desk pastes by hand.
-- Additive and not destructive. stories: how the file is laid out, the place line's town, the file name's tags,
-- the needs-check reasons and the removed desk note; existing rows get null / '{}' and behave as before.
-- published_posts: a "Copy & Posted" post has no X id or link yet, so both columns become nullable; the unique
-- (platform, platform_post_id) index still refuses a second record of a real post (NULLs never collide).
-- Waits at most 5 s for a lock (busy desk) rather than queueing every other query behind it; just run it again
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "published_posts" ALTER COLUMN "platform_post_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "published_posts" ALTER COLUMN "permalink" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "layout" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "town" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "file_tags" jsonb;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "needs_check" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "desk_note" text;