ALTER TABLE "post_drafts" ADD COLUMN "custom_card_key" text;--> statement-breakpoint
ALTER TABLE "published_posts" ADD COLUMN "card_key" text;--> statement-breakpoint
ALTER TABLE "published_posts" ADD COLUMN "manual" boolean DEFAULT false NOT NULL;