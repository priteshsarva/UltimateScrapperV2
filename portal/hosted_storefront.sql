-- hosted_storefront.sql — Phase 1 schema for multi-tenant hosted storefronts.
-- A hosted site IS an enrollment (type='hosted'): approval, expiry/billing,
-- enrollment_sources (product selection) and category_map are reused as-is.
-- Apply by hand in the Supabase SQL editor (same as the other portal/*.sql files).
-- Additive only — safe on the live portal DB.

-- ============================================================
-- 1. enrollments: distinguish plugin sites from hosted storefronts
-- ============================================================
alter table enrollments
  add column if not exists type text not null default 'plugin'
    check (type in ('plugin','hosted'));

-- subdomain for hosted sites: <slug>.yourplatform.com (null for plugin enrollments)
alter table enrollments
  add column if not exists slug text;
create unique index if not exists idx_enrollments_slug
  on enrollments(slug) where slug is not null;

-- ============================================================
-- 2. site_settings: the per-vendor "branding pack"
--    One row per hosted enrollment. Every vendor-varying detail the
--    storefront renders (logo, name, WhatsApp, address, hero, ...) lives here.
-- ============================================================
create table if not exists site_settings (
  enrollment_id uuid primary key references enrollments(id) on delete cascade,
  store_name    text not null,
  logo_url      text,
  theme         jsonb not null default '{}'::jsonb,  -- { primary, accent, ... }
  whatsapp      text,                                -- checkout target number
  email         text,
  phone         text,
  address       jsonb not null default '{}'::jsonb,  -- { line1, city, state, pincode }
  social_urls   jsonb not null default '{}'::jsonb,  -- { instagram, facebook, ... }
  hero          jsonb not null default '{}'::jsonb,  -- { image_url, title, subtitle, cta }
  announcement  text,                                -- announcement-bar text ('' = hidden)
  about         text,
  policies      jsonb not null default '{}'::jsonb,  -- { shipping, returns, privacy, terms } text blocks
  pricing       jsonb not null default '{}'::jsonb,  -- markup bands; empty = platform default bands
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- 3. customers: per-vendor shopper accounts (vendorA's buyers invisible to vendorB)
--    Same email may register independently on different vendor sites.
-- ============================================================
create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  email         text not null,
  password_hash text not null,
  name          text,
  phone         text,
  created_at    timestamptz not null default now(),
  unique (enrollment_id, email)
);
create index if not exists idx_customers_enrollment on customers(enrollment_id);

create table if not exists customer_addresses (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  label       text,                                  -- "Home", "Office"
  name        text not null,
  phone       text not null,
  line1       text not null,
  line2       text,
  city        text not null,
  state       text not null,
  pincode     text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_addresses_customer on customer_addresses(customer_id);

-- ============================================================
-- 4. orders: WhatsApp-checkout orders. customer_id null = guest checkout.
--    Prices/totals are computed SERVER-side at order creation (never trusted
--    from the browser), from the scraper price + the vendor's markup bands.
-- ============================================================
create sequence if not exists order_no_seq;

create table if not exists orders (
  id            uuid primary key default gen_random_uuid(),
  order_no      text unique not null default ('ORD-' || lpad(nextval('order_no_seq')::text, 6, '0')),
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  customer_id   uuid references customers(id) on delete set null,  -- null = guest
  buyer_name    text not null,
  buyer_phone   text not null,
  buyer_email   text,
  address       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                check (status in ('pending','confirmed','shipped','delivered','cancelled')),
  subtotal      numeric(12,2) not null default 0,
  total         numeric(12,2) not null default 0,
  channel       text not null default 'whatsapp',    -- 'whatsapp' now; 'gateway' in Phase 2
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
create index if not exists idx_orders_enrollment on orders(enrollment_id, created_at desc);
create index if not exists idx_orders_customer on orders(customer_id);

create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  product_id   text not null,        -- productId within its category db
  db_name      text not null,        -- which scraper category db (productId unique only per-db)
  product_name text not null,
  image_url    text,
  unit_price   numeric(12,2) not null,  -- server-computed sell price at order time
  qty          int not null default 1 check (qty > 0),
  line_total   numeric(12,2) not null
);
create index if not exists idx_order_items_order on order_items(order_id);
