-- Web Scraper drafts are reworded (handoff/web-scraper-contract.md, "Draft rewording"). Additive and not
-- destructive: one nullable column, no rewrite of existing rows (older drafts keep rewrite = null).
ALTER TABLE "post_drafts" ADD COLUMN "rewrite" jsonb;
