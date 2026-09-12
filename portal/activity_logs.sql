-- Login-attempt + email logs (the rest of the logs epic; search log already
-- lives in catalogue_activity). Additive; apply by hand in Supabase.
create table if not exists login_attempts (
  id         bigserial primary key,
  identifier text,                       -- email or mobile that was tried
  method     text,                       -- 'password' | 'otp'
  user_id    uuid references users(id) on delete set null,
  success    boolean not null default false,
  reason     text,                       -- why it failed
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists idx_login_attempts_created on login_attempts(created_at desc);
create index if not exists idx_login_attempts_identifier on login_attempts(identifier);

create table if not exists email_log (
  id         bigserial primary key,
  to_email   text,
  to_name    text,
  to_mobile  text,
  subject    text,
  reason     text,                        -- why it was sent (order, reminder, welcome, payout…)
  success    boolean not null default false,
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists idx_email_log_created on email_log(created_at desc);
