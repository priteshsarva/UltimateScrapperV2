-- Vendor-curated storefront navigation / front-page category selection.
-- nav = { items: [{ category, label, on_home }] }  (empty {} = fall back to
-- "all attached categories, all shown on home" — the pre-nav behaviour).
alter table site_settings add column if not exists nav jsonb not null default '{}'::jsonb;
