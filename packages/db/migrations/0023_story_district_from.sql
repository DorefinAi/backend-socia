-- Where a breaking file's district came from (b6 fix brief P0). place_line, headline_prefix and tag are the
-- desk's own words and may reach the post (line 1's hashtag, the district police and the collector).
-- file_code (the file name's bureau code) is stated too, unless the reporter files for no single district
-- (a state bureau such as Navin's ACB beat), when the composer drops it. text (a place the headline or the
-- first points mention) was inferred, and the composer only ever offers it. stories.district keeps the best
-- guess for the queue and its filters.
--
-- Additive and not destructive: one nullable column with no default, so on Postgres 11+ ADD COLUMN only
-- touches the catalog (no table rewrite). Rows stored before this read NULL: the compose stage parses the
-- stored file again to recover the provenance; when it cannot, the district is stated only when it equals the
-- file code (as before b6) and offered otherwise. A re-saved file is parsed again and gets its real value.
-- The short lock_timeout gives up rather than queue behind a long transaction holding stories.
SET lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "district_from" text;
