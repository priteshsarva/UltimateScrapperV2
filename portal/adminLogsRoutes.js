// Admin activity-log viewer: catalogue searches/clicks, login attempts, emails.
//   app.use("/portal/admin", adminLogsRoutes)  ->  GET /portal/admin/logs?type=
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

router.get("/logs", async (req, res) => {
  const type = (req.query.type || "search").toString();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  try {
    if (type === "login") {
      const rows = (await query(
        `select la.*, u.name as user_name, u.email as user_email, u.mobile as user_mobile
           from login_attempts la left join users u on u.id = la.user_id
          order by la.created_at desc limit $1`, [limit]
      )).rows;
      return res.json({ rows });
    }
    if (type === "email") {
      const rows = (await query(`select * from email_log order by created_at desc limit $1`, [limit])).rows;
      return res.json({ rows });
    }
    // default: catalogue searches + product opens, with who did it
    const rows = (await query(
      `select ca.*, u.name as user_name, u.email as user_email, u.mobile as user_mobile
         from catalogue_activity ca left join users u on u.id = ca.user_id
        order by ca.created_at desc limit $1`, [limit]
    )).rows;
    res.json({ rows });
  } catch (e) { console.error("[admin/logs]", e.message); res.status(500).json({ error: e.message }); }
});

export default router;
