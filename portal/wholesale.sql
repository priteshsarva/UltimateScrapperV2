-- wholesale.sql — Wholesale marketplace.
-- A wholesaler IS an enrollment (type='wholesale'); on approval it spawns a
-- sources row (id='ws_'||slug, category='wholesale', method='MANUAL') so
-- retailers pick it in the SAME source picker and every downstream path works.
-- Products live in databases/wholesale.db (not shoes/watches). Platform-mode
-- orders hold split payments in wallets, released on shipment-photo approval.
-- Additive only. Apply by hand in the Supabase SQL editor.

-- 1. plans: kind + user-facing features + machine limits (description exists)
alter table plans
  add column if not exists kind     text not null default 'retail' check (kind in ('retail','wholesale','both')),
  add column if not exists features text[] not null default '{}',
  add column if not exists limits   jsonb not null default '{}';   -- { max_products, max_images, allow_payout_routing }

-- 2. enrollments: type='wholesale' + payment routing + fulfilment default + gateway fee override
alter table enrollments drop constraint if exists enrollments_type_check;
alter table enrollments add constraint enrollments_type_check check (type in ('plugin','hosted','wholesale'));
alter table enrollments
  add column if not exists payout_mode     text not null default 'direct' check (payout_mode in ('direct','platform')),
  add column if not exists gateway_fee_pct numeric,                 -- null = use platform default
  add column if not exists fulfilment_mode text not null default 'via_retailer' check (fulfilment_mode in ('via_retailer','direct_to_customer'));

-- 3. sources: MANUAL method (never scraped)
alter table sources drop constraint if exists sources_method_check;
alter table sources add constraint sources_method_check check (method in ('METHOD_A','METHOD_B','MANUAL'));

-- 4. wholesalers: profile 1:1 with the type='wholesale' enrollment
create table if not exists wholesalers (
  enrollment_id uuid primary key references enrollments(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  business_name text not null,
  slug          text unique not null,
  gst_number    text, phone text, whatsapp text,
  address       jsonb not null default '{}',
  categories    text[] not null default '{}',
  about         text, logo_url text,
  verified      boolean not null default false,
  gst_verified  boolean not null default false,
  min_order_qty int not null default 1,
  ships_from    text,
  created_at    timestamptz not null default now()
);

-- 5. shared product taxonomy: primary -> sub, dropdown only (no dupes)
create table if not exists product_taxonomy (
  id          uuid primary key default gen_random_uuid(),
  primary_cat text not null,
  sub_slug    text not null,
  sub_label   text not null,
  status      text not null default 'active' check (status in ('active','proposed','rejected')),
  proposed_by uuid references users(id),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  unique (primary_cat, sub_slug)
);

-- 6. wallets (per user) + ledger
create table if not exists wallets (
  user_id          uuid primary key references users(id) on delete cascade,
  available        numeric not null default 0,
  held             numeric not null default 0,
  payout_threshold numeric not null default 1000,
  payout_upi       text,
  payout_bank      jsonb not null default '{}',
  terms_accepted_at timestamptz,
  updated_at       timestamptz not null default now()
);
create table if not exists wallet_ledger (
  id            bigserial primary key,
  user_id       uuid not null references users(id) on delete cascade,
  order_id      uuid references orders(id) on delete set null,
  order_item_id uuid references order_items(id) on delete set null,
  type          text not null check (type in ('hold','release','payout','refund','fee','adjust')),
  amount        numeric not null,
  balance_after numeric,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_wallet_ledger_user on wallet_ledger(user_id, created_at desc);

-- 7. shipments: two legs, 2..10 parcel photos, admin approval, 60-day purge
create table if not exists shipments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  leg         text not null check (leg in ('wholesaler_to_retailer','retailer_to_customer')),
  shipped_by  uuid references users(id),
  courier     text, tracking_no text,
  photos      jsonb not null default '[]',        -- [{url,key,uploaded_at}]
  status      text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  reviewed_by uuid references users(id), reviewed_at timestamptz, note text,
  purge_after timestamptz,                          -- photos deleted after this
  purged      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_shipments_order on shipments(order_id);
create index if not exists idx_shipments_purge on shipments(purge_after) where purged = false;

-- 8. payout requests
create table if not exists payout_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  amount      numeric not null,
  method      text not null default 'upi' check (method in ('upi','bank')),
  destination jsonb not null default '{}',
  status      text not null default 'requested' check (status in ('requested','processing','paid','cancelled')),
  utr         text, note text,
  reviewed_by uuid references users(id), paid_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_payouts_user on payout_requests(user_id, created_at desc);

-- 9. orders: payment_status, per-order fulfilment, split amounts
alter table orders
  add column if not exists payment_status   text not null default 'unpaid' check (payment_status in ('unpaid','claimed','verified','refunded')),
  add column if not exists payment_utr      text,
  add column if not exists fulfilment_mode  text,
  add column if not exists share_wholesaler numeric,
  add column if not exists share_retailer   numeric,
  add column if not exists platform_fee     numeric,
  add column if not exists gateway_fee      numeric;
alter table order_items
  add column if not exists snapshot               jsonb not null default '{}',
  add column if not exists supplier_enrollment_id uuid,
  add column if not exists cost_price             numeric;

-- Platform-wide settings (fee_pct, gateway_fee_pct, listing_reverify_days,
-- payout_terms_text) live in app_settings key 'platform' via settings.js.

-- Fulfilment: allow the wholesaler to ship straight to the end customer.
alter table shipments drop constraint if exists shipments_leg_check;
alter table shipments add constraint shipments_leg_check
  check (leg in ('wholesaler_to_retailer','retailer_to_customer','wholesaler_to_customer'));
