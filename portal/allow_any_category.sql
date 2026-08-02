-- =====================================================================
-- Allow ANY site category (not just 'shoes'/'watches').
-- Run by hand in the Supabase SQL editor (there is no migration tool).
--
-- Why this is safe:
--   * models/dbManager.js auto-creates `<category>.db` with the full schema
--     the first time any category is scraped — nothing else needs to exist.
--   * /product/sync-feed selects the DB from ?category= and only serves
--     categories that are actually attached to the enrollment.
--   * The Express layer now slugs every category on write
--     (portal/sources.js -> sanitizeCategory), so a category can never be
--     an unsafe filename.
-- =====================================================================

-- Postgres default-names these constraints <table>_<column>_check.
alter table sources          drop constraint if exists sources_category_check;
alter table scrape_requests  drop constraint if exists scrape_requests_category_check;

-- If either survives under a non-default name, find it with:
--   select conrelid::regclass as tbl, conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where pg_get_constraintdef(oid) ilike '%category%';
-- then: alter table <tbl> drop constraint <conname>;

-- Keep garbage out at the database level too: same shape the app enforces
-- (lowercase slug, 1-40 chars of a-z 0-9 _ -).
alter table sources
  add constraint sources_category_slug
  check (category ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
alter table scrape_requests
  add constraint scrape_requests_category_slug
  check (category ~ '^[a-z0-9][a-z0-9_-]{0,39}$');
