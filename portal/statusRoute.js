// Plugin-facing status + demo renewal. Keyed by x-enrollment-key, but unlike
// requireEnrollmentKey it does NOT block expired keys — the plugin needs to read
// its own expiry/status (even when expired) to show a countdown and run the
// 3-day grace removal.
//
// Mount in index.js BEFORE the productRoutes line so /product/status and
// /product/renew-demo are handled here (productRoutes has a /:id catch-all):
//   import statusRoute from "./portal/statusRoute.js";
//   app.use("/product", statusRoute);
//   app.use("/product", tenantIdentify, productRoutes);
import { Router } from "express";
import { query } from "./db.js";

const router = Router();

function normDomain(d) {
  if (!d) return "";
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0];
  return h;
}

async function enrollmentByKey(key) {
  if (!key) return null;
  return (await query(
    `select id, domain, status, expiry_date, renewal_date, last_sync_at, last_mismatch_domain
       from enrollments where enrollment_key = $1`,
    [key]
  )).rows[0] || null;
}

// record where the key is being used from (mirrors the sync-feed gate)
async function trackDomain(enr, sent) {
  if (!sent) return true;
  const ok = sent === normDomain(enr.domain);
  if (ok) {
    query(`update enrollments set last_seen_domain=$1, last_seen_at=now() where id=$2`, [sent, enr.id]).catch(() => {});
  } else {
    try {
      if (enr.last_mismatch_domain !== sent) {
        await query(
          `insert into audit_log (actor, action, target)
           values ($1,'Key used from unrecognized domain',$2)`,
          [enr.domain, sent]
        );
      }
      await query(`update enrollments set last_mismatch_domain=$1, last_mismatch_at=now() where id=$2`, [sent, enr.id]);
    } catch (e) { /* never break status on tracking */ }
  }
  return ok;
}

// GET /product/status  -> status, expiry, days_left, and the enrolled sources
router.get("/status", async (req, res) => {
  try {
    const enr = await enrollmentByKey(req.headers["x-enrollment-key"]);
    if (!enr) return res.status(401).json({ error: "Invalid enrollment key" });

    // record + check the calling domain (does not block; the plugin shows the message)
    const sent = normDomain(req.headers["x-site-domain"]);
    const domain_ok = sent ? await trackDomain(enr, sent) : true;

    const sources = (await query(
      `select es.source_id, es.categories, s.name, s.category, s.search_key
         from enrollment_sources es
         join sources s on s.id = es.source_id
        where es.enrollment_id = $1
        order by s.name`,
      [enr.id]
    )).rows;

    const days_left = enr.expiry_date
      ? Math.ceil((new Date(enr.expiry_date).getTime() - Date.now()) / 86400000)
      : null;

    res.json({
      domain: enr.domain,
      registered_domain: enr.domain,
      domain_ok,
      status: enr.status,
      expiry_date: enr.expiry_date,
      renewal_date: enr.renewal_date,
      last_sync_at: enr.last_sync_at,
      days_left,
      sources,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /product/renew-demo  -> DEMO ONLY: extends expiry +1 month and reactivates.
// Replace with the real Pay0 webhook once payments are wired.
router.post("/renew-demo", async (req, res) => {
  try {
    const enr = await enrollmentByKey(req.headers["x-enrollment-key"]);
    if (!enr) return res.status(401).json({ error: "Invalid enrollment key" });

    const now = new Date();
    const base = enr.expiry_date && new Date(enr.expiry_date) > now ? new Date(enr.expiry_date) : now;
    const next = new Date(base);
    next.setMonth(next.getMonth() + 1);

    await query(
      `update enrollments set expiry_date = $1, status = 'active' where id = $2`,
      [next.toISOString(), enr.id]
    );
    res.json({ ok: true, expiry_date: next.toISOString(), status: "active" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;