-- Pro-grade behaviour analytics. store_events now carries a per-event `path`, and
-- these event types in addition to the originals:
--   page_view | page_leave | click | impression | view_item | add_to_cart |
--   begin_checkout | search | purchase
-- page_leave.meta.duration_ms = time spent on that page; click.meta.label/href =
-- what was clicked; impression rows = products shown on screen.
-- Additive & idempotent — apply by hand in the Supabase SQL editor.

alter table store_events add column if not exists path text;

-- session-timeline reads (the visitor explorer) scan by session, oldest-first.
create index if not exists idx_store_events_session on store_events(enrollment_id, session_id, created_at);
-- page / click / impression rollups already covered by idx_store_events_enr_event.
