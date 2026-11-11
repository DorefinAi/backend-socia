-- Why a breaking draft got the handles it got: the story class the rules hung off, the reason in words, the
-- warnings that never blocked a tag (an unknown reporter token in the file name, an unknown district code),
-- and the handles themselves with each one's reason. The desk disagreeing with a CLASS is worth far more
-- than the desk disagreeing with one handle, because a class fix moves hundreds of posts.
--
-- Additive and not destructive: one nullable column with no default, so on Postgres 11+ ADD COLUMN only
-- touches the catalog (no table rewrite) and every draft written before this reads NULL. Drafts already in
-- the queue keep the handles they went out with; only drafts composed from now on carry this.
-- The short lock_timeout gives up rather than queue behind a long transaction holding post_drafts.
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "post_drafts" ADD COLUMN "handle_pick" jsonb;
