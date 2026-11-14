-- Settings handle types (handle fixes F1, 14 Nov 2026): handle_directory.entity_type is one of the owner's six types,
-- police, collector, admin, organisation, person or party. POST /handles and staging promotion require it; desk-added
-- and learned reporter rows leave it null. Only police, collector and admin handles may be matched by district.
--
-- Additive: one new nullable column (no default, so no table rewrite) and a CHECK on it. The one data change: every
-- existing Settings row with no type (source "manual" or promoted from Wikidata, "wikidata:Q…") becomes "organisation",
-- which matches only on its own names and keywords and stays suggest-only until the desk has posted it twice. Desk and
-- reporter rows are not touched. The short lock_timeout gives up rather than queue behind a long transaction (SET LOCAL
-- holds for the rest of the migrator's one transaction).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "handle_directory" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "handle_directory" ADD CONSTRAINT "handle_directory_entity_type_check" CHECK ("handle_directory"."entity_type" IS NULL OR "handle_directory"."entity_type" IN ('police', 'collector', 'admin', 'organisation', 'person', 'party'));--> statement-breakpoint
UPDATE "handle_directory" SET "entity_type" = 'organisation' WHERE "entity_type" IS NULL AND ("source" = 'manual' OR "source" LIKE 'wikidata%');
