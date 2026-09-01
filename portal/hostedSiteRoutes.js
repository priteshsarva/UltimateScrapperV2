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
import crypto from "crypto";
import dns from "dns/promises";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { generateEnrollmentKey } from "./keys.js";
import { PRESETS } from "./storefrontPresets.js";
import { listSiteBrands, listSiteSubcategories, listSiteSubBrands, categoryOriginalUrls, productPageUrl } from "./storeRoutes.js";
import { listSiteRawCategories, saveSiteCategoryMapping } from "./categoryMap.js";

// The platform's own wildcard base (e.g. "yourplatform.com"). Vendors reach
// their stores at <slug>.PLATFORM_HOST; a custom domain is anything else. Used
// to (a) refuse a vendor claiming a platform-owned name and (b) let resolveStore
// tell a platform subdomain from a real custom domain. Empty in local dev.
const PLATFORM_HOST = (process.env.PLATFORM_HOST || "").toLowerCase().replace(/^\.+|\.+$/g, "");

function normalizeDomain(d) {
  if (!d) return null;
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0].replace(/\.+$/, "").trim(); // strip path/port/trailing-dot
  return h || null;
}

// a real hostname, at least one dot, no spaces
const isHostname = (h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h || "");

// is this domain the platform's own (its apex or any subdomain of it)?
const isPlatformDomain = (h) => !!PLATFORM_HOST && (h === PLATFORM_HOST || h.endsWith("." + PLATFORM_HOST));

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

// POST /portal/hosted-sites  { store_name, slug? }  -> DRAFT hosted enrollment.
// Stays a draft (invisible to the admin queue) while the owner sets it up; the
// Submit endpoint below flips it to 'pending' for review.
clientRouter.post("/hosted-sites", asyncH(async (req, res) => {
  const { store_name, slug } = req.body || {};
  if (!store_name) return res.status(400).json({ error: "store_name required" });

  const finalSlug = await uniqueSlug(slugify(slug || store_name));
  const enr = (await query(
    `insert into enrollments (user_id, domain, type, slug, enrollment_key, status)
     values ($1,$2,'hosted',$3,$4,'draft')
     returning id, slug, status, created_at`,
    [req.user.sub, `${finalSlug}.hosted`, finalSlug, generateEnrollmentKey()]
  )).rows[0];

  await query(`insert into site_settings (enrollment_id, store_name) values ($1,$2)`, [enr.id, store_name]);
  res.json({ site: enr });
}));

// POST /portal/hosted-sites/:id/submit  -> draft -> pending (Submit for review).
clientRouter.post("/hosted-sites/:id/submit", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const row = (await query(
    `update enrollments set status='pending'
      where id=$1 and status='draft' returning id, slug, status`,
    [req.params.id]
  )).rows[0];
  if (!row) return res.status(409).json({ error: "Only a draft store can be submitted for review." });
  res.json({ site: row });
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

// GET /portal/hosted-orders?status=&site=  -> ALL orders across the client's
// hosted storefronts (shop-wise), each tagged with its store name + slug.
clientRouter.get("/hosted-orders", asyncH(async (req, res) => {
  const { status, site } = req.query;
  const params = [req.user.sub];
  let sql = `select o.*, e.slug, coalesce(s.store_name, e.slug) as store_name
               from orders o
               join enrollments e on e.id = o.enrollment_id
               left join site_settings s on s.enrollment_id = e.id
              where e.user_id = $1 and e.type = 'hosted'`;
  if (status) { params.push(status); sql += ` and o.status = $${params.length}`; }
  if (site) { params.push(site); sql += ` and e.id = $${params.length}`; }
  sql += ` order by o.created_at desc limit 500`;
  res.json({ orders: (await query(sql, params)).rows });
}));

// GET /portal/hosted-analytics  -> dashboard KPIs + a 30-day sales series across
// all the client's hosted storefronts.
clientRouter.get("/hosted-analytics", asyncH(async (req, res) => {
  const uid = req.user.sub;
  const totals = (await query(
    `select count(*)::int as orders,
            coalesce(sum(o.total),0) as sales,
            coalesce(sum(o.total) filter (where o.created_at::date = current_date),0) as today_sales,
            count(*) filter (where o.created_at::date = current_date)::int as today_orders,
            coalesce(sum(o.total) filter (where o.status <> 'cancelled'),0) as net_sales
       from orders o join enrollments e on e.id = o.enrollment_id
      where e.user_id = $1 and e.type = 'hosted'`,
    [uid]
  )).rows[0];
  const series = (await query(
    `select o.created_at::date as d, coalesce(sum(o.total),0) as sales, count(*)::int as orders
       from orders o join enrollments e on e.id = o.enrollment_id
      where e.user_id = $1 and e.type = 'hosted' and o.created_at >= current_date - interval '29 days'
      group by 1 order by 1`,
    [uid]
  )).rows;
  const sites = (await query(
    `select e.id, e.slug, e.status, coalesce(s.store_name, e.slug) as store_name,
            count(o.*)::int as order_count, coalesce(sum(o.total),0) as sales
       from enrollments e
       left join site_settings s on s.enrollment_id = e.id
       left join orders o on o.enrollment_id = e.id
      where e.user_id = $1 and e.type = 'hosted'
      group by e.id, e.slug, e.status, s.store_name
      order by e.created_at desc`,
    [uid]
  )).rows;
  res.json({ totals, series, sites });
}));

// PUT /portal/hosted-sites/:id/custom-domain  { domain: 'aquawatch.com' | '' }
// Vendor sets/clears the domain. Setting it issues a fresh verify token and
// resets verification — the vendor must prove control of the domain (TXT record
// or well-known file, see the verify route) before shoppers resolve through it.
clientRouter.put("/hosted-sites/:id/custom-domain", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const domain = normalizeDomain(req.body?.domain);

  if (domain) {
    if (!isHostname(domain)) return res.status(400).json({ error: "That doesn't look like a valid domain." });
    if (isPlatformDomain(domain)) return res.status(400).json({ error: "You can't claim a platform domain." });
  }
  // a new/changed domain gets a fresh secret; clearing removes it
  const token = domain ? "spp-verify-" + crypto.randomBytes(16).toString("hex") : null;

  try {
    const { rows } = await query(
      `update enrollments
          set custom_domain = $1,
              custom_domain_verified_at = null,
              domain_verify_token = $2
        where id = $3 and type = 'hosted'
        returning custom_domain, custom_domain_verified_at, domain_verify_token`,
      [domain, token, req.params.id]
    );
    const r = rows[0] || {};
    res.json({
      ok: true,
      ...r,
      // instructions the portal shows the vendor
      verify: domain ? {
        txt_name: `_spp-verify.${domain}`,
        txt_value: r.domain_verify_token,
        wellknown_url: `https://${domain}/.well-known/spp-verify`,
        wellknown_value: r.domain_verify_token,
      } : null,
    });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That domain is already in use by another site" });
    throw err;
  }
}));

// POST /portal/hosted-sites/:id/verify-domain — vendor self-verify (they own DNS)
clientRouter.post("/hosted-sites/:id/verify-domain", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const enr = (await query(
    `select id, custom_domain, domain_verify_token from enrollments where id=$1`,
    [req.params.id]
  )).rows[0];
  const { ok, note } = await verifyCustomDomain(enr);
  if (!ok) return res.status(400).json({ error: "Not verified yet", note });
  await query(`update enrollments set custom_domain_verified_at = now() where id=$1`, [enr.id]);
  res.json({ ok: true, note });
}));

// GET/PUT /portal/hosted-sites/:id/settings  -> the branding pack
clientRouter.get("/hosted-sites/:id/settings", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const { rows } = await query(`select * from site_settings where enrollment_id=$1`, [req.params.id]);
  res.json({ settings: rows[0] || {} });
}));

const SETTINGS_FIELDS = ["store_name", "logo_url", "favicon_url", "theme", "whatsapp", "email", "phone",
  "address", "social_urls", "hero", "announcement", "about", "policies", "pricing", "sections", "analytics", "nav", "reviews", "preset"];
const JSONB_FIELDS = new Set(["theme", "address", "social_urls", "hero", "policies", "pricing", "sections", "analytics", "nav", "reviews"]);

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

// GET /portal/hosted-sites/:id/sources -> the product sources feeding this site.
//   { available: [{id,name,category}], attached: [id...], categories: [db...] }
// `available` is every active source the vendor can pick from; `attached` is the
// current selection; `categories` = the distinct SQLite DBs those attached
// sources write to (what the storefront nav/home can group by).
clientRouter.get("/hosted-sites/:id/sources", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const available = (await query(
    `select id, name, category from sources where status='active' order by category, name`
  )).rows;
  const attached = (await query(
    `select source_id from enrollment_sources where enrollment_id=$1`, [req.params.id]
  )).rows.map((r) => r.source_id);
  const attachedSet = new Set(attached);
  const categories = [...new Set(available.filter((s) => attachedSet.has(s.id)).map((s) => s.category))];
  res.json({ available, attached, categories });
}));

// PUT /portal/hosted-sites/:id/sources  { source_ids: [...] }
// Replaces the site's whole source selection. Adds keep an empty category
// allow-list (= all of that source's categories). Ignores unknown/paused ids.
clientRouter.put("/hosted-sites/:id/sources", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const wanted = Array.isArray(req.body?.source_ids) ? [...new Set(req.body.source_ids.map(String))] : null;
  if (!wanted) return res.status(400).json({ error: "source_ids array required" });

  // keep only ids that are real + active — never trust the client's list blindly
  const valid = wanted.length
    ? (await query(`select id from sources where status='active' and id = any($1)`, [wanted])).rows.map((r) => r.id)
    : [];
  const validSet = new Set(valid);

  const current = (await query(
    `select source_id from enrollment_sources where enrollment_id=$1`, [req.params.id]
  )).rows.map((r) => r.source_id);
  const currentSet = new Set(current);

  const toAdd = valid.filter((id) => !currentSet.has(id));
  const toRemove = current.filter((id) => !validSet.has(id));

  for (const id of toAdd) {
    await query(
      `insert into enrollment_sources (enrollment_id, source_id, categories) values ($1,$2,'{}')
       on conflict (enrollment_id, source_id) do nothing`,
      [req.params.id, id]
    );
  }
  if (toRemove.length) {
    await query(
      `delete from enrollment_sources where enrollment_id=$1 and source_id = any($2)`,
      [req.params.id, toRemove]
    );
  }
  res.json({ ok: true, attached: valid });
}));

// GET /portal/hosted-sites/:id/brands?category=  -> in-stock brands the vendor
// can feature for that category (same list shoppers can filter by).
clientRouter.get("/hosted-sites/:id/brands", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const category = (req.query.category || "").toString();
  if (!category) return res.json({ brands: [] });
  res.json({ brands: await listSiteBrands(req.params.id, category) });
}));

// GET /portal/hosted-sites/:id/subcategories?category=  -> featurable sub-categories
clientRouter.get("/hosted-sites/:id/subcategories", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const category = (req.query.category || "").toString();
  if (!category) return res.json({ subcategories: [] });
  res.json({ subcategories: await listSiteSubcategories(req.params.id, category) });
}));

// GET /portal/hosted-sites/:id/subbrands?category=&brand=  -> featurable sub-brands of a brand
clientRouter.get("/hosted-sites/:id/subbrands", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const category = (req.query.category || "").toString();
  const brand = (req.query.brand || "").toString();
  if (!category || !brand) return res.json({ subbrands: [] });
  res.json({ subbrands: await listSiteSubBrands(req.params.id, category, brand) });
}));

// GET /portal/hosted-sites/:id/all-categories  -> this store's raw categories + current mapping
clientRouter.get("/hosted-sites/:id/all-categories", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const cats = await listSiteRawCategories(req.params.id);
  // attach each category's ORIGINAL supplier URL (from the scraped CATEGORIES table)
  const urlMaps = {};
  for (const db of [...new Set(cats.map((c) => c.db_name))]) urlMaps[db] = await categoryOriginalUrls(db);
  for (const c of cats) c.url = (urlMaps[c.db_name] && urlMaps[c.db_name].get(c.name)) || null;
  res.json({ categories: cats });
}));

// PUT /portal/hosted-sites/:id/category-map  { db_name, cat_name, canonical }  -> store-wide upsert
clientRouter.put("/hosted-sites/:id/category-map", asyncH(async (req, res) => {
  if (!(await ownedSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const cat_name = (req.body?.cat_name || "").toString();
  const db_name = (req.body?.db_name || "").toString() || null;
  const canonical = (req.body?.canonical || "").toString().trim();
  if (!cat_name) return res.status(400).json({ error: "cat_name required" });
  await saveSiteCategoryMapping(req.params.id, db_name, cat_name, canonical);
  res.json({ ok: true });
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
    `update site_settings set sections=$1, preset=$3, updated_at=now() where enrollment_id=$2 returning sections`,
    [JSON.stringify(preset.sections), req.params.id, req.params.preset]
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
  const slug = (await query(`select slug from enrollments where id=$1`, [req.params.id])).rows[0]?.slug;
  const items = (await query(`select * from order_items where order_id=$1`, [order.id])).rows
    .map((it) => ({ ...it, page_url: slug ? productPageUrl({ slug }, it.db_name, it.product_id) : null }));
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

// Shared token-verification so an admin OR the owning vendor can verify a
// domain. Proves the claimant controls the domain by requiring the per-site
// secret token to appear in EITHER a DNS TXT record `_spp-verify.<domain>` OR
// the file `https://<domain>/.well-known/spp-verify`. A generic page marker
// (the old check) proved nothing — every React site returns it, so any vendor
// could verify any domain. Returns { ok, note }.
async function verifyCustomDomain(enr) {
  if (!enr.custom_domain) return { ok: false, note: "No custom domain set" };
  if (!enr.domain_verify_token) return { ok: false, note: "No verification token — re-save the domain to issue one" };
  const token = enr.domain_verify_token;

  // 1) DNS TXT — the robust check; doesn't require the domain to serve anything.
  try {
    const records = await dns.resolveTxt(`_spp-verify.${enr.custom_domain}`);
    if (records.flat().some((v) => v.trim() === token)) return { ok: true, note: "verified via DNS TXT" };
  } catch { /* no record / NXDOMAIN — fall through to the file check */ }

  // 2) well-known file — for hosts where the vendor can't easily add TXT.
  try {
    const r = await fetch(`https://${enr.custom_domain}/.well-known/spp-verify`, { redirect: "follow" });
    if (r.ok) {
      const body = (await r.text()).trim();
      if (body === token) return { ok: true, note: "verified via well-known file" };
    }
    return { ok: false, note: `token not found — add the DNS TXT record or the /.well-known/spp-verify file` };
  } catch (e) {
    return { ok: false, note: `could not verify ${enr.custom_domain}: no TXT record and the file couldn't be fetched (${e.message})` };
  }
}

// POST /portal/admin/hosted-sites/:id/verify-custom-domain
adminRouter.post("/hosted-sites/:id/verify-custom-domain", asyncH(async (req, res) => {
  const enr = (await query(
    `select id, custom_domain, domain_verify_token from enrollments where id=$1 and type='hosted'`,
    [req.params.id]
  )).rows[0];
  if (!enr) return res.status(404).json({ error: "Site not found" });

  const { ok, note } = await verifyCustomDomain(enr);
  if (!ok) return res.status(400).json({ error: "Verification failed", note });
  await query(`update enrollments set custom_domain_verified_at = now() where id=$1`, [enr.id]);
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
