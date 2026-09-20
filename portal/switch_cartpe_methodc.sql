-- Switch every legacy METHOD_A source (the old cartpe.in DOM layout) to METHOD_C
-- (the encrypted-API scraper). cartpe migrated all its stores to the React SPA,
-- so METHOD_A no longer scrapes them. This is the LIVE registry that drives both
-- the rotator crawl and the live re-scrape (resolveMethod reads Postgres first).
-- Run in Supabase. Requires the method_c.sql constraint widening first.
-- Revert an individual source, if ever needed, from the admin Sources screen.
update sources set method = 'METHOD_C' where method = 'METHOD_A';
