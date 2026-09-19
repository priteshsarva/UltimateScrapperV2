-- Cloudflare for SaaS: remember the Custom Hostname id we created for a vendor's
-- domain, so we can poll its status (cert/routing) and delete it when the vendor
-- changes or clears the domain. Legacy self-verify columns (custom_domain,
-- custom_domain_verified_at, domain_verify_token) stay as-is.
alter table enrollments add column if not exists custom_hostname_id text;
