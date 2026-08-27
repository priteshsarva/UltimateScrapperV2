-- Per-enrollment secret used to prove custom-domain ownership. The old verify
-- step just fetched the domain and looked for `<div id="root">` — a marker
-- present on the platform's OWN storefront and every Vite site — so any vendor
-- could claim (and get verified for) another vendor's domain or platform
-- subdomain and hijack their storefront + checkout. Verification now requires
-- proving control of THIS token via DNS TXT or a well-known file.
alter table enrollments
  add column if not exists domain_verify_token text;
