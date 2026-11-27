ALTER TABLE "xvideos"."clip" ADD COLUMN "day" date;--> statement-breakpoint
ALTER TABLE "xvideos"."clip" ADD COLUMN "heading" text;--> statement-breakpoint
CREATE INDEX "clip_org_day" ON "xvideos"."clip" USING btree ("org_id","day","mtime" DESC NULLS LAST);--> statement-breakpoint
-- Added by hand: the day of the clips already found, from their day folder ("24-11-2026", "7.11.2026"), one row at a
-- time so a folder name that is not a real date ("31-02-2026") leaves that row's day empty instead of failing the
-- migration. The heading is filled by the watcher (rules xvHeading), which refreshes every clip still on the share
-- within 10 minutes.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT "id", btrim("folder"[3]) AS f FROM "xvideos"."clip"
           WHERE "day" IS NULL AND btrim("folder"[3]) ~ '^\d{1,2}[-.]\d{1,2}[-.]\d{4}$' LOOP
    BEGIN
      UPDATE "xvideos"."clip" SET "day" = make_date(
        split_part(replace(r.f, '.', '-'), '-', 3)::int,
        split_part(replace(r.f, '.', '-'), '-', 2)::int,
        split_part(replace(r.f, '.', '-'), '-', 1)::int)
      WHERE "id" = r."id";
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      NULL;
    END;
  END LOOP;
END $$;
