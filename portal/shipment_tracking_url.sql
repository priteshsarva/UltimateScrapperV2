-- Courier tracking LINK on a shipment, so the buyer can follow the parcel.
-- Vendors who ship through an aggregator (JD Web & Ship, Selloship, Delhivery…)
-- get a tracking URL, not parcel photos — this is where that link lives.
-- No migration tool: apply by hand in the Supabase SQL editor.
alter table shipments add column if not exists tracking_url text;

-- Set once when the buyer has been told about this tracking number, so adding a
-- courier name later doesn't re-send the "your order has shipped" email.
alter table shipments add column if not exists buyer_notified_at timestamptz;
