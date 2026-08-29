-- Lightweight notification feed. audience: 'all_clients' (every client) or
-- 'admin'. Unread state is tracked client-side via a last-seen timestamp.
create table if not exists platform_notifications (
  id         uuid primary key default gen_random_uuid(),
  audience   text not null default 'all_clients' check (audience in ('all_clients','admin')),
  type       text,
  title      text not null,
  body       text,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_platform_notif_created on platform_notifications(created_at desc);
