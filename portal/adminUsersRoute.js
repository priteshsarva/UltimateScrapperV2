// Admin "Clients" — every registered client with ALL the info collected at
// signup (mobile, whatsapp, social links) plus their shop and billing rollup.
//   app.use("/portal/admin", adminUsersRoutes)   ->  GET /portal/admin/users
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /portal/admin/users?q=search
router.get("/users", async (req, res) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  try {
    const rows = (await query(
      `select
         u.id, u.email, u.name, u.role, u.status, u.created_at,
         u.mobile, u.whatsapp_number, u.whatsapp_community_url, u.social_urls,
         count(distinct e.id)                                            as shops,
         count(distinct e.id) filter (where e.status = 'active')         as active_shops,
         coalesce(json_agg(distinct e.domain) filter (where e.domain is not null), '[]') as domains,
         coalesce(sum(i.amount) filter (where i.status = 'paid'), 0)     as paid_total,
         count(distinct i.id) filter (where i.status in ('created','pending')) as unpaid_invoices
       from users u
       left join enrollments e on e.user_id = u.id
       left join invoices   i on i.user_id = u.id
      where u.role = 'client'
      group by u.id
      order by u.created_at desc`
    )).rows;

    const filtered = q
      ? rows.filter((r) =>
          [r.email, r.name, r.mobile, r.whatsapp_number, ...(r.domains || [])]
            .some((v) => (v || "").toString().toLowerCase().includes(q)))
      : rows;

    res.json({ users: filtered });
  } catch (e) {
    console.error("[admin/users]", e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
