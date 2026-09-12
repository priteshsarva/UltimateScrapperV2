-- Catalogue activity log: what users search for and which products they open,
-- across the public search landing and the vendor research tool. Analytics /
-- audit only (does NOT affect the free-search quota). Additive; apply by hand
-- in the Supabase SQL editor like the other portal/*.sql files.
create table if not exists catalogue_activity (
  id            bigserial primary key,
  event         text not null,                       -- 'search' | 'open'
  scope         text,                                -- 'landing' | 'vendor'
  user_id       uuid references users(id) on delete set null,
  device_id     text,
  q             text,                                -- search query (event='search')
  category      text,
  filters       jsonb,                               -- brand/size/source/sort/price (event='search')
  results_count int,                                 -- (event='search')
  product_id    text,                                -- (event='open')
  product_name  text,                                -- (event='open')
  source_name   text,                                -- (event='open')
  created_at    timestamptz not null default now()
);
create index if not exists idx_catalogue_activity_created on catalogue_activity(created_at desc);
create index if not exists idx_catalogue_activity_user    on catalogue_activity(user_id);
create index if not exists idx_catalogue_activity_event   on catalogue_activity(event);
