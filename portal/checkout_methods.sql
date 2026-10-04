-- Checkout methods: Prepaid / COD / Semi-COD (+ COD fee, prepaid discount).
-- Vendor config lives in site_settings.checkout; per-order split on orders.
-- Additive & idempotent — apply by hand in the Supabase SQL editor.

alter table site_settings add column if not exists checkout jsonb not null default '{}'::jsonb;
-- checkout = { methods:{prepaid,cod,semicod}, default, cod_fee, prepaid_discount,
--             advance_type:'percent'|'fixed', advance_value }

alter table orders add column if not exists payment_method   text          not null default 'prepaid'; -- prepaid | cod | semicod
alter table orders add column if not exists online_amount    numeric(12,2) not null default 0;         -- collected/collectable online
alter table orders add column if not exists cod_due          numeric(12,2) not null default 0;         -- cash to collect at delivery
alter table orders add column if not exists cod_fee          numeric(12,2) not null default 0;         -- extra COD charge added to total
alter table orders add column if not exists prepaid_discount numeric(12,2) not null default 0;         -- discount given on a prepaid order
