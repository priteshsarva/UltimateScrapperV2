-- The admin "Pause storefront" control writes status='paused', but the
-- enrollments CHECK constraint only allowed pending/approved/active/expired/
-- rejected — so Pause always failed with a constraint violation (HTTP 500) and
-- the only working takedown was the destructive Delete.
-- resolveStore already treats anything other than 'active' as not-live, and
-- portal-app-clean/src/ui.jsx already has a badge colour for 'paused'.
alter table enrollments drop constraint if exists enrollments_status_check;
alter table enrollments add constraint enrollments_status_check
  check (status in ('pending','approved','active','paused','expired','rejected'));
