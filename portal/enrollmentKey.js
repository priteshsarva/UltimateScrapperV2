// Validates x-enrollment-key and attaches the enrollment's FULL source list.
// One key => one site => many sources (each with its own picked categories).
import { query } from "./db.js";

// strip protocol / www / path / port so "https://www.Stylenova.com/shop" -> "stylenova.com"
function normDomain(d) {
  if (!d) return "";
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0];
  return h;
}
const STRICT_DOMAIN = process.env.STRICT_DOMAIN_LOCK === "true";

export async function requireEnrollmentKey(req, res, next) {
  try {
    const key = req.headers["x-enrollment-key"];
    if (!key) return res.status(401).json({ error: "Missing enrollment key" });

    const enr = (await query(
      `select id, user_id, domain, status, expiry_date
         from enrollments where enrollment_key = $1`,
      [key]
    )).rows[0];
    if (!enr) return res.status(401).json({ error: "Invalid enrollment key" });

    // expiry / status gate (flip to expired once, like before)
    if (enr.expiry_date && new Date(enr.expiry_date) < new Date()) {
      if (enr.status !== "expired") {
        await query(`update enrollments set status='expired' where id=$1`, [enr.id]);
      }
      return res.status(403).json({ error: "Enrollment expired" });
    }
    if (enr.status !== "active") {
      return res.status(403).json({ error: `Enrollment ${enr.status}` });
    }

    // domain lock: the plugin sends its site domain; it must match the enrollment's.
    // Enforced when the header is present; if absent, allowed unless STRICT_DOMAIN_LOCK=true.
    const sentDomain = req.headers["x-site-domain"];
    if (sentDomain) {
      if (normDomain(sentDomain) !== normDomain(enr.domain)) {
        return res.status(403).json({ error: "This key is locked to a different domain." });
      }
    } else if (STRICT_DOMAIN) {
      return res.status(403).json({ error: "Missing site domain." });
    }

    // all sources on this enrollment
    let sources = (await query(
      `select es.source_id, es.categories,
              s.category as source_category, s.search_key
         from enrollment_sources es
         join sources s on s.id = es.source_id
        where es.enrollment_id = $1`,
      [enr.id]
    )).rows;

    // fallback for any legacy enrollment that has no child rows yet
    if (!sources.length) {
      sources = (await query(
        `select e.source_id, e.categories,
                s.category as source_category, s.search_key
           from enrollments e
           join sources s on s.id = e.source_id
          where e.id = $1 and e.source_id is not null`,
        [enr.id]
      )).rows;
    }
    if (!sources.length) return res.status(403).json({ error: "No sources on this enrollment" });

    req.enrollment = {
      id: enr.id,
      userId: enr.user_id,
      domain: enr.domain,
      sources: sources.map((r) => ({
        sourceId: r.source_id,
        sourceCategory: r.source_category,
        searchKey: r.search_key,
        categories: r.categories || [],
      })),
    };

    // stamp last sync (fire and forget)
    query(`update enrollments set last_sync_at = now() where id = $1`, [enr.id]).catch(() => {});
    next();
  } catch (e) {
    console.error("requireEnrollmentKey error", e);
    res.status(500).json({ error: e.message });
  }
}
