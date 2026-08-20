-- Phase 2 — extra site_settings columns for analytics pixel injection.
alter table site_settings
  add column if not exists analytics jsonb not null default '{}'::jsonb;
-- pricing already exists (Phase 1A) as jsonb; vendor UI just writes .bands into it.
