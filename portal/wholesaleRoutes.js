// Wholesale marketplace routes.
//   app.use("/portal", wholesaleClientRoutes)      // vendor: apply, my profile, taxonomy
//   app.use("/portal/admin", wholesaleAdminRoutes) // admin: approvals, verify, taxonomy
//
// A wholesaler IS an enrollment (type='wholesale'). On approval we activate the
// enrollment AND create a MANUAL source (id='ws_'||slug) so retailers pick the
// wholesaler in the SAME source picker; nothing downstream changes.
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { upsertSource } from "./sources.js";
import { sendMail } from "./mailer.js";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[wholesale]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop";
async function uniqueSlug(base) {
  let slug = base, n = 1;
  while ((await query(`select 1 from wholesalers where slug=$1`, [slug])).rows.length) slug = `${base}-${++n}`;
  return slug;
}
const genKey = () => "spp_live_" + Array.from({ length: 32 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

// ============================================================ client
const clientRouter = Router();
clientRouter.use(requireAuth);

// My wholesaler profile (+ enrollment status + source id), or null.
clientRouter.get("/wholesale/me", asyncH(async (req, res) => {
  const row = (await query(
    `select w.*, e.status as enrollment_status, e.plan_id, e.payout_mode
       from wholesalers w join enrollments e on e.id = w.enrollment_id
      where w.user_id = $1`,
    [req.user.sub]
  )).rows[0] || null;
  res.json({ wholesaler: row });
}));

// Apply to become a wholesaler. Creates a pending enrollment + profile.
clientRouter.post("/wholesale/apply", asyncH(async (req, res) => {
  const b = req.body || {};
  if (!b.business_name) return res.status(400).json({ error: "business_name required" });
  if ((await query(`select 1 from wholesalers where user_id=$1`, [req.user.sub])).rows.length)
    return res.status(409).json({ error: "You already have a wholesaler account." });

  const slug = await uniqueSlug(slugify(b.slug || b.business_name));
  const enr = (await query(
    `insert into enrollments (user_id, domain, type, slug, enrollment_key, status, plan_id)
     values ($1,$2,'wholesale',$3,$4,'pending',$5) returning id`,
    [req.user.sub, `${slug}.wholesale`, slug, genKey(), b.plan_id || null]
  )).rows[0];

  const w = (await query(
    `insert into wholesalers (enrollment_id, user_id, business_name, slug, gst_number, phone, whatsapp, address, categories, about, logo_url, min_order_qty, ships_from)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [enr.id, req.user.sub, b.business_name, slug, b.gst_number || null, b.phone || null, b.whatsapp || null,
     JSON.stringify(b.address || {}), Array.isArray(b.categories) ? b.categories : [], b.about || null,
     b.logo_url || null, Number(b.min_order_qty) || 1, b.ships_from || null]
  )).rows[0];
  res.json({ wholesaler: w });
}));

// Orders that include THIS wholesaler's products (their sales across all
// retailers). Each carries the wholesaler's own line items + their share.
clientRouter.get("/wholesale/orders", asyncH(async (req, res) => {
  const w = (await query(`select enrollment_id from wholesalers where user_id=$1`, [req.user.sub])).rows[0];
  if (!w) return res.status(403).json({ error: "You don't have a wholesaler account." });
  const orders = (await query(
    `select o.id, o.order_no, o.status, o.payment_status, o.created_at, o.address, o.buyer_name,
            coalesce(s.store_name, e.slug) as store_name, e.slug as store_slug
       from orders o
       join enrollments e on e.id = o.enrollment_id
       left join site_settings s on s.enrollment_id = e.id
      where exists (select 1 from order_items oi where oi.order_id=o.id and oi.supplier_enrollment_id=$1)
      order by o.created_at desc limit 200`,
    [w.enrollment_id]
  )).rows;
  for (const o of orders) {
    o.items = (await query(
      `select product_name, size, qty, cost_price, snapshot from order_items where order_id=$1 and supplier_enrollment_id=$2`,
      [o.id, w.enrollment_id]
    )).rows;
    o.my_total = o.items.reduce((s, it) => s + Number(it.cost_price || 0) * Number(it.qty), 0);
  }
  res.json({ orders });
}));

// Taxonomy the wholesaler can pick from: active subs for a primary category,
// plus their own still-proposed ones. No free text on the storefront side.
clientRouter.get("/taxonomy", asyncH(async (req, res) => {
  const { primary } = req.query;
  const params = [req.user.sub];
  let sql = `select id, primary_cat, sub_slug, sub_label, status from product_taxonomy
              where (status='active' or proposed_by=$1)`;
  if (primary) { params.push(primary); sql += ` and primary_cat=$${params.length}`; }
  sql += ` order by primary_cat, sort_order, sub_label`;
  res.json({ taxonomy: (await query(sql, params)).rows });
}));

// Propose a new sub-category (hidden until an admin approves it).
clientRouter.post("/taxonomy/propose", asyncH(async (req, res) => {
  const { primary_cat, sub_label } = req.body || {};
  if (!primary_cat || !sub_label) return res.status(400).json({ error: "primary_cat and sub_label required" });
  const sub_slug = slugify(sub_label);
  const row = (await query(
    `insert into product_taxonomy (primary_cat, sub_slug, sub_label, status, proposed_by)
     values ($1,$2,$3,'proposed',$4)
     on conflict (primary_cat, sub_slug) do update set sub_label = excluded.sub_label
     returning *`,
    [primary_cat, sub_slug, sub_label, req.user.sub]
  )).rows[0];
  res.json({ sub: row });
}));

// ============================================================ admin
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/wholesalers", asyncH(async (req, res) => {
  const { status } = req.query;
  const params = [];
  let sql = `select w.*, e.status as enrollment_status, e.plan_id, u.email as user_email, u.name as user_name
               from wholesalers w
               join enrollments e on e.id = w.enrollment_id
               join users u on u.id = w.user_id`;
  if (status) { params.push(status); sql += ` where e.status = $${params.length}`; }
  sql += ` order by w.created_at desc`;
  res.json({ wholesalers: (await query(sql, params)).rows });
}));

// Approve: activate the enrollment, verify the wholesaler, and create its MANUAL
// source so retailers can attach it.
adminRouter.post("/wholesalers/:id/approve", asyncH(async (req, res) => {
  const w = (await query(`select * from wholesalers where enrollment_id=$1`, [req.params.id])).rows[0];
  if (!w) return res.status(404).json({ error: "Wholesaler not found" });

  await query(`update enrollments set status='active' where id=$1`, [w.enrollment_id]);
  await query(`update wholesalers set verified=true where enrollment_id=$1`, [w.enrollment_id]);
  await upsertSource({
    id: `ws_${w.slug}`, name: w.business_name, category: "wholesale",
    method: "MANUAL", base_url: null, search_key: `ws_${w.slug}`, status: "active",
  });

  const u = (await query(`select email, name from users where id=$1`, [w.user_id])).rows[0];
  if (u?.email) sendMail({ to: u.email, subject: "Your wholesale account is approved",
    html: `<p>Hi ${u.name || ""}, your wholesale account <b>${w.business_name}</b> is approved. You can now list products in the portal.</p>` }).catch(() => {});
  res.json({ ok: true });
}));

adminRouter.post("/wholesalers/:id/reject", asyncH(async (req, res) => {
  const w = (await query(`select * from wholesalers where enrollment_id=$1`, [req.params.id])).rows[0];
  if (!w) return res.status(404).json({ error: "Wholesaler not found" });
  await query(`update enrollments set status='rejected' where id=$1`, [w.enrollment_id]);
  const reason = (req.body && req.body.reason) || "";
  const u = (await query(`select email, name from users where id=$1`, [w.user_id])).rows[0];
  if (u?.email) sendMail({ to: u.email, subject: "Wholesale application update",
    html: `<p>Hi ${u.name || ""}, your wholesale application was not approved.${reason ? ` Reason: ${reason}` : ""}</p>` }).catch(() => {});
  res.json({ ok: true });
}));

// Toggle verified / gst_verified / pause the source, etc.
adminRouter.patch("/wholesalers/:id", asyncH(async (req, res) => {
  const b = req.body || {};
  const w = (await query(`select * from wholesalers where enrollment_id=$1`, [req.params.id])).rows[0];
  if (!w) return res.status(404).json({ error: "Wholesaler not found" });
  const sets = [], params = [];
  for (const f of ["verified", "gst_verified", "min_order_qty", "about", "ships_from"]) {
    if (f in b) { params.push(b[f]); sets.push(`${f}=$${params.length}`); }
  }
  if (sets.length) { params.push(w.enrollment_id); await query(`update wholesalers set ${sets.join(", ")} where enrollment_id=$${params.length}`, params); }
  if ("source_status" in b) await query(`update sources set status=$1 where id=$2`, [b.source_status, `ws_${w.slug}`]);
  res.json({ ok: true });
}));

// Taxonomy management
adminRouter.get("/taxonomy", asyncH(async (req, res) => {
  res.json({ taxonomy: (await query(`select t.*, u.email as proposed_email from product_taxonomy t left join users u on u.id=t.proposed_by order by primary_cat, sort_order, sub_label`)).rows });
}));
adminRouter.post("/taxonomy", asyncH(async (req, res) => {
  const { primary_cat, sub_label, sort_order } = req.body || {};
  if (!primary_cat || !sub_label) return res.status(400).json({ error: "primary_cat and sub_label required" });
  const sub_slug = slugify(sub_label);
  const row = (await query(
    `insert into product_taxonomy (primary_cat, sub_slug, sub_label, status, sort_order)
     values ($1,$2,$3,'active',$4)
     on conflict (primary_cat, sub_slug) do update set sub_label=excluded.sub_label, status='active', sort_order=excluded.sort_order
     returning *`,
    [primary_cat, sub_slug, sub_label, Number(sort_order) || 0]
  )).rows[0];
  res.json({ sub: row });
}));
adminRouter.patch("/taxonomy/:id", asyncH(async (req, res) => {
  const { status, sub_label, sort_order } = req.body || {};
  const sets = [], params = [];
  if (status) { params.push(status); sets.push(`status=$${params.length}`); }
  if (sub_label) { params.push(sub_label); sets.push(`sub_label=$${params.length}`); }
  if (sort_order != null) { params.push(Number(sort_order) || 0); sets.push(`sort_order=$${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });
  params.push(req.params.id);
  res.json({ sub: (await query(`update product_taxonomy set ${sets.join(", ")} where id=$${params.length} returning *`, params)).rows[0] });
}));
adminRouter.delete("/taxonomy/:id", asyncH(async (req, res) => {
  await query(`delete from product_taxonomy where id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

export { clientRouter as wholesaleClientRoutes, adminRouter as wholesaleAdminRoutes };
