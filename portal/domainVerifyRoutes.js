// Spoof-proof domain check: the server fetches https://<domain>/wp-json/spp/v1/verify
// and confirms the SHA-256 of the key the store reports matches the key we issued.
// An attacker can forge the x-site-domain header, but cannot make someone else's
// domain serve the right key hash — so this proves the key truly lives on that domain.
//
// Mount:  app.use("/portal/admin", domainVerifyRoutes)
import { Router } from "express";
import crypto from "crypto";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

function normDomain(d) {
  if (!d) return "";
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0];
  return h;
}

async function fetchVerify(host) {
  // Try pretty permalinks first, then the ?rest_route= form (works when the site
  // uses "Plain" permalinks, a very common cause of /wp-json/ 404s).
  const urls = [
    `https://${host}/wp-json/spp/v1/verify`,
    `https://${host}/?rest_route=/spp/v1/verify`,
  ];
  let lastErr = "";
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      clearTimeout(t);
      if (r.ok) return { body: await r.json() };
      lastErr = `HTTP ${r.status} at ${url}`;
    } catch (e) { lastErr = `${e.message}`; }
  }
  return { error: lastErr };
}

async function runVerify(enr) {
  const host = normDomain(enr.domain);
  if (!host) return { ok: false, msg: "No domain on this enrollment." };

  const { body, error } = await fetchVerify(host);
  if (error) return { ok: false, msg: `Couldn't reach the plugin's verify endpoint (${error}). Is the plugin v3.1.0 installed and the site public?` };
  if (!body || typeof body !== "object") return { ok: false, msg: "Verify endpoint returned no JSON." };
  if (!body.has_key) return { ok: false, msg: "Plugin is installed but no key is set on that site." };

  const expected = crypto.createHash("sha256").update(enr.enrollment_key).digest("hex");
  if (body.key_hash !== expected) {
    return { ok: false, msg: "The site is running the plugin, but with a DIFFERENT key than the one issued for this domain." };
  }
  if (body.domain && normDomain(body.domain) !== host) {
    return { ok: false, msg: `Plugin reports domain ${body.domain}, expected ${host}.` };
  }
  return { ok: true, msg: `Verified — ${host} is running the plugin with the correct key.` };
}

// POST /portal/admin/enrollments/:id/verify-domain
router.post("/enrollments/:id/verify-domain", async (req, res) => {
  try {
    const enr = (await query(
      `select id, domain, enrollment_key from enrollments where id = $1`,
      [req.params.id]
    )).rows[0];
    if (!enr) return res.status(404).json({ error: "Enrollment not found" });

    const result = await runVerify(enr);

    await query(
      `update enrollments
          set domain_verified = $1, domain_verified_at = now(), domain_verify_msg = $2
        where id = $3`,
      [result.ok, result.msg, enr.id]
    );
    await query(
      `insert into audit_log (actor, action, target)
       values ($1, $2, $3)`,
      [req.user.email, result.ok ? "Domain verified" : "Domain verification failed", enr.domain]
    );

    res.json({ ok: result.ok, message: result.msg, verified: result.ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
