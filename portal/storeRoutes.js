// Public storefront API for hosted, multi-tenant vendor sites.
//   app.use("/store", storeRoutes)   ->  GET /store/:slug/config, /store/:slug/products, ...
// Every route resolves :slug to its (active, hosted) enrollment via resolveStore,
// then reads that enrollment's enrollment_sources exactly like the plugin's
// sync-feed does — same per-source "productFetchedFrom LIKE searchKey [+ category
// allow-list]" filter, just browsed instead of paged for a sync. Prices are always
// computed here from productOriginalPrice; the browser never sends a price.
import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { query, pool } from "./db.js";
import { resolveStore } from "./resolveStore.js";
import {
  hashPassword, comparePassword, signCustomerToken, identifyCustomer, requireCustomer,
} from "./customerAuth.js";
import { priceProduct } from "./pricing.js";
import { sendOrderConfirmationEmail, sendOrderNotificationEmail } from "./mailer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FOLDER = path.resolve(__dirname, "../databases");
const AVAIL_TEXT = `LOWER(CAST(COALESCE(availability,'0') AS TEXT))`;
const round2 = (n) => Math.round(n * 100) / 100;

const router = Router();

// wraps an async handler so a thrown/rejected error becomes clean 500 JSON
// instead of an unhandled rejection (same pattern as enrollmentSourceRoutes.js)
const asyncH = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error("storeRoutes error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

function runReadonly(dbName, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(DB_FOLDER, `${dbName}.db`), sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) return reject(openErr);
      db.all(sql, params, (err, rows) => {
        db.close();
        if (err) reject(err); else resolve(rows || []);
      });
    });
  });
}

async function loadSiteSettings(enrollmentId) {
  const { rows } = await query(`select * from site_settings where enrollment_id=$1`, [enrollmentId]);
  return rows[0] || {};
}

// this vendor's attached sources, joined to their scraped category (= db file)
async function loadVendorSources(enrollmentId, dbName) {
  const { rows } = await query(
    `select es.source_id, es.categories, s.category as db_name, s.search_key
       from enrollment_sources es join sources s on s.id = es.source_id
      where es.enrollment_id = $1 ${dbName ? "and s.category = $2" : ""}`,
    dbName ? [enrollmentId, dbName] : [enrollmentId]
  );
  return rows;
}

// row.imageUrl is scraped as a JSON-stringified array ('["url1","url2"]'), not a
// usable <img src> on its own — parse it defensively (some rows are malformed
// or a plain string) and always hand back a real array plus a single thumbnail.
function parseImages(row) {
  let images = [];
  if (row.imageUrl) {
    try {
      const parsed = JSON.parse(row.imageUrl);
      images = Array.isArray(parsed) ? parsed.filter(Boolean) : [row.imageUrl];
    } catch {
      images = [row.imageUrl];
    }
  }
  if (!images.length && row.featuredimg) images = [row.featuredimg];
  return images;
}

// sizeName is scraped as a JSON-stringified array too ('["40","41"]'), or empty/"[]".
function parseSizes(row) {
  if (!row.sizeName) return [];
  try {
    const parsed = JSON.parse(row.sizeName);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function priceRow(row, dbName, pricing) {
  const p = priceProduct(row.productOriginalPrice, pricing);
  const images = parseImages(row);
  return {
    productId: row.productId,
    dbName,
    productName: row.productName,
    productBrand: row.productBrand,
    catName: row.catName,
    sizes: parseSizes(row),
    thumbnail: row.featuredimg || images[0] || null,
    images,
    videoUrl: row.videoUrl || null,
    productShortDescription: row.productShortDescription,
    productDescription: row.productDescription,
    inStock: [`1`, `true`].includes(String(row.availability).toLowerCase()),
    price: p.price,
    mrp: p.mrp,
    savings_pct: p.savings_pct,
  };
}

function buildWhatsAppUrl(whatsapp, orderNo, items, total, address) {
  const lines = [
    `👋 Hi, I'd like to confirm my order *${orderNo}*`,
    ``,
    ...items.map((li) => `• ${li.product_name} x${li.qty} — ₹${li.line_total}`),
    ``,
    `💰 *Total*: ₹${total}`,
    `📍 *Deliver to*: ${address.name}, ${address.line1}${address.line2 ? ", " + address.line2 : ""}, ${address.city}, ${address.state} - ${address.pincode}`,
    `📞 ${address.phone}`,
  ];
  const phone = String(whatsapp).replace(/[^\d]/g, "");
  return `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(lines.join("\n"))}`;
}

// ============================================================ config

// GET /store/:slug/config — branding pack + which categories this vendor sells.
// The SPA's first call; everything vendor-varying renders from this response.
router.get("/:slug/config", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const site = await loadSiteSettings(enr.id);
  const dbRows = (await query(
    `select distinct s.category as db_name
       from enrollment_sources es join sources s on s.id = es.source_id
      where es.enrollment_id = $1`,
    [enr.id]
  )).rows;

  res.json({
    slug: enr.slug,
    store_name: site.store_name || enr.slug,
    logo_url: site.logo_url || null,
    theme: site.theme || {},
    whatsapp: site.whatsapp || null,
    email: site.email || null,
    phone: site.phone || null,
    address: site.address || {},
    social_urls: site.social_urls || {},
    hero: site.hero || {},
    announcement: site.announcement || "",
    about: site.about || "",
    policies: site.policies || {},
    sections: Array.isArray(site.sections) ? site.sections : [],
    analytics: site.analytics || {},
    categories: dbRows.map((r) => r.db_name),
  });
}));

// ============================================================ products

// GET /store/:slug/products?category=&q=&after=&limit=&stock=
router.get("/:slug/products", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const after = parseInt(req.query.after, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const stock = req.query.stock === "in" ? "in" : req.query.stock === "out" ? "out" : "";

  const allSources = await loadVendorSources(enr.id);
  if (!allSources.length) return res.json({ after, count: 0, results: [] });

  const dbName = (req.query.category || allSources[0].db_name || "").toString();
  const catSources = allSources.filter((s) => s.db_name === dbName);
  if (!catSources.length) return res.json({ after, count: 0, results: [] });

  const params = [after];
  const sourceClauses = catSources.map((s) => {
    let clause = "productFetchedFrom LIKE '%' || ? || '%'";
    params.push(s.search_key);
    if (Array.isArray(s.categories) && s.categories.length) {
      const ph = s.categories.map(() => "?").join(",");
      clause += ` AND catName IN (${ph})`;
      params.push(...s.categories);
    }
    return `(${clause})`;
  });

  const filters = [];
  if (stock === "in") filters.push(`${AVAIL_TEXT} IN ('1','true')`);
  else if (stock === "out") filters.push(`${AVAIL_TEXT} NOT IN ('1','true')`);
  if (q) { filters.push(`LOWER(productName) LIKE ?`); params.push(`%${q}%`); }
  params.push(limit);

  const sql = `
    SELECT * FROM PRODUCTS
     WHERE productId > ?
       AND (${sourceClauses.join(" OR ")})
       ${filters.length ? "AND " + filters.join(" AND ") : ""}
     ORDER BY productId ASC
     LIMIT ?`;

  const site = await loadSiteSettings(enr.id);
  const rows = await runReadonly(dbName, sql, params).catch(() => []);
  res.json({ after, count: rows.length, results: rows.map((r) => priceRow(r, dbName, site.pricing)) });
}));

// GET /store/:slug/products/:dbName/:id — one product + similar items
router.get("/:slug/products/:dbName/:id", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const dbName = req.params.dbName;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid product id" });

  const catSources = await loadVendorSources(enr.id, dbName);
  if (!catSources.length) return res.status(404).json({ error: "Product not found" });

  const rows = await runReadonly(dbName, `SELECT * FROM PRODUCTS WHERE productId = ?`, [id]).catch(() => []);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "Product not found" });

  // tenant isolation: the row must actually belong to one of this vendor's
  // sources (same LIKE + category allow-list sync-feed uses), not just be in
  // the same shared category DB — otherwise any productId in the file would
  // leak across vendors who don't sell that source.
  const belongs = catSources.some((s) =>
    String(row.productFetchedFrom || "").includes(s.search_key) &&
    (!Array.isArray(s.categories) || !s.categories.length || s.categories.includes(row.catName))
  );
  if (!belongs) return res.status(404).json({ error: "Product not found" });

  const site = await loadSiteSettings(enr.id);
  const similar = await runReadonly(
    dbName,
    `SELECT * FROM PRODUCTS WHERE catName = ? AND productId != ? ORDER BY RANDOM() LIMIT 8`,
    [row.catName, id]
  ).catch(() => []);

  res.json({
    product: priceRow(row, dbName, site.pricing),
    similar: similar.map((r) => priceRow(r, dbName, site.pricing)),
  });
}));

// ============================================================ customer auth

router.post("/:slug/auth/signup", resolveStore, asyncH(async (req, res) => {
  const { email, password, name, phone } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  try {
    const hash = await hashPassword(password);
    const { rows } = await query(
      `insert into customers (enrollment_id, email, password_hash, name, phone)
       values ($1,$2,$3,$4,$5)
       returning id, enrollment_id, email, name, phone`,
      [req.storeEnrollment.id, String(email).toLowerCase().trim(), hash, name || null, phone || null]
    );
    res.json({ token: signCustomerToken(rows[0]), customer: rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "An account with this email already exists" });
    throw err;
  }
}));

router.post("/:slug/auth/login", resolveStore, asyncH(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const { rows } = await query(
    `select id, enrollment_id, email, name, phone, password_hash from customers
      where enrollment_id=$1 and email=$2`,
    [req.storeEnrollment.id, String(email).toLowerCase().trim()]
  );
  const customer = rows[0];
  if (!customer || !(await comparePassword(password, customer.password_hash)))
    return res.status(401).json({ error: "Invalid credentials" });
  delete customer.password_hash;
  res.json({ token: signCustomerToken(customer), customer });
}));

// ============================================================ account: profile + addresses

router.get("/:slug/me", resolveStore, identifyCustomer, requireCustomer, asyncH(async (req, res) => {
  const customer = (await query(`select id, email, name, phone from customers where id=$1`, [req.customer.sub])).rows[0];
  const addresses = (await query(
    `select * from customer_addresses where customer_id=$1 order by is_default desc, created_at desc`,
    [req.customer.sub]
  )).rows;
  res.json({ customer, addresses });
}));

router.post("/:slug/me/addresses", resolveStore, identifyCustomer, requireCustomer, asyncH(async (req, res) => {
  const { label, name, phone, line1, line2, city, state, pincode, is_default } = req.body || {};
  if (!name || !phone || !line1 || !city || !state || !pincode)
    return res.status(400).json({ error: "name, phone, line1, city, state, pincode required" });
  if (is_default) await query(`update customer_addresses set is_default=false where customer_id=$1`, [req.customer.sub]);
  const { rows } = await query(
    `insert into customer_addresses (customer_id,label,name,phone,line1,line2,city,state,pincode,is_default)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [req.customer.sub, label || null, name, phone, line1, line2 || null, city, state, pincode, !!is_default]
  );
  res.json({ address: rows[0] });
}));

router.put("/:slug/me/addresses/:id", resolveStore, identifyCustomer, requireCustomer, asyncH(async (req, res) => {
  const { label, name, phone, line1, line2, city, state, pincode, is_default } = req.body || {};
  if (is_default) await query(`update customer_addresses set is_default=false where customer_id=$1`, [req.customer.sub]);
  const { rowCount, rows } = await query(
    `update customer_addresses set label=$1,name=$2,phone=$3,line1=$4,line2=$5,city=$6,state=$7,pincode=$8,is_default=$9
      where id=$10 and customer_id=$11 returning *`,
    [label || null, name, phone, line1, line2 || null, city, state, pincode, !!is_default, req.params.id, req.customer.sub]
  );
  if (!rowCount) return res.status(404).json({ error: "Address not found" });
  res.json({ address: rows[0] });
}));

router.delete("/:slug/me/addresses/:id", resolveStore, identifyCustomer, requireCustomer, asyncH(async (req, res) => {
  await query(`delete from customer_addresses where id=$1 and customer_id=$2`, [req.params.id, req.customer.sub]);
  res.json({ ok: true });
}));

// ============================================================ orders (WhatsApp checkout)

// POST /store/:slug/orders  — guest or logged-in. Body:
//   { items:[{product_id,db_name,qty}], address | address_id, buyer_name?, buyer_phone?, buyer_email?, note? }
// Re-fetches every item from its category DB and prices it here — the client's
// displayed price is never trusted for the charge. Saves the order, then hands
// back a prefilled WhatsApp link to the vendor's own number for the buyer to send.
router.post("/:slug/orders", resolveStore, identifyCustomer, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const { items, address, address_id, buyer_name, buyer_phone, buyer_email, note } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "items required" });

  let shipTo = address;
  if (!shipTo && address_id && req.customer) {
    shipTo = (await query(
      `select * from customer_addresses where id=$1 and customer_id=$2`,
      [address_id, req.customer.sub]
    )).rows[0];
  }
  if (!shipTo || !shipTo.line1 || !shipTo.city || !shipTo.pincode)
    return res.status(400).json({ error: "A shipping address is required" });

  const name = buyer_name || shipTo.name;
  const phone = buyer_phone || shipTo.phone;
  if (!name || !phone) return res.status(400).json({ error: "Buyer name and phone required" });

  const site = await loadSiteSettings(enr.id);
  if (!site.whatsapp) return res.status(400).json({ error: "This store hasn't set up WhatsApp checkout yet" });

  const lineItems = [];
  for (const it of items) {
    const dbName = String(it.db_name || "");
    const productId = parseInt(it.product_id, 10);
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    if (!dbName || !productId) continue;
    const rows = await runReadonly(dbName, `SELECT * FROM PRODUCTS WHERE productId=?`, [productId]).catch(() => []);
    const row = rows[0];
    if (!row) continue;
    const priced = priceProduct(row.productOriginalPrice, site.pricing);
    const images = parseImages(row);
    lineItems.push({
      product_id: String(productId), db_name: dbName, product_name: row.productName,
      image_url: row.featuredimg || images[0] || null,
      unit_price: priced.price, qty, line_total: round2(priced.price * qty),
    });
  }
  if (!lineItems.length) return res.status(400).json({ error: "No valid items to order" });

  const subtotal = round2(lineItems.reduce((s, li) => s + li.line_total, 0));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = (await client.query(
      `insert into orders (enrollment_id, customer_id, buyer_name, buyer_phone, buyer_email, address, subtotal, total, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id, order_no`,
      [enr.id, req.customer ? req.customer.sub : null, name, phone, buyer_email || null,
       JSON.stringify(shipTo), subtotal, subtotal, note || null]
    )).rows[0];

    for (const li of lineItems) {
      await client.query(
        `insert into order_items (order_id, product_id, db_name, product_name, image_url, unit_price, qty, line_total)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order.id, li.product_id, li.db_name, li.product_name, li.image_url, li.unit_price, li.qty, li.line_total]
      );
    }
    await client.query("COMMIT");

    const wa_url = buildWhatsAppUrl(site.whatsapp, order.order_no, lineItems, subtotal, { ...shipTo, phone });

    // Fire-and-forget order emails. Failures are logged inside sendMail;
    // never let a mailer hiccup break the checkout response.
    const storeName = site.store_name || enr.slug;
    const emailPayload = {
      storeName, orderNo: order.order_no, total: subtotal,
      items: lineItems, address: { ...shipTo, phone },
    };
    if (buyer_email) sendOrderConfirmationEmail({ ...emailPayload, buyerName: name, buyerEmail: buyer_email, whatsappUrl: wa_url }).catch(() => {});
    (async () => {
      try {
        const vendor = (await query(`select u.email from users u join enrollments e on e.user_id=u.id where e.id=$1`, [enr.id])).rows[0];
        if (vendor?.email) sendOrderNotificationEmail({ ...emailPayload, vendorEmail: vendor.email, buyerName: name, buyerPhone: phone });
      } catch (e) { console.error("[order-email vendor] lookup failed:", e.message); }
    })();

    res.json({ order_no: order.order_no, total: subtotal, wa_url });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

router.get("/:slug/me/orders", resolveStore, identifyCustomer, requireCustomer, asyncH(async (req, res) => {
  const { rows } = await query(
    `select id, order_no, status, subtotal, total, created_at from orders
      where enrollment_id=$1 and customer_id=$2 order by created_at desc`,
    [req.storeEnrollment.id, req.customer.sub]
  );
  res.json({ orders: rows });
}));

router.get("/:slug/me/orders/:orderNo", resolveStore, identifyCustomer, requireCustomer, asyncH(async (req, res) => {
  const order = (await query(
    `select * from orders where enrollment_id=$1 and customer_id=$2 and order_no=$3`,
    [req.storeEnrollment.id, req.customer.sub, req.params.orderNo]
  )).rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  const items = (await query(`select * from order_items where order_id=$1`, [order.id])).rows;
  res.json({ order, items });
}));

export default router;
