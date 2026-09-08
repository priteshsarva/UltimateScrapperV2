-- ---------------------------------------------------------------------
-- SEARCH LANDING: public catalogue-search funnel
--   anon (3 free) -> mobile+OTP signup (50 free) -> ₹100/mo search plan
-- Additive. Apply by hand in the Supabase SQL editor (no migration tool).
-- ---------------------------------------------------------------------

-- Mobile-only accounts: a search user signs up with just a phone number, so
-- email must be optional. (Postgres UNIQUE treats NULLs as distinct, so the
-- existing unique index on email still holds for real emails.)
alter table users alter column email drop not null;

-- Free-search quota for signed-in users + their active search plan.
alter table users add column if not exists search_used       int not null default 0;
alter table users add column if not exists search_last_q      text;        -- dedupe: only a NEW keyword costs a search
alter table users add column if not exists search_plan_until  timestamptz; -- unlimited while in the future

-- Anonymous free-search counter, keyed on a client-generated device id.
-- ponytail: soft gate — clearing the browser resets it. Fine for a teaser.
create table if not exists anon_search (
  device_id  text primary key,
  used       int  not null default 0,
  last_q     text,
  updated_at timestamptz not null default now()
);

-- Short-lived login codes for mobile OTP.
create table if not exists otp_codes (
  mobile     text        not null,
  code       text        not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists otp_codes_mobile_idx on otp_codes(mobile);

-- ₹100/month search-only plan payments (manual UPI reconcile, like invoices).
create table if not exists search_plan_orders (
  id         bigserial primary key,
  user_id    uuid not null references users(id) on delete cascade,
  amount     numeric not null default 100,
  status     text not null default 'pending' check (status in ('pending','claimed','paid','cancelled')),
  utr        text,
  created_at timestamptz not null default now(),
  paid_at    timestamptz
);
create index if not exists search_plan_orders_user_idx on search_plan_orders(user_id);
