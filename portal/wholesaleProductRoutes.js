// Wholesale product CRUD — writes databases/wholesale.db in the SAME PRODUCTS
// shape scraped categories use (imageUrl/sizeName are JSON-array strings,
// featuredimg is the thumbnail), so retailers' storefront + sync-feed serve
// wholesale products with no special-casing. Visibility to retailers is driven
// by the standard `availability` flag, kept in sync with listingStatus + stock.
//
//   app.use("/portal", wholesaleProductClientRoutes)
//   app.use("/portal/admin", wholesaleProductAdminRoutes)
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { wholesaleDb, wsRun, wsAll, wsGet } from "./wholesaleDb.js";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[wholesale-product]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// A row is visible to retailers only when it's an active listing that's in stock.
// We express that through the existing `availability` flag every serving query
// already filters on — no downstream change needed.
const isVisible = (listingStatus, stockQty) =>
  listingStatus === "active" && (stockQty == null || Number(stockQty) > 0) ? 1 : 0;

const jsonArr = (v) => {
  if (Array.isArray(v)) return JSON.stringify(v.filter(Boolean).map(String));
  if (typeof v === "string" && v.trim()) return JSON.stringify([v.trim()]);
  return "[]";
};

async function requireWholesaler(req, res, next) {
  try {
    const w = (await query(
      `select w.*, e.status as enr_status, e.plan_id from wholesalers w
         join enrollments e on e.id = w.enrollment_id where w.user_id = $1`,
      [req.user.sub]
    )).rows[0];
    if (!w) return res.status(403).json({ error: "You don't have a wholesaler account." });
    req.wholesaler = w;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function planLimits(plan_id) {
  if (!plan_id) return {};
  const p = (await query(`select limits from plans where id=$1`, [plan_id])).rows[0];
  return (p && p.limits) || {};
}

// Shape one DB row for the portal (parse the JSON-string columns back to arrays).
function outRow(r) {
  const parse = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return s ? [s] : []; } };
  let meta = {}; try { meta = JSON.parse(r.wholesaleMeta || "{}"); } catch { /* ignore */ }
  return {
    id: r.productId, name: r.productName, price: r.productPrice, mrp: r.productPriceWithoutDiscount,
    primary_cat: r.primaryCat, sub: r.catName, brand: r.productBrand,
    sizes: parse(r.sizeName), images: parse(r.imageUrl), thumbnail: r.featuredimg,
    description: r.productDescription, short_description: r.productShortDescription,
    stock_qty: r.stockQty, listing_status: r.listingStatus, available: !!r.availability,
    last_verified_at: r.lastVerifiedAt, sku: meta.sku, moq: meta.moq, updated_at: r.productLastUpdated,
  };
}

// ============================================================ client (wholesaler)
const clientRouter = Router();
clientRouter.use(requireAuth); // requireWholesaler is per-route so it never shadows /portal/admin/*

clientRouter.get("/wholesale/products", requireWholesaler, asyncH(async (req, res) => {
  const db = await wholesaleDb();
  const rows = await wsAll(db, `SELECT * FROM PRODUCTS WHERE ownerEnrollmentId=? ORDER BY productLastUpdated DESC`, [req.wholesaler.enrollment_id]);
  res.json({ products: rows.map(outRow), count: rows.length });
}));

clientRouter.post("/wholesale/products", requireWholesaler, asyncH(async (req, res) => {
  const b = req.body || {};
  if (!b.name || b.price == null) return res.status(400).json({ error: "name and price are required" });
  const images = Array.isArray(b.images) ? b.images.filter(Boolean) : [];
  if (!images.length) return res.status(400).json({ error: "At least one image is required" });

  const limits = await planLimits(req.wholesaler.plan_id);
  const db = await wholesaleDb();
  if (limits.max_products) {
    const { c } = await wsGet(db, `SELECT COUNT(*) c FROM PRODUCTS WHERE ownerEnrollmentId=?`, [req.wholesaler.enrollment_id]);
    if (c >= limits.max_products) return res.status(403).json({ error: `Your plan allows up to ${limits.max_products} products. Upgrade to list more.` });
  }
  if (limits.max_images && images.length > limits.max_images) return res.status(403).json({ error: `Your plan allows up to ${limits.max_images} images per product.` });

  const stockQty = b.stock_qty == null || b.stock_qty === "" ? null : Number(b.stock_qty);
  const listingStatus = "active";
  const meta = JSON.stringify({ mrp: b.mrp ?? null, moq: Number(b.moq) || req.wholesaler.min_order_qty || 1, sku: b.sku || null });
  const price = Number(b.price);
  const src = `ws_${req.wholesaler.slug}`;

  const r = await wsRun(db,
    `INSERT INTO PRODUCTS
      (productName, productPrice, productPriceWithoutDiscount, productOriginalPrice, productFetchedFrom,
       featuredimg, imageUrl, videoUrl, productShortDescription, productDescription, productBrand,
       sizeName, catName, primaryCat, availability, stockQty, listingStatus, wholesaleMeta, ownerEnrollmentId, lastVerifiedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    [b.name, price, b.mrp != null ? Number(b.mrp) : price, price, src,
     images[0], jsonArr(images), b.video_url || null, b.short_description || null, b.description || null, b.brand || null,
     jsonArr(b.sizes), b.sub || null, b.primary_cat || null, isVisible(listingStatus, stockQty), stockQty, listingStatus, meta, req.wholesaler.enrollment_id]
  );
  const row = await wsGet(db, `SELECT * FROM PRODUCTS WHERE productId = last_insert_rowid()`);
  res.json({ product: outRow(row) });
}));

// Ownership guard: the row must belong to this wholesaler.
async function ownRow(db, pid, enrollmentId) {
  const row = await wsGet(db, `SELECT * FROM PRODUCTS WHERE productId=? AND ownerEnrollmentId=?`, [pid, enrollmentId]);
  return row || null;
}

clientRouter.patch("/wholesale/products/:pid", requireWholesaler, asyncH(async (req, res) => {
  const db = await wholesaleDb();
  const cur = await ownRow(db, req.params.pid, req.wholesaler.enrollment_id);
  if (!cur) return res.status(404).json({ error: "Product not found" });
  const b = req.body || {};

  const sets = [], params = [];
  const put = (col, val) => { sets.push(`${col}=?`); params.push(val); };
  if (b.name != null) put("productName", b.name);
  if (b.price != null) put("productPrice", Number(b.price));
  if (b.mrp != null) put("productPriceWithoutDiscount", Number(b.mrp));
  if (b.brand != null) put("productBrand", b.brand);
  if (b.description != null) put("productDescription", b.description);
  if (b.short_description != null) put("productShortDescription", b.short_description);
  if (b.primary_cat != null) put("primaryCat", b.primary_cat);
  if (b.sub != null) put("catName", b.sub);
  if (b.sizes != null) put("sizeName", jsonArr(b.sizes));
  if (b.images != null) { const imgs = b.images.filter(Boolean); put("imageUrl", jsonArr(imgs)); put("featuredimg", imgs[0] || null); }

  const nextStatus = b.listing_status != null ? b.listing_status : cur.listingStatus;
  const nextStock = b.stock_qty !== undefined ? (b.stock_qty === "" || b.stock_qty == null ? null : Number(b.stock_qty)) : cur.stockQty;
  if (b.listing_status != null) put("listingStatus", nextStatus);
  if (b.stock_qty !== undefined) put("stockQty", nextStock);
  put("availability", isVisible(nextStatus, nextStock));
  put("productLastUpdated", new Date().toISOString());

  params.push(req.params.pid, req.wholesaler.enrollment_id);
  await wsRun(db, `UPDATE PRODUCTS SET ${sets.join(", ")} WHERE productId=? AND ownerEnrollmentId=?`, params);
  res.json({ product: outRow(await wsGet(db, `SELECT * FROM PRODUCTS WHERE productId=?`, [req.params.pid])) });
}));

clientRouter.delete("/wholesale/products/:pid", requireWholesaler, asyncH(async (req, res) => {
  const db = await wholesaleDb();
  if (!(await ownRow(db, req.params.pid, req.wholesaler.enrollment_id))) return res.status(404).json({ error: "Product not found" });
  await wsRun(db, `DELETE FROM PRODUCTS WHERE productId=? AND ownerEnrollmentId=?`, [req.params.pid, req.wholesaler.enrollment_id]);
  res.json({ ok: true });
}));

// "Still accurate" — re-verify stock/details for the listing re-verify cycle.
clientRouter.post("/wholesale/products/reverify", requireWholesaler, asyncH(async (req, res) => {
  const db = await wholesaleDb();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  // reactivate needs_review rows and stamp lastVerifiedAt=now
  const where = ids && ids.length ? `AND productId IN (${ids.map(() => "?").join(",")})` : "";
  await wsRun(db,
    `UPDATE PRODUCTS SET lastVerifiedAt=CURRENT_TIMESTAMP,
       listingStatus=CASE WHEN listingStatus='needs_review' THEN 'active' ELSE listingStatus END,
       availability=CASE WHEN (listingStatus='needs_review' OR listingStatus='active') AND (stockQty IS NULL OR stockQty>0) THEN 1 ELSE availability END
     WHERE ownerEnrollmentId=? ${where}`,
    ids && ids.length ? [req.wholesaler.enrollment_id, ...ids] : [req.wholesaler.enrollment_id]
  );
  res.json({ ok: true });
}));

// ============================================================ admin (full control)
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/wholesale-products", asyncH(async (req, res) => {
  const db = await wholesaleDb();
  const { owner } = req.query;
  const rows = owner
    ? await wsAll(db, `SELECT * FROM PRODUCTS WHERE ownerEnrollmentId=? ORDER BY productLastUpdated DESC`, [owner])
    : await wsAll(db, `SELECT * FROM PRODUCTS ORDER BY productLastUpdated DESC LIMIT 500`);
  res.json({ products: rows.map(outRow) });
}));

// Admin override: force status / stock / edit any wholesale product.
adminRouter.patch("/wholesale-products/:pid", asyncH(async (req, res) => {
  const db = await wholesaleDb();
  const cur = await wsGet(db, `SELECT * FROM PRODUCTS WHERE productId=?`, [req.params.pid]);
  if (!cur) return res.status(404).json({ error: "Product not found" });
  const b = req.body || {};
  const nextStatus = b.listing_status != null ? b.listing_status : cur.listingStatus;
  const nextStock = b.stock_qty !== undefined ? (b.stock_qty === "" || b.stock_qty == null ? null : Number(b.stock_qty)) : cur.stockQty;
  await wsRun(db,
    `UPDATE PRODUCTS SET listingStatus=?, stockQty=?, availability=?, productLastUpdated=? WHERE productId=?`,
    [nextStatus, nextStock, isVisible(nextStatus, nextStock), new Date().toISOString(), req.params.pid]
  );
  res.json({ product: outRow(await wsGet(db, `SELECT * FROM PRODUCTS WHERE productId=?`, [req.params.pid])) });
}));

adminRouter.delete("/wholesale-products/:pid", asyncH(async (req, res) => {
  const db = await wholesaleDb();
  await wsRun(db, `DELETE FROM PRODUCTS WHERE productId=?`, [req.params.pid]);
  res.json({ ok: true });
}));

export { clientRouter as wholesaleProductClientRoutes, adminRouter as wholesaleProductAdminRoutes };
