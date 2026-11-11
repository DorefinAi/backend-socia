-- Two halves of the same change to how a breaking draft is tagged.
--
-- post_drafts.hashtag_suggestions: the topic tags the org's rules matched. The composer no longer puts
-- them on the post — measured against 400 published posts they were wrong far more often than right —
-- so they are offered to the desk here instead and applied only if somebody accepts one.
--
-- hashtag_staging: the other direction. A tag an editor types that no rule of ours produced is the
-- clearest evidence of a rule we are missing, so it is counted here with a few example headlines for the
-- weekly pass that decides whether it deserves a rule. Nothing in this table is ever tagged automatically.
--
-- Additive and not destructive: one new table and one column with a constant default, so on Postgres 11+
-- ADD COLUMN only touches the catalog (no table rewrite) and every draft written before this reads '{}'.
-- The short lock_timeout gives up rather than queue behind a long transaction holding post_drafts.
SET lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "hashtag_staging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"tag_key" text NOT NULL,
	"uses" integer DEFAULT 1 NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "post_drafts" ADD COLUMN "hashtag_suggestions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "hashtag_staging" ADD CONSTRAINT "hashtag_staging_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One row per tag per org, whatever the casing the editor typed
CREATE UNIQUE INDEX "hashtag_staging_key" ON "hashtag_staging" USING btree ("org_id","tag_key");--> statement-breakpoint
-- The weekly review reads them most-used first
CREATE INDEX "hashtag_staging_review_idx" ON "hashtag_staging" USING btree ("org_id","uses" DESC NULLS LAST);
