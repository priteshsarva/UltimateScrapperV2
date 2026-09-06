-- upi_payment.sql — per-vendor UPI collection (manual reconcile, no gateway).
-- The storefront shows the vendor's own UPI QR + deep link at checkout; the
-- buyer pays into the vendor's UPI account directly and sends a screenshot on
-- WhatsApp; the vendor confirms the order by hand. No auto-verification.
-- Additive only — safe on the live portal DB. Apply by hand in the Supabase
-- SQL editor (same as the other portal/*.sql files).

alter table site_settings
  add column if not exists upi_id   text,   -- vendor's UPI VPA — any app (x@ptyes / x@okhdfcbank / x@paytm / x@ybl …)
  add column if not exists upi_name text;   -- payee name shown in the customer's UPI app (blank = store name)
