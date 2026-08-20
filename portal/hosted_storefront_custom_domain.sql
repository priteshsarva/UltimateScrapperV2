-- Phase 2 — custom-domain support for hosted storefronts.
-- Each hosted enrollment can have zero or one custom domain (e.g. aquawatch.com).
-- verified_at is set once the platform admin confirms DNS points at the host.
alter table enrollments
  add column if not exists custom_domain text,
  add column if not exists custom_domain_verified_at timestamptz;

-- lower-cased, unique when set; nullable when not.
create unique index if not exists idx_enrollments_custom_domain_lower
  on enrollments (lower(custom_domain))
  where custom_domain is not null;
