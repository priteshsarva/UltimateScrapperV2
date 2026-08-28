-- Tracks every distinct scraped brand the catalogue scan has ever seen, so a
-- later scan can detect genuinely NEW brands and notify the super-admin to map
-- them. Seeded silently on first run (see portal/catalogueScan.js).
create table if not exists known_brands (
  raw_lower  text primary key,
  raw        text not null,
  first_seen timestamptz default now()
);

-- per-user notification targeting (broadcasts keep user_id null)
alter table platform_notifications add column if not exists user_id uuid;

-- hosted expiry reminder throttle
alter table enrollments add column if not exists last_reminder_at timestamptz;
