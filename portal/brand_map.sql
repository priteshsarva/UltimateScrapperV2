-- GLOBAL brand mapping (super-admin managed, not per-vendor). Maps a raw scraped
-- brand string to a clean canonical brand, applied across every storefront.
create table if not exists brand_map (
  raw        text primary key,        -- exact scraped productBrand value (lowercased key)
  canonical  text not null,
  updated_at timestamptz not null default now()
);
