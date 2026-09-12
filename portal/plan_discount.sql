-- Optional discounted price for a plan. NULL/absent = no discount (charge price).
-- Absolute amount in the plan's currency, applied every billing cycle. Additive;
-- apply by hand in the Supabase SQL editor.
alter table plans add column if not exists discount_price numeric;
