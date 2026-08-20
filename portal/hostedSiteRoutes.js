// Hosted storefronts: vendor self-serve (clientRouter) + admin overview (adminRouter).
//   app.use("/portal", clientRouter)         -> /portal/hosted-sites...
//   app.use("/portal/admin", adminRouter)    -> /portal/admin/hosted-sites, /portal/admin/orders
//
// A hosted site IS an enrollment (type='hosted'); approval/activation/expiry
// reuse the EXISTING /portal/admin/enrollments/:id/approve + /activate routes
// in adminRoutes.js untouched — this file only adds what's new: branding
// (site_settings) and orders. site_settings is created eagerly at request time
// (not on approve) so there's nothing to backfill when an admin approves.
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { generateEnrollmentKey } from "./keys.js";
import { PRESETS } from "./storefrontPresets.js";

function slugify(s) {
  return (String(s || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)) || "store";
}

async function uniqueSlug(base) {
  let slug = base, n = 1;
  while ((await query(`select 1 from enrollments where slug=$1`, [slug])).rowCount) {
    slug = `${base}-${++n}`;
  }
  return slug;
}

const asyncH = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error("hostedSiteRoutes error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

async function ownedSite(id, userId) {
  const r = (await query(`select id, user_id, slug from enrollments where id=$1 and type='hosted'`, [id])).rows[0];
  return r && r.user_id === userId ? r : null;
}

// ============================================================ vendor

const clientRouter = Router();
clientRouter.use(requireAuth);

// POST /portal/hosted-sites  { store_name, slug? }  -> pending hosted enrollment
clientRouter.post("/hosted-sites", asyncH(async (req, res) => {
  const { store_name, slug } = req.body || {};
  if (!store_name) return res.status(400).json({ error: "store_name required" });

  const finalSlug = await uniqueSlug(slugify(slug || store_name));
  const enr = (await query(
    `insert into enrollments (user_id, domain, type, slug, enrollment_key, status)
     values ($1,$2,'hosted',$3,$4,'pending')
     returning id, slug, status, created_at`,
    [req.user.sub, `${finalSlug}.hosted`, finalSlug, generateEnrollmentKey()]
  )).rows[0];

  await query(`insert into site_settings (enrollment_id, store_name) values ($1,$2)`, [enr.id, store_name]);
  res.json({ site: enr });
}));

// GET /portal/hosted-sites  -> my storefronts (+ custom domain state)
clientRouter.get("/hosted-sites", asyncH(async (req, res) => {
  const { rows } = await query(
    `select e.id, e.slug, e.status, e.expiry_date, e.created_at,
            e.custom_domain, e.custom_domain_verified_at,
            s.store_name, s.logo_url
       from enrollments e left join site_settings s on s.enrollment_id = e.id
      where e.user_id=$1 and e.type='hosted'
      order by e.created_at desc`,
    [req.user.sub]
  );
  res.json({ sites: rows });
}));

// PUT /portal/hosted-sites/:id/custom-domain  { domain: 'aquawatch.com' | '' }
// Vendor sets/clears the domain. Setting it resets verification — the platform
// admin must confirm DNS points at the host before shoppers resolve through it.
clientRouter.put("/hosted-sites/:id/custom-domain", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const domain = normalizeDomain(req.body?.domain);
  try {
    const { rows } = await query(
      `update enrollments
          set custom_domain = $1,
              custom_domain_verified_at = null
        where id = $2 and type = 'hosted'
        returning custom_domain, custom_domain_verified_at`,
      [domain, req.params.id]
    );
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That domain is already in use by another site" });
    throw err;
  }
}));

// GET/PUT /portal/hosted-sites/:id/settings  -> the branding pack
clientRouter.get("/hosted-sites/:id/settings", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const { rows } = await query(`select * from site_settings where enrollment_id=$1`, [req.params.id]);
  res.json({ settings: rows[0] || {} });
}));

const SETTINGS_FIELDS = ["store_name", "logo_url", "theme", "whatsapp", "email", "phone",
  "address", "social_urls", "hero", "announcement", "about", "policies", "pricing", "sections", "analytics"];
const JSONB_FIELDS = new Set(["theme", "address", "social_urls", "hero", "policies", "pricing", "sections", "analytics"]);

function normalizeDomain(d) {
  if (!d) return null;
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0].trim();
  return h || null;
}

clientRouter.put("/hosted-sites/:id/settings", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });

  const params = [req.params.id];
  const sets = [];
  for (const f of SETTINGS_FIELDS) {
    if (!(f in (req.body || {}))) continue;
    params.push(JSONB_FIELDS.has(f) ? JSON.stringify(req.body[f]) : req.body[f]);
    sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: "No fields to update" });
  sets.push(`updated_at = now()`);

  const { rows } = await query(
    `update site_settings set ${sets.join(", ")} where enrollment_id=$1 returning *`,
    params
  );
  res.json({ settings: rows[0] });
}));

// GET /portal/hosted-sites/presets  -> shipped homepage presets
// Static list, no auth-per-site check needed — same set for every vendor.
clientRouter.get("/hosted-sites/presets", asyncH(async (req, res) => {
  res.json({
    presets: Object.entries(PRESETS).map(([id, p]) => ({
      id, name: p.name, description: p.description, section_count: p.sections.length,
    })),
  });
}));

// POST /portal/hosted-sites/:id/presets/:preset  -> apply preset to sections
clientRouter.post("/hosted-sites/:id/presets/:preset", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const preset = PRESETS[req.params.preset];
  if (!preset) return res.status(404).json({ error: "Unknown preset" });
  const { rows } = await query(
    `update site_settings set sections=$1, updated_at=now() where enrollment_id=$2 returning sections`,
    [JSON.stringify(preset.sections), req.params.id]
  );
  res.json({ ok: true, sections: rows[0]?.sections || [] });
}));

// GET /portal/hosted-sites/:id/orders?status=
clientRouter.get("/hosted-sites/:id/orders", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const { status } = req.query;
  const params = [req.params.id];
  let sql = `select * from orders where enrollment_id=$1`;
  if (status) { params.push(status); sql += ` and status=$${params.length}`; }
  sql += ` order by created_at desc`;
  res.json({ orders: (await query(sql, params)).rows });
}));

// GET /portal/hosted-sites/:id/orders/:orderId
clientRouter.get("/hosted-sites/:id/orders/:orderId", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const order = (await query(
    `select * from orders where id=$1 and enrollment_id=$2`,
    [req.params.orderId, req.params.id]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  const items = (await query(`select * from order_items where order_id=$1`, [order.id])).rows;
  res.json({ order, items });
}));

// PATCH /portal/hosted-sites/:id/orders/:orderId  { status }
const ORDER_STATUSES = new Set(["pending", "confirmed", "shipped", "delivered", "cancelled"]);
clientRouter.patch("/hosted-sites/:id/orders/:orderId", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const { status } = req.body || {};
  if (!ORDER_STATUSES.has(status)) return res.status(400).json({ error: "Invalid status" });
  const { rowCount, rows } = await query(
    `update orders set status=$1, updated_at=now() where id=$2 and enrollment_id=$3 returning *`,
    [status, req.params.orderId, req.params.id]
  );
  if (!rowCount) return res.status(404).json({ error: "Order not found" });
  res.json({ order: rows[0] });
}));

// ============================================================ admin

const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// GET /portal/admin/hosted-sites -> every storefront + owner + order count
adminRouter.get("/hosted-sites", asyncH(async (req, res) => {
  const { rows } = await query(
    `select e.id, e.slug, e.status, e.expiry_date, e.created_at, u.email as owner_email,
            e.custom_domain, e.custom_domain_verified_at,
            s.store_name, s.logo_url,
            (select count(*) from orders o where o.enrollment_id = e.id) as order_count
       from enrollments e
       join users u on u.id = e.user_id
       left join site_settings s on s.enrollment_id = e.id
      where e.type = 'hosted'
      order by e.created_at desc`
  );
  res.json({ sites: rows });
}));

// POST /portal/admin/hosted-sites/:id/verify-custom-domain
// Confirms DNS actually points at the platform host. We check by GETting a
// well-known probe URL on the domain and confirming it returns THIS backend's
// standard health payload — same idea as the plugin domain-verify flow.
// If the vendor hasn't pointed DNS yet, the fetch either fails or returns
// something we don't recognise and we say so.
adminRouter.post("/hosted-sites/:id/verify-custom-domain", asyncH(async (req, res) => {
  const enr = (await query(
    `select id, custom_domain from enrollments where id=$1 and type='hosted'`,
    [req.params.id]
  )).rows[0];
  if (!enr) return res.status(404).json({ error: "Site not found" });
  if (!enr.custom_domain) return res.status(400).json({ error: "No custom domain set" });

  // Fetch the SPA at the domain's root and look for our storefront marker.
  // Cheap and reliable: if a Vite build of site/ is being served there, the
  // built HTML contains `<div id="root"></div>`. We don't need a fancier probe.
  let ok = false, note = "";
  try {
    const r = await fetch(`https://${enr.custom_domain}/`, { redirect: "follow" });
    const body = await r.text();
    ok = r.ok && body.includes('<div id="root"></div>');
    note = ok ? "domain serves the storefront" : `HTTP ${r.status}, storefront marker not found`;
  } catch (e) {
    note = `could not reach https://${enr.custom_domain}/ — ${e.message}`;
  }
  if (!ok) return res.status(400).json({ error: "Verification failed", note });

  await query(
    `update enrollments set custom_domain_verified_at = now() where id=$1`,
    [enr.id]
  );
  res.json({ ok: true, note });
}));

// PATCH /portal/admin/hosted-sites/:id  { slug?, status? }  -> rename / pause
adminRouter.patch("/hosted-sites/:id", asyncH(async (req, res) => {
  const { slug, status } = req.body || {};
  const params = [req.params.id];
  const sets = [];
  if (slug) { params.push(await uniqueSlug(slugify(slug))); sets.push(`slug=$${params.length}`); }
  if (status) { params.push(status); sets.push(`status=$${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

  const { rowCount, rows } = await query(
    `update enrollments set ${sets.join(", ")} where id=$1 and type='hosted' returning id, slug, status`,
    params
  );
  if (!rowCount) return res.status(404).json({ error: "Site not found" });
  res.json({ site: rows[0] });
}));

// DELETE /portal/admin/hosted-sites/:id  -> permanently remove a site (rejected
// signups, spam, test sites). Cascades to site_settings/enrollment_sources/
// customers/orders via FK ON DELETE CASCADE — use PATCH status='paused' instead
// if the intent is "hide, don't destroy".
adminRouter.delete("/hosted-sites/:id", asyncH(async (req, res) => {
  const { rowCount } = await query(`delete from enrollments where id=$1 and type='hosted'`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "Site not found" });
  res.json({ ok: true });
}));

// GET /portal/admin/orders?enrollment_id=&status=  -> every order, every vendor
adminRouter.get("/orders", asyncH(async (req, res) => {
  const { enrollment_id, status } = req.query;
  const params = [];
  const where = [];
  if (enrollment_id) { params.push(enrollment_id); where.push(`o.enrollment_id=$${params.length}`); }
  if (status) { params.push(status); where.push(`o.status=$${params.length}`); }

  const { rows } = await query(
    `select o.*, e.slug, s.store_name
       from orders o
       join enrollments e on e.id = o.enrollment_id
       left join site_settings s on s.enrollment_id = e.id
      ${where.length ? "where " + where.join(" and ") : ""}
      order by o.created_at desc`,
    params
  );
  res.json({ orders: rows });
}));

// GET /portal/admin/orders/:id  -> one order + its items, any vendor (support/dispute lookups)
adminRouter.get("/orders/:id", asyncH(async (req, res) => {
  const order = (await query(
    `select o.*, e.slug, s.store_name
       from orders o
       join enrollments e on e.id = o.enrollment_id
       left join site_settings s on s.enrollment_id = e.id
      where o.id = $1`,
    [req.params.id]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  const items = (await query(`select * from order_items where order_id=$1`, [order.id])).rows;
  res.json({ order, items });
}));

export { clientRouter, adminRouter };
