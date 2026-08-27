-- The shopper's chosen size was being folded into orders.note as free text, which
-- no vendor-facing surface rendered — and it could not disambiguate two sizes of
-- the same product (they collapsed into two identical order lines).
-- Carry it per line item instead.
alter table order_items
  add column if not exists size text;
