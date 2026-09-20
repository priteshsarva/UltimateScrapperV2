-- Allow METHOD_C (cartpe.in encrypted-API scraper) in the sources.method check.
-- Without this, saving a source with method='METHOD_C' violates
-- sources_method_check (was METHOD_A/METHOD_B/MANUAL). Apply by hand in Supabase.
alter table sources drop constraint if exists sources_method_check;
alter table sources add constraint sources_method_check
  check (method in ('METHOD_A', 'METHOD_B', 'METHOD_C', 'MANUAL'));
