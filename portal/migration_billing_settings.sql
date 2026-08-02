-- =====================================================================
-- Migration: bring the schema in line with the code, and add the
-- settings table that backs the admin SMTP + payment config pages.
-- Idempotent — every statement is IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS, so it is safe to run on a database that has already been
-- hand-migrated (the live Supabase DB likely has most of this).
-- Run in the Supabase SQL editor. There is no migration tool.
-- =====================================================================

-- ---- users: the fields signup already collects ----------------------
alter table users add column if not exists mobile                 text;
alter table users add column if not exists whatsapp_number        text;
alter table users add column if not exists whatsapp_community_url  text;
alter table users add column if not exists social_urls            jsonb not null default '{}'::jsonb;

-- ---- plans: referenced everywhere but never had a CREATE ------------
create table if not exists plans (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  price          numeric not null default 0,
  currency       text not null default 'INR',
  interval       text not null default 'month'   check (interval in ('day','week','month','year')),
  interval_count int  not null default 1,
  description    text,
  active         boolean not null default true,
  sort_order     int not null default 0,
  created_at     timestamptz not null default now()
);

-- ---- enrollments (shops): the plan + last-seen tracking columns -----
alter table enrollments add column if not exists plan_id              uuid references plans(id);
alter table enrollments add column if not exists last_seen_domain     text;
alter table enrollments add column if not exists last_seen_at         timestamptz;
alter table enrollments add column if not exists last_mismatch_domain text;
alter table enrollments add column if not exists last_mismatch_at     timestamptz;
alter table enrollments add column if not exists renewal_date         timestamptz;

-- ---- invoices: the per-cycle billing columns -----------------------
alter table invoices add column if not exists plan_id       uuid references plans(id);
alter table invoices add column if not exists period_start  timestamptz;
alter table invoices add column if not exists period_end    timestamptz;
alter table invoices add column if not exists due_date      timestamptz;
alter table invoices add column if not exists invoice_no    text;
alter table invoices add column if not exists last_reminder_at timestamptz;

-- invoice number sequence + the dedup index billing.js relies on
create sequence if not exists invoice_no_seq;
create unique index if not exists invoices_enrollment_period_uniq
  on invoices (enrollment_id, period_start);

-- ---- app_settings: admin-editable SMTP + payment config -------------
-- One row per config group (key='smtp' | 'payment'), value is JSON.
-- SECRETS LIVE HERE — never expose this table to client-role tokens.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
