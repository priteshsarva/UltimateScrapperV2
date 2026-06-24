-- =====================================================================
-- Server Products — Portal schema (Postgres / Supabase)
-- The "human" datastore: accounts, enrollments, keys, payments, etc.
-- Scraped product catalogue stays in SQLite (shoes.db / watches.db +
-- *_archive.db). This DB never holds scraped products — only people,
-- access, money, and user-authored (wholesale) listings.
-- =====================================================================

create extension if not exists pgcrypto;   -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- USERS  (clients + the single hardcoded admin)
-- Auth is handled by your Express server (bcrypt + JWT); Supabase is
-- just the store, so the plugin never talks to Supabase directly.
-- ---------------------------------------------------------------------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  name          text,
  role          text not null default 'client' check (role in ('client','admin')),
  plan          text default 'Starter',
  status        text not null default 'active' check (status in ('active','suspended')),
  created_at    timestamptz not null default now()
);
-- Seed the one admin after deploy (password set from an env var on first run):
--   insert into users (email, password_hash, name, role)
--   values ('you@yourco.com', '<bcrypt hash>', 'Owner', 'admin');

-- ---------------------------------------------------------------------
-- SOURCES  (the scrape sources — was SITES_REGISTRY in sites.js)
-- Moved to the DB so admin approvals can add a source without a deploy.
-- `category` decides which live SQLite DB it writes to (shoes/watches).
-- ---------------------------------------------------------------------
create table if not exists sources (
  id              text primary key,                 -- keep your string ids, e.g. 'shoemartt'
  name            text not null,
  category        text not null check (category in ('shoes','watches')),
  method          text not null check (method in ('METHOD_A','METHOD_B')),
  base_url        text,
  search_key      text,                             -- maps to productFetchedFrom LIKE
  status          text not null default 'active' check (status in ('active','paused')),
  product_count   int  default 0,
  last_scraped_at timestamptz,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- ENROLLMENTS  (one row PER SITE PER USER — holds the key, the expiry,
-- and the category allow-list that scopes that site's plugin sync)
-- ---------------------------------------------------------------------
create table if not exists enrollments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  domain          text not null,                    -- the client's WordPress site
  source_id       text not null references sources(id),
  enrollment_key  text unique not null,             -- the spp_live_... token the plugin sends
  status          text not null default 'pending'
                    check (status in ('pending','approved','active','expired','rejected')),
  categories      text[] not null default '{}',     -- selected category names -> sync-feed filter
  renewal_date    date,
  expiry_date     date,                              -- = activation/renewal + 1 month
  last_sync_at    timestamptz,                       -- for admin "hasn't synced in N days"
  created_at      timestamptz not null default now(),
  unique (domain, source_id)
);
create index if not exists idx_enroll_key    on enrollments(enrollment_key);
create index if not exists idx_enroll_user   on enrollments(user_id);
create index if not exists idx_enroll_expiry on enrollments(status, expiry_date);

-- ---------------------------------------------------------------------
-- SCRAPE REQUESTS  (client asks us to add a new source; admin approves)
-- On approve -> insert a row into sources + kick the scraper.
-- ---------------------------------------------------------------------
create table if not exists scrape_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  site_url    text not null,
  category    text not null check (category in ('shoes','watches')),
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);

-- ---------------------------------------------------------------------
-- INVOICES  (Pay0 payments — renewals / activations)
-- gateway_* kept generic so a second provider drops in behind the same
-- PaymentProvider interface without schema change.
-- ---------------------------------------------------------------------
create table if not exists invoices (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references users(id) on delete cascade,
  enrollment_id      uuid references enrollments(id) on delete set null,
  item               text not null,
  amount             numeric(10,2) not null,
  currency           text not null default 'INR',
  status             text not null default 'created' check (status in ('created','pending','paid','failed')),
  gateway            text not null default 'pay0',
  gateway_order_id   text,
  gateway_payment_url text,
  utr                text,                            -- Pay0 returns this on success
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);
create index if not exists idx_invoice_user  on invoices(user_id);
create index if not exists idx_invoice_order on invoices(gateway_order_id);

-- ---------------------------------------------------------------------
-- ADS  (in-portal promotion marketplace — admin-moderated)
-- ---------------------------------------------------------------------
create table if not exists ads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  title       text not null,
  link        text,
  budget      numeric(10,2) not null,
  spent       numeric(10,2) not null default 0,
  impressions int not null default 0,
  clicks      int not null default 0,
  status      text not null default 'pending' check (status in ('pending','active','paused','rejected')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- ANNOUNCEMENTS  (admin broadcast shown on client dashboards)
-- ---------------------------------------------------------------------
create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- WHOLESALE LISTINGS  (USER-AUTHORED products — Phase 2)
-- Deliberately HERE, not in SQLite: human-owned, moderated, billed
-- separately, and must never be touched by a scraper or the OOS archiver.
-- ---------------------------------------------------------------------
create table if not exists wholesale_listings (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  product     text not null,
  brand       text,
  price       numeric(10,2),
  moq         int default 1,
  images      text[] default '{}',
  description text,
  category    text,
  status      text not null default 'draft' check (status in ('draft','review','active','rejected')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- NOTIFICATIONS  (per-client: expiry warnings, approvals, payments)
-- ---------------------------------------------------------------------
create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  type        text not null check (type in ('expiry','approval','payment','system')),
  text        text not null,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_notif_user on notifications(user_id, read);

-- ---------------------------------------------------------------------
-- AUDIT LOG  (admin actions: approvals, manual extends, key revokes, payments)
-- ---------------------------------------------------------------------
create table if not exists audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor       text not null,                         -- 'Admin' or user email/system
  action      text not null,
  target      text,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- NOTE — changes that live on the SCRAPED SQLite side (NOT this DB),
-- handled as a separate server task:
--   * add column  oosSince INTEGER  to PRODUCTS in shoes.db / watches.db
--     (set when availability first goes 1->0, cleared on restock)
--   * create shoes_archive.db / watches_archive.db (same PRODUCTS schema)
--   * archive job: move rows with oosSince older than ~60 days to archive;
--     resurrect back to live on restock  (replaces lossy clean-old-oos delete)
--   * sync-feed + storefront read LIVE only; universal search reads
--     LIVE + ARCHIVE (archive is invisible to the plugin by design)
-- =====================================================================
