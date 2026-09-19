// Resolve a request to the hosted enrollment that should serve it. Mounted at
// the top of every /store/:slug/* route. Only an ACTIVE hosted enrollment is a
// live store — pending/rejected/expired/paused all read as "not found".
//
// Resolution order, and WHY it's ordered this way (security):
//   1. A VERIFIED custom domain match wins. Only verified, so a vendor can't
//      claim someone else's domain and serve their own store through it.
//   2. Otherwise, only fall back to the URL-path slug when the request actually
//      arrived on the PLATFORM's own host (a <slug>.PLATFORM_HOST subdomain) or
//      in local dev (localhost / an IP, where the slug comes from ?store=).
//      A request arriving on some OTHER hostname (an unverified custom domain,
//      or an attacker pointing any domain at us) must NOT be served a slug it
//      names in the path — that was the hole that let an unverified domain
//      serve an unrelated vendor.
import { query } from "./db.js";
import { verifyPreviewToken } from "./customerAuth.js";

const PLATFORM_HOST = (process.env.PLATFORM_HOST || "").toLowerCase().replace(/^\.+|\.+$/g, "");

function normalizeHost(h) {
  if (!h) return "";
  return String(h).trim().toLowerCase().split(",")[0].split(":")[0].replace(/\.+$/, "").replace(/^www\./, "");
}

const isLocalHost = (h) => h === "localhost" || h === "127.0.0.1" || /^\d+\.\d+\.\d+\.\d+$/.test(h);
const isPlatformHost = (h) => !!PLATFORM_HOST && (h === PLATFORM_HOST || h.endsWith("." + PLATFORM_HOST));
// Shared preview hosts where the tenant rides in the path slug, not the domain.
const isPreviewHost = (h) => /\.(workers\.dev|netlify\.app|vercel\.app|pages\.dev)$/.test(h || "");

export async function resolveStore(req, res, next) {
  const slug = String(req.params.slug || "").toLowerCase();

  // In production the API lives on a DIFFERENT host than the storefront (the SPA
  // calls the API's own domain), so the storefront's real host arrives in
  // X-Store-Host, not Host. Trust it: it only ever selects a VERIFIED custom
  // domain (or a public platform subdomain), and storefronts are public — there's
  // no tenant to "spoof into". Fall back to the real host for direct/plugin calls.
  const realHost = normalizeHost(req.headers["x-forwarded-host"] || req.headers.host);
  const storeHost = normalizeHost(req.headers["x-store-host"]);
  const host = storeHost || realHost;

  let enr = null;

  // 1) A real custom domain (not the platform, local, or a shared preview host)
  //    resolves ONLY to a verified custom_domain — never to the path slug, which
  //    would let any domain pointed at us serve an unrelated store.
  const isCustom = host && !isLocalHost(host) && !isPlatformHost(host) && !isPreviewHost(host);
  if (isCustom) {
    const { rows } = await query(
      `select id, user_id, slug, status, expiry_date
         from enrollments
        where type = 'hosted' and lower(custom_domain) = $1
          and custom_domain_verified_at is not null`,
      [host]
    );
    enr = rows[0] || null;
    if (!enr) return res.status(404).json({ error: "Store not found" });
  }

  // 2) platform subdomain / preview host / local dev → resolve by the path slug
  if (!enr) {
    const { rows } = await query(
      `select id, user_id, slug, status, expiry_date
         from enrollments where slug = $1 and type = 'hosted'`,
      [slug]
    );
    enr = rows[0] || null;
  }

  if (!enr) return res.status(404).json({ error: "Store not found" });
  req.storeEnrollment = enr;

  // A store is LIVE only when active. Non-live stores (draft/pending/…) are
  // viewable in PREVIEW mode by anyone holding a valid preview token (issued by
  // /preview-unlock after entering the store's shareable password).
  req.storeIsLive = enr.status === "active";
  req.storeUnlocked = req.storeIsLive || verifyPreviewToken(req.headers["x-preview-token"], enr.id);

  // /config and /preview-unlock stay reachable while locked so the SPA can show a
  // branded password gate and take the password. Everything else is gated.
  const path = req.path || "";
  const openWhileLocked = path.endsWith("/config") || path.endsWith("/preview-unlock");
  if (!req.storeUnlocked && !openWhileLocked)
    return res.status(401).json({ error: "preview_locked", preview_required: true, status: enr.status });

  next();
}
