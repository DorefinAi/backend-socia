-- Soft delete of a user (Admin: delete a user): users.deleted_at is set once when an admin deletes someone. A deleted
-- user is also inactive, cannot sign in, and is left out of every user list; the row stays, so names on past posts
-- (published_posts.*_by, post_decisions.decided_by, ...) still resolve, and the email (username) stays taken.
--
-- Additive and not destructive: one new nullable column, no default, so no table rewrite and no backfill (every
-- existing user is simply "not deleted"). The short lock_timeout gives up rather than queue behind a long transaction
-- (SET LOCAL holds for the rest of the migrator's one transaction).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;
