// Admin "Clients" — every registered client with ALL the info collected at
// signup (mobile, whatsapp, social links) plus their shop and billing rollup.
//   app.use("/portal/admin", adminUsersRoutes)   ->  GET /portal/admin/users
import { Router } from "express";
import crypto from "crypto";
import { query } from "./db.js";
import { requireAuth, requireAdmin, hashPassword } from "./auth.js";

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
         count(distinct e.id) filter (where e.type = 'hosted')           as storefronts,
         coalesce(json_agg(distinct e.domain) filter (where e.domain is not null), '[]') as domains,
         coalesce(json_agg(distinct jsonb_build_object('slug', e.slug, 'status', e.status))
                  filter (where e.type = 'hosted' and e.slug is not null), '[]') as sites,
         count(distinct o.id)                                            as orders,
         coalesce(sum(o.total), 0)                                       as order_sales,
         coalesce(sum(i.amount) filter (where i.status = 'paid'), 0)     as paid_total,
         count(distinct i.id) filter (where i.status in ('created','pending')) as unpaid_invoices
       from users u
       left join enrollments e on e.user_id = u.id
       left join invoices   i on i.user_id = u.id
       left join orders     o on o.enrollment_id = e.id
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

// POST /portal/admin/users/:id/set-password  { password? }
// Super-admin resets a client's password. With no password, a temporary one is
// generated and returned so the admin can pass it to the user to log in + change.
router.post("/users/:id/set-password", async (req, res) => {
  try {
    let { password } = req.body || {};
    let generated = null;
    if (!password) { password = "Spp-" + crypto.randomBytes(4).toString("hex"); generated = password; }
    if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hash = await hashPassword(password);
    const { rowCount, rows } = await query(
      `update users set password_hash=$1 where id=$2 and role='client' returning email`,
      [hash, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, email: rows[0].email, temp_password: generated });
  } catch (e) {
    console.error("[admin/users/set-password]", e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
