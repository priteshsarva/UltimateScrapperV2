-- JD Web & Ship (jdwebnship.in) fulfilment, PER STORE — same reasoning as
-- selloship.sql: their COD goes to the account that booked the shipment.
--
-- CREDENTIALS, and why this differs from Selloship: JD issues a Bearer token that
-- expires, and the ONLY way to renew it is email + password. So unlike Selloship
-- (where vendor_id + email derive the key) we must keep the vendor's JD password.
-- It is stored ENCRYPTED (AES-256-GCM, key derived from JWT_SECRET) — never in
-- plain text, which is what their own plugin does in wp_options.
-- Rotating JWT_SECRET makes stored JD passwords undecryptable; vendors reconnect.
--
-- Additive & idempotent — apply by hand in the Supabase SQL editor.

alter table enrollments add column if not exists jd_email         text;
alter table enrollments add column if not exists jd_password_enc  text;   -- AES-256-GCM, iv:tag:ciphertext
alter table enrollments add column if not exists jd_user_id       text;   -- their retailer id; changing it means a different JD account
alter table enrollments add column if not exists jd_token         text;   -- cached Bearer, refreshed on 401
alter table enrollments add column if not exists jd_webhook_token text;   -- per store: identifies the store on an inbound webhook
alter table enrollments add column if not exists jd_connected_at  timestamptz;
alter table enrollments add column if not exists jd_auto_push     boolean not null default false;

-- One store per webhook token: the token IS how an inbound JD call is attributed.
create unique index if not exists idx_enrollments_jd_webhook_token
  on enrollments(jd_webhook_token) where jd_webhook_token is not null;

-- The carrier's OWN status for a parcel, verbatim ('in_transit', 'ofd', 'rto',
-- 'ndr', 'delivered'…). shipments.status stays our 3-value payout-proof state;
-- this is the delivery state, which is what the buyer actually wants to see.
alter table shipments add column if not exists carrier_status     text;
alter table shipments add column if not exists carrier_status_at  timestamptz;
