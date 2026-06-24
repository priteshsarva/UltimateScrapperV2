-- Run in Supabase SQL editor. Per-source category lists for the picker.
create table if not exists source_categories (
  id            uuid primary key default gen_random_uuid(),
  source_id     text not null references sources(id) on delete cascade,
  cat_name      text not null,
  slug          text,
  product_count int not null default 0,
  enabled       boolean not null default true,   -- admin can hide junk without deleting
  updated_at    timestamptz not null default now(),
  unique (source_id, cat_name)
);
create index if not exists idx_srccat_source on source_categories(source_id);
