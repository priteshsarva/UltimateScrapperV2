// Admin overview of every enrollment: domain, owner, status, expiry/days-left,
// and the sources each store is enrolled for.
// Mount:  app.use("/portal/admin", adminEnrollmentOverview)
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /portal/admin/enrollment-overview
router.get("/enrollment-overview", async (req, res) => {
  try {
    const enrs = (await query(
      `select e.id, e.domain, e.status, e.expiry_date, e.renewal_date, e.last_sync_at,
              e.enrollment_key, u.email as owner_email
         from enrollments e
         left join users u on u.id = e.user_id
        order by e.expiry_date asc nulls last`
    )).rows;

    for (const e of enrs) {
      e.sources = (await query(
        `select es.source_id, es.categories, s.name, s.category
           from enrollment_sources es
           join sources s on s.id = es.source_id
          where es.enrollment_id = $1
          order by s.name`,
        [e.id]
      )).rows;
      e.days_left = e.expiry_date
        ? Math.ceil((new Date(e.expiry_date).getTime() - Date.now()) / 86400000)
        : null;
    }

    res.json({ enrollments: enrs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
