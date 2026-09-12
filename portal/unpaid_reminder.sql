-- Throttle for the scheduled "finish paying your order" reminder emails
-- (one per day per unpaid order). Additive; apply by hand in Supabase.
alter table orders add column if not exists last_pay_reminder_at timestamptz;
