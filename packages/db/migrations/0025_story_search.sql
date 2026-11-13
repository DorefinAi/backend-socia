-- Story search (GET /search/stories): one row per story with its folded text and phonetic key, searched with
-- trigram indexes. The worker's search sweep fills it (every story with no row, or one whose stories.updated_at is
-- newer than source_updated_at), so the first full sweep after this migration (on worker start) is the backfill;
-- until it has run, search finds only the stories it has reached. `pnpm local:search-backfill` runs it to the end.
--
-- pg_trgm is a trusted extension (PostgreSQL 13+): the database owner may create it without superuser rights.
-- VERIFY ON RENDER after deploy: SELECT show_trgm('पुलिस'); must give trigrams of the whole word (the matras kept
-- inside it), not pieces split at each matra. How Devanagari is split depends on the database's ctype; on the dev
-- database (Windows, English_India.1252) the GIN indexes barely narrow Hindi terms. Results are correct either way
-- (LIKE rechecks every candidate); only the speed depends on it.
--
-- Additive and not destructive: one extension, one new table and two new indexes, no change to an existing
-- column. story_search rows are derived data (rebuilt from stories at any time), and a deleted story takes its row
-- with it (ON DELETE CASCADE). stories_updated_idx is built with a short lock on stories (CREATE INDEX blocks
-- writes to stories while it runs: about a second for tens of thousands of rows).
-- The short lock_timeout gives up rather than queue behind a long transaction.
SET lock_timeout = '5s';--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "story_search" (
	"story_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"search_text" text NOT NULL,
	"search_key" text NOT NULL,
	"headline_text" text DEFAULT '' NOT NULL,
	"headline_key" text DEFAULT '' NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_search" ADD CONSTRAINT "story_search_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_search" ADD CONSTRAINT "story_search_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Word-start, whole-word and substring LIKE on the folded text and the key (" jaipur hads "), per org
CREATE INDEX "story_search_text_trgm" ON "story_search" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "story_search_key_trgm" ON "story_search" USING gin ("search_key" gin_trgm_ops);--> statement-breakpoint
-- The search's newest-first candidate cap (SEARCH_CANDIDATE_CAP) within an org
CREATE INDEX "story_search_org_created_idx" ON "story_search" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- The sweep's steady-state tick: stories edited in the last minutes
CREATE INDEX "stories_updated_idx" ON "stories" USING btree ("updated_at" DESC NULLS LAST);