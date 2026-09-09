-- Let the admin's own plans drive the search-landing "Plans" list, and let a
-- search-plan payment remember which plan it bought. Additive; apply by hand.
alter table plans add column if not exists show_on_search boolean not null default false;
alter table search_plan_orders add column if not exists plan_id uuid references plans(id) on delete set null;
-- View allowance a plan grants the user while active. NULL/0 = unlimited.
-- The number itself lives on each plan in limits.search_views.
alter table users add column if not exists search_plan_views int;
