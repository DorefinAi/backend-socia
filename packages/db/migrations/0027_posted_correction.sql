-- Correcting a posted story (Edit on Posted today): published_posts records the last correction of its post,
-- when (corrected_at) and by whom (corrected_by). Both stay null for a post that was never corrected.
--
-- Additive and not destructive: two new nullable columns and a foreign key, no default, so no table rewrite and
-- no backfill (every existing row is simply "never corrected"). Every existing corrected_by is null, so the
-- foreign key has nothing to check.
-- The drizzle migrator runs all pending migrations in one transaction (pg-core dialect.migrate): SET LOCAL holds
-- for the rest of this deploy's migration run and ends with it, and every lock taken here is held until that
-- transaction commits. So adding the foreign key NOT VALID and then validating it gives no lock benefit under the
-- migrator; the split is kept for when this file is run on its own (outside one transaction, or with a commit
-- between the two statements), where the validation needs only a lighter lock. The short lock_timeout gives up
-- rather than queue behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "published_posts" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "published_posts" ADD COLUMN "corrected_by" uuid;--> statement-breakpoint
ALTER TABLE "published_posts" ADD CONSTRAINT "published_posts_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "published_posts" VALIDATE CONSTRAINT "published_posts_corrected_by_users_id_fk";
