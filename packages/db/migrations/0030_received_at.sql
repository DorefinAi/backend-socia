-- Queue order by when a story reached its source (owner, 15 Nov 2026): stories.received_at. A breaking file's story
-- takes the time the file was added to the share (the ingest stage sets it); everything else defaults to now(), which
-- is its created_at. The queue sorts, groups by day and shows "time ago" by it; story links keep created_at.
--
-- Additive: one NOT NULL column with a non-volatile default (no table rewrite), every existing row backfilled from
-- created_at (so nothing already in the queue moves), and an index for the queue. The short lock_timeout gives up
-- rather than queue behind a long transaction (SET LOCAL holds for the rest of the migrator's one transaction).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "received_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "stories" SET "received_at" = "created_at";--> statement-breakpoint
CREATE INDEX "stories_org_received_idx" ON "stories" USING btree ("org_id","received_at");
