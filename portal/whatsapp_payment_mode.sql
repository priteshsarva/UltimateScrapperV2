-- "Buy with WhatsApp" payment mode + admin lock.
--   site_settings.payment_mode  : the vendor's own choice (all plans).
--   enrollments.payment_locked  : superadmin forces WhatsApp-only AND freezes the
--                                 vendor's payment settings (they can't change it).
-- Additive & idempotent — apply by hand in the Supabase SQL editor.

alter table site_settings add column if not exists payment_mode   text    not null default 'online';  -- 'online' | 'whatsapp'
alter table enrollments   add column if not exists payment_locked  boolean not null default false;     -- admin WhatsApp-only lock
