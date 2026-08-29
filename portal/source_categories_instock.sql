-- Track in-stock product count per source category (total already tracked as
-- product_count). Lets us flag categories that have products but none in stock.
alter table source_categories add column if not exists in_stock_count int not null default 0;
