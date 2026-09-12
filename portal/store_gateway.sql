-- Storefront payment gateway (customer -> store). Per-site collector, admin-
-- switchable; default pay0 (platform's Pay0 account, auto-verified). Higher-tier
-- plans may store their own gateway creds in gateway_config. Additive; apply by
-- hand in Supabase.
alter table enrollments add column if not exists store_gateway text default 'pay0';
alter table enrollments add column if not exists gateway_config jsonb;
alter table orders add column if not exists gateway_order_id text;
alter table orders add column if not exists gateway_payment_url text;
