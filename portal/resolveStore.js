// Resolve :slug -> the hosted enrollment it belongs to. Mount at the top of
// every /store/:slug/* route. Only an ACTIVE hosted enrollment is a live store —
// pending/rejected/expired all read as "not found" to a browsing shopper.
//
// Custom domains: when the client sends `X-Store-Host: aquawatch.com` (which
// the storefront SPA does on every /store/* call), we try that against
// enrollments.custom_domain FIRST — only if no verified custom domain matches
// do we fall back to the URL segment slug. That way one deployed SPA can serve
// slug.platform.com AND aquawatch.com from the same code, no reconfig.
import { query } from "./db.js";

function normalizeHost(h) {
  if (!h) return "";
  return String(h).trim().toLowerCase().split(":")[0].replace(/^www\./, "");
}

export async function resolveStore(req, res, next) {
  const slug = String(req.params.slug || "").toLowerCase();
  const host = normalizeHost(req.headers["x-store-host"]);

  // custom-domain match wins when the client is really at the vendor's own
  // domain. Only verified custom domains resolve — unverified means the vendor
  // hasn't proved DNS yet; we don't want to accidentally serve someone else's slug.
  let enr = null;
  if (host) {
    const { rows } = await query(
      `select id, user_id, slug, status, expiry_date
         from enrollments
        where type = 'hosted' and lower(custom_domain) = $1
          and custom_domain_verified_at is not null`,
      [host]
    );
    enr = rows[0] || null;
  }

  // fall back to the URL-segment slug (subdomains, local dev ?store=)
  if (!enr) {
    const { rows } = await query(
      `select id, user_id, slug, status, expiry_date
         from enrollments where slug = $1 and type = 'hosted'`,
      [slug]
    );
    enr = rows[0] || null;
  }

  if (!enr) return res.status(404).json({ error: "Store not found" });
  if (enr.status !== "active")
    return res.status(404).json({ error: "Store not available", status: enr.status });
  req.storeEnrollment = enr;
  next();
}
