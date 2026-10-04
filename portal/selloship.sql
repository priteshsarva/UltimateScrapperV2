-- Selloship (selloship.com) fulfilment, PER STORE. Each vendor connects their own
-- Selloship account, so COD is remitted to them and their own negotiated rates
-- apply — the platform never collects other people's cash.
--
-- NOTE ON CREDENTIALS: after the one-time login, Selloship's API authenticates
-- every call with md5(vendor_id || account_email). That pair IS the API key, so
-- the vendor's Selloship PASSWORD is never stored — we exchange it once at
-- connect time and drop it. Treat selloship_vendor_id as a secret.
--
-- Additive & idempotent — apply by hand in the Supabase SQL editor.

alter table enrollments add column if not exists selloship_vendor_id   text;
alter table enrollments add column if not exists selloship_email       text;
alter table enrollments add column if not exists selloship_store_name  text;
-- account capability flags from Vendor_login (wholesaler_permission, direct_transfer, preship)
alter table enrollments add column if not exists selloship_flags       jsonb;
alter table enrollments add column if not exists selloship_connected_at timestamptz;

-- The aggregator's own order reference for a shipment, used to poll tracking.
-- Selloship books ONE order per line item, so an order can hold several of these,
-- one shipments row each.
alter table shipments add column if not exists carrier_ref text;
create unique index if not exists idx_shipments_carrier_ref on shipments(carrier_ref) where carrier_ref is not null;

-- OUR reference for the parcel we asked them to book ('ORD-000123-2'), sent as
-- their custom_order_id. Makes a re-push idempotent per parcel: if parcel 2 is
-- already here we skip it, even if parcel 1 failed and is being retried.
alter table shipments add column if not exists carrier_parcel text;
create unique index if not exists idx_shipments_carrier_parcel on shipments(carrier_parcel) where carrier_parcel is not null;
