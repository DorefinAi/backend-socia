-- b8: the composer's own line 2 of a breaking draft, kept as it wrote it. Fit to 280 in the editor rebuilds line 2
-- only while the draft still carries this text (or the post is over 280); a line 2 the desk wrote is left alone,
-- also after a save and reopen. Desk saves never write it; a re-saved file the composer rewrites does.
--
-- Additive: one nullable column, no default, so no table rewrite and no backfill. Drafts from before stay null,
-- which Fit reads as the desk's own text.
ALTER TABLE "post_drafts" ADD COLUMN "composer_line2" text;
