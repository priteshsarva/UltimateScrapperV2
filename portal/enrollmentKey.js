// =====================================================================
// requireEnrollmentKey — the plugin's authentication.
// REPLACES the old x-client-id tenant resolution for the sync path.
//
// The plugin sends:   x-enrollment-key: spp_live_...
// On success it attaches req.enrollment = {
//   id, userId, domain, sourceId, sourceCategory (shoes|watches),
//   searchKey (productFetchedFrom LIKE), categories (allow-list)
// }
// sync-feed then reads ONLY the live DB for sourceCategory and filters
// to `categories`. Archive DBs are never touched here by design.
// =====================================================================
import { query } from "./db.js";
import { dateISO, todayISO } from "./keys.js";

export async function requireEnrollmentKey(req, res, next) {
  const key =
    req.headers["x-enrollment-key"] ||
    (req.query.key ? String(req.query.key) : null);

  if (!key) return res.status(401).json({ error: "Missing enrollment key" });

  try {
    const { rows } = await query(
      `select e.*,
              s.category   as source_category,
              s.search_key as search_key,
              s.status     as source_status
         from enrollments e
         join sources s on s.id = e.source_id
        where e.enrollment_key = $1`,
      [key]
    );
    const enr = rows[0];
    if (!enr) return res.status(401).json({ error: "Invalid enrollment key" });

    if (enr.status !== "active")
      return res
        .status(403)
        .json({ error: "Enrollment not active", status: enr.status });

    const exp = dateISO(enr.expiry_date);
    if (exp && exp < todayISO()) {
      // lapsed — reflect it so the portal/admin sees 'expired'
      await query(`update enrollments set status='expired' where id=$1`, [enr.id]);
      return res.status(403).json({ error: "Access expired", expiry: exp });
    }

    // touch last_sync_at (fire-and-forget; powers admin "hasn't synced" alerts)
    query(`update enrollments set last_sync_at = now() where id = $1`, [enr.id]).catch(() => {});

    req.enrollment = {
      id: enr.id,
      userId: enr.user_id,
      domain: enr.domain,
      sourceId: enr.source_id,
      sourceCategory: enr.source_category, // which live DB
      searchKey: enr.search_key,           // productFetchedFrom LIKE
      categories: enr.categories || [],    // selected category allow-list
    };
    next();
  } catch (err) {
    console.error("requireEnrollmentKey error:", err);
    return res.status(500).json({ error: "Key validation failed" });
  }
}
