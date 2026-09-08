-- Search-landing follow-up: track OTP-verified numbers + whether they finished
-- creating a full account. Existing accounts default to "complete" so only the
-- new mobile-first signups can show as incomplete. Apply by hand in Supabase.
alter table users add column if not exists mobile_verified  boolean not null default false;
alter table users add column if not exists profile_complete boolean not null default true;
