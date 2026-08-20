-- Phase 1E follow-up — vendor-editable homepage layout stored as an ordered
-- array of section specs, each { type, props, title?, wrap? }.
-- Empty array = storefront falls back to the built-in "commerce" preset.
alter table site_settings
  add column if not exists sections jsonb not null default '[]'::jsonb;
