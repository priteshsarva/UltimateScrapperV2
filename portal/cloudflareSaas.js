// Cloudflare for SaaS (Custom Hostnames) — lets a vendor point their own domain
// (aquawatch.com) at their storefront with automatic SSL, Netlify-style: they add
// a CNAME + a validation TXT at their registrar, Cloudflare issues the cert and
// routes the domain to our storefront Worker (via the zone's fallback origin).
//
// Secrets live in .env.local (gitignored): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID.
// CUSTOM_DOMAIN_TARGET is the fallback-origin hostname vendors CNAME to
// (e.g. store.thekartify.com). If the token/zone aren't set, cfConfigured() is
// false and callers fall back to the legacy self-verify flow (dev / no-CF).
import "dotenv/config";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const ZONE = process.env.CLOUDFLARE_ZONE_ID || "";
const CNAME_TARGET = (process.env.CUSTOM_DOMAIN_TARGET || process.env.PLATFORM_HOST || "")
  .toLowerCase().replace(/^\.+|\.+$/g, "");

export const cfConfigured = () => !!(TOKEN && ZONE);

async function cf(path, { method = "GET", body } = {}) {
  if (!cfConfigured()) throw new Error("Custom domains aren't configured on the server.");
  const res = await fetch(`${API}/zones/${ZONE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const err = new Error(data?.errors?.[0]?.message || `Cloudflare API ${res.status}`);
    err.cf = data;
    throw err;
  }
  return data.result;
}

// Create (or return an error if it already exists — caller reuses via get). TXT
// domain-control validation so the vendor gets explicit records to paste.
export function createCustomHostname(hostname) {
  return cf(`/custom_hostnames`, {
    method: "POST",
    body: { hostname, ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.0" } } },
  });
}
export function getCustomHostname(id) { return cf(`/custom_hostnames/${id}`); }
export async function deleteCustomHostname(id) {
  if (!id) return null;
  try { return await cf(`/custom_hostnames/${id}`, { method: "DELETE" }); }
  catch { return null; } // already gone / never created — deleting is best-effort
}

// The copy-paste DNS records the vendor adds at their registrar: the CNAME to our
// fallback origin, plus every domain-control-validation record Cloudflare needs to
// issue the certificate.
export function dnsRecordsFor(hostname, ch) {
  const recs = [
    { type: "CNAME", host: hostname, value: CNAME_TARGET,
      note: "Points your domain at your storefront (use ALIAS/ANAME if this is a root domain)" },
  ];
  const seen = new Set();
  const add = (r) => {
    if (r && r.txt_name && r.txt_value && !seen.has(r.txt_name)) {
      seen.add(r.txt_name);
      recs.push({ type: "TXT", host: r.txt_name, value: r.txt_value, note: "Validates your domain for HTTPS" });
    }
  };
  add(ch?.ownership_verification);
  for (const v of (ch?.ssl?.validation_records || [])) add(v);
  return recs;
}

// Fully live = hostname active (routing) AND its cert active (HTTPS).
export const isActive = (ch) => ch?.status === "active" && ch?.ssl?.status === "active";
export const statusOf = (ch) => ({ hostname: ch?.status || "unknown", ssl: ch?.ssl?.status || "unknown" });
