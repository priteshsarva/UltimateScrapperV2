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
import { priceProduct, priceSqlExpr } from "./pricing.js";
import { sendOrderConfirmationEmail, sendOrderNotificationEmail } from "./mailer.js";
import { findProduct, isStale, rescrape } from "../core/refreshProduct.js";
import { applyBrandToRows, rawBrandsFor, canonicalBrand, subBrandsFor, rawBrandsForSub, brandInfo, primaryBrandSet } from "./brandMap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FOLDER = path.resolve(__dirname, "../databases");
const AVAIL_TEXT = `LOWER(CAST(COALESCE(availability,'0') AS TEXT))`;
const round2 = (n) => Math.round(n * 100) / 100;

// Background live-refresh gate — same shape as portal/productRefreshRoute.js:
// dedupe in-flight scrapes, a per-product cooldown, and a hard in-flight cap so
// a crawled storefront can't pile hundreds of Puppeteer jobs onto the 2-slot
// Chrome gate. This is what keeps the shared backend responsive.
const refreshing = new Set();
const lastAttempt = new Map();
const RETRY_COOLDOWN_MS = 60 * 1000;
const MAX_INFLIGHT = Math.max(1, parseInt(process.env.REFRESH_MAX_INFLIGHT, 10) || 4);

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

// this vendor's attached sources, joined to their scraped category (= db file),
// each carrying its per-store category_map ({ rawCatName: canonical }). The map
// is how a vendor renames/groups messy scraped category names ("Mens Watch",
// "Analog Watches For Men") into clean ones — the same map the plugin sync-feed
// applies; the storefront must apply it too or the vendor's renaming does nothing.
async function loadVendorSources(enrollmentId, dbName) {
  const { rows } = await query(
    `select es.source_id, es.categories, s.category as db_name, s.search_key
       from enrollment_sources es join sources s on s.id = es.source_id
      where es.enrollment_id = $1 ${dbName ? "and s.category = $2" : ""}`,
    dbName ? [enrollmentId, dbName] : [enrollmentId]
  );
  const maps = (await query(
    `select source_id, cat_name, canonical from category_map where enrollment_id=$1`,
    [enrollmentId]
  )).rows;
  const bySource = {};
  for (const m of maps) { (bySource[m.source_id] ||= {})[m.cat_name] = m.canonical; }
  for (const r of rows) r.catMap = bySource[r.source_id] || {};
  return rows;
}

// Distinct in-stock brands for a site's sources within one category DB. Powers
// the portal's brand-picker — same scope + shape as the public /facets brand
// list, so what a vendor can curate is exactly what shoppers can filter by.
// The featurable brands for a category — CANONICAL PRIMARY brands only (raw
// spellings folded into their primary via the brand map; sub-brands excluded),
// deduped and alphabetical. Storing a primary as a featured brand is correct:
// the storefront brand filter expands a primary back to all its raw variants.
export async function listSiteBrands(enrollmentId, dbName) {
  const catSources = await loadVendorSources(enrollmentId, dbName);
  if (!catSources.length) return [];
  const params = [];
  const scope = `(${sourceClauseSql(catSources, params)}) AND ${AVAIL_TEXT} IN ('1','true') AND CAST(productOriginalPrice AS REAL) > 0`;
  const rows = await runReadonly(
    dbName,
    `SELECT productBrand AS brand, COUNT(*) n FROM PRODUCTS
      WHERE ${scope} AND productBrand IS NOT NULL AND TRIM(productBrand) != ''
      GROUP BY LOWER(productBrand) HAVING n >= 2 AND LENGTH(productBrand) <= 60`,
    params
  ).catch(() => []);
  const primSet = await primaryBrandSet();
  const merged = new Map();
  for (const r of rows) {
    const primary = await canonicalBrand(r.brand);
    if (!primSet.has(String(primary).toLowerCase())) continue; // primaries only
    merged.set(primary, (merged.get(primary) || 0) + Number(r.n));
  }
  return [...merged].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
}

// rewrite a row's scraped catName to the vendor's canonical name, using the map
// of whichever source the row actually came from. Mutates + returns the row.
function applyCatMap(row, catSources) {
  const src = (catSources || []).find((s) => String(row.productFetchedFrom || "").includes(s.search_key));
  if (src && src.catMap && src.catMap[row.catName]) row.catName = src.catMap[row.catName];
  return row;
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

// availability is stored inconsistently by the scrapers (1 / '1' / true / 'true'
// / 0 / '0' / NULL). One JS-side normaliser, mirroring the AVAIL_TEXT SQL one,
// so "in stock" means the same thing on every code path.
const isInStock = (row) => ["1", "true"].includes(String(row.availability ?? "0").toLowerCase());

// THE tenant-ownership rule for a scraped row, in one place. A row belongs to a
// vendor only if it came from one of that vendor's attached sources AND (when
// that source has a category allow-list) its catName is in the list. This is the
// same rule the plugin's sync-feed WHERE-builder applies, expressed in JS.
// Every path that hands a product to a shopper — detail, suggestions, orders —
// must gate on this, or the shared category DB leaks across vendors.
function rowBelongsToSources(row, catSources) {
  return (catSources || []).some((s) =>
    String(row.productFetchedFrom || "").includes(s.search_key) &&
    (!Array.isArray(s.categories) || !s.categories.length || s.categories.includes(row.catName))
  );
}

// SQL form of the same rule: "(fetchedFrom LIKE key [AND catName IN (...)]) OR (...)".
// Pushes its bind params onto `params` so callers keep placeholder order.
function sourceClauseSql(catSources, params) {
  return catSources.map((s) => {
    let clause = "productFetchedFrom LIKE '%' || ? || '%'";
    params.push(s.search_key);
    if (Array.isArray(s.categories) && s.categories.length) {
      clause += ` AND catName IN (${s.categories.map(() => "?").join(",")})`;
      params.push(...s.categories);
    }
    return `(${clause})`;
  }).join(" OR ");
}

function priceRow(row, dbName, pricing) {
  const p = priceProduct(row.productOriginalPrice, pricing);
  const images = parseImages(row);
  return {
    productId: row.productId,
    dbName,
    productName: row.productName,
    productBrand: row.productBrand,
    subBrand: row.subBrand || null, // secondary/sub-brand from the global brand map
    catName: row.catName,
    sizes: parseSizes(row),
    thumbnail: row.featuredimg || images[0] || null,
    images,
    videoUrl: row.videoUrl || null,
    productShortDescription: row.productShortDescription,
    productDescription: row.productDescription,
    inStock: isInStock(row),
    price: p.price,
    mrp: p.mrp,
    savings_pct: p.savings_pct,
  };
}

// Public storefront URL of a product page — what an order should link to (NOT
// the scraped supplier productUrl). Prefers the platform subdomain in prod and a
// dev origin locally. STOREFRONT_DEV_URL overrides the localhost default.
export function productPageUrl(enr, dbName, productId) {
  const platform = (process.env.PLATFORM_HOST || "").replace(/^\.+|\.+$/g, "");
  if (platform) return `https://${enr.slug}.${platform}/p/${dbName}/${productId}`;
  const dev = (process.env.STOREFRONT_DEV_URL || "http://localhost:5175").replace(/\/+$/, "");
  return `${dev}/p/${dbName}/${productId}?store=${enr.slug}`;
}

function buildWhatsAppUrl(whatsapp, orderNo, items, total, address, storeName) {
  const inr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
  const L = [];
  L.push(`🛍️ *${storeName || "New order"}*`);
  L.push(`Order *${orderNo}*`);
  L.push("━━━━━━━━━━━━━");
  L.push("");
  items.forEach((li, i) => {
    L.push(`*${i + 1}. ${li.product_name}*`);
    L.push(`   ${li.size ? `Size ${li.size}  ·  ` : ""}Qty ${li.qty}  ·  ${inr(li.line_total)}`);
    if (li.page_url) L.push(`   🔗 ${li.page_url}`);
    L.push("");
  });
  L.push("━━━━━━━━━━━━━");
  L.push(`💰 *Total: ${inr(total)}*`);
  L.push("");
  L.push("📦 *Deliver to*");
  L.push(address.name);
  L.push(`${address.line1}${address.line2 ? ", " + address.line2 : ""}`);
  L.push(`${address.city}, ${address.state} - ${address.pincode}`);
  L.push(`📞 ${address.phone}`);
  L.push("");
  L.push("Please confirm my order 🙏");
  const phone = String(whatsapp).replace(/[^\d]/g, "");
  return `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(L.join("\n"))}`;
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

  // Category order carries NO built-in priority — it follows the vendor's nav
  // config when they've set one, else the store's own (DB) order. So the
  // "first/default category" everything falls back to is the vendor's choice.
  let categories = dbRows.map((r) => r.db_name);
  const navItems = (site.nav && Array.isArray(site.nav.items)) ? site.nav.items : [];
  if (navItems.length) {
    const rank = new Map(navItems.map((it, i) => [it.category, i]));
    categories = [...categories].sort((a, b) => (rank.has(a) ? rank.get(a) : 999) - (rank.has(b) ? rank.get(b) : 999));
  }

  res.json({
    slug: enr.slug,
    store_name: site.store_name || enr.slug,
    logo_url: site.logo_url || null,
    favicon_url: site.favicon_url || null,
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
    preset: site.preset || null,
    analytics: site.analytics || {},
    reviews: Array.isArray(site.reviews) ? site.reviews : [],
    categories,
    nav: site.nav && typeof site.nav === "object" ? site.nav : {},
  });
}));

// ============================================================ products

// Builds the shared WHERE for a listing/facets query from the request:
// source allow-list + stock + text + brand + displayed-price range. Returns
// { where, params, priceExpr } — priceExpr is the marked-up-price SQL used by
// the price filter and the price sort.
function buildListingWhere(req, catSources, pricing, brandRaws) {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const stock = req.query.stock === "in" ? "in" : req.query.stock === "out" ? "out" : "in"; // hide OOS by default
  // brandRaws (precomputed): the requested brands expanded to their raw variants
  // via the global brand map, so filtering by a canonical brand catches every
  // scraped spelling. Falls back to the literal query values.
  const brands = Array.isArray(brandRaws) ? brandRaws
    : [].concat(req.query.brand || []).flatMap((b) => String(b).split(",").map((x) => x.trim()).filter(Boolean));
  const priceMin = parseFloat(req.query.price_min);
  const priceMax = parseFloat(req.query.price_max);

  const params = [];
  const where = [`(${sourceClauseSql(catSources, params)})`];
  const priceExpr = priceSqlExpr(pricing);

  // a scrape that missed the price stores NULL/0 — never list a ₹0 product
  // (the order path already rejects it, so it could only frustrate a shopper)
  where.push(`CAST(productOriginalPrice AS REAL) > 0`);
  if (stock === "in") where.push(`${AVAIL_TEXT} IN ('1','true')`);
  else if (stock === "out") where.push(`${AVAIL_TEXT} NOT IN ('1','true')`);
  if (q) { where.push(`LOWER(productName) LIKE ?`); params.push(`%${q}%`); }
  if (brands.length) {
    where.push(`(${brands.map(() => `LOWER(productBrand) = ?`).join(" OR ")})`);
    params.push(...brands.map((b) => b.toLowerCase()));
  }
  if (isFinite(priceMin)) { where.push(`${priceExpr} >= ?`); params.push(priceMin); }
  if (isFinite(priceMax)) { where.push(`${priceExpr} <= ?`); params.push(priceMax); }

  // sub-category filter (?cat=): the DB stores RAW catNames; the vendor's map
  // rewrites them to canonicals. So filter by every raw whose canonical matches
  // the requested sub-category, plus the literal value (covers unmapped names).
  const subcat = (req.query.cat || "").toString().trim();
  if (subcat) {
    const raws = new Set([subcat]);
    for (const s of catSources) for (const [raw, canon] of Object.entries(s.catMap || {})) if (canon === subcat) raws.add(raw);
    where.push(`catName IN (${[...raws].map(() => "?").join(",")})`);
    params.push(...raws);
  }

  // size filter (?size=40,41): sizeName is a JSON array string like '["40","41"]'
  // — match any selected size as a substring of that array.
  const sizes = [].concat(req.query.size || []).flatMap((s) => String(s).split(",").map((x) => x.trim()).filter(Boolean));
  if (sizes.length) {
    where.push(`(${sizes.map(() => `sizeName LIKE ?`).join(" OR ")})`);
    params.push(...sizes.map((s) => `%"${s}"%`));
  }

  return { where: where.join(" AND "), params, priceExpr };
}

// requested brand(s) → their raw scraped variants via the global brand map.
// null = no brand filter. sub_brand is a list of "Primary::Secondary" pairs, so
// each brand narrows to ONLY its selected sub-brands while brands with no
// sub-brand selected still match in full. Deduped, lowercased.
async function expandBrands(req) {
  const brands = [].concat(req.query.brand || []).flatMap((b) => String(b).split(",").map((x) => x.trim()).filter(Boolean));
  if (!brands.length) return null;
  const subsByBrand = new Map(); // primary -> [secondary, ...]
  for (const pair of [].concat(req.query.sub_brand || []).flatMap((b) => String(b).split(",").map((x) => x.trim()).filter(Boolean))) {
    const [b, s] = pair.split("::");
    if (b && s) { if (!subsByBrand.has(b)) subsByBrand.set(b, []); subsByBrand.get(b).push(s); }
  }
  const parts = await Promise.all(brands.map(async (b) => {
    const subs = subsByBrand.get(b);
    if (subs && subs.length) return (await Promise.all(subs.map((s) => rawBrandsForSub(b, s)))).flat();
    return rawBrandsFor(b);
  }));
  return [...new Set(parts.flat().map((x) => x.toLowerCase()))];
}

const SORTS = {
  featured: "productId ASC",
  newest: "productDateCreation DESC, productId DESC",
  price_asc: "__PRICE__ ASC, productId ASC",
  price_desc: "__PRICE__ DESC, productId ASC",
};

// GET /store/:slug/products?category=&q=&stock=&brand=&price_min=&price_max=&sort=&page=&limit=
// Page-based (1-indexed) so sort + filters compose cleanly. OOS hidden by default.
router.get("/:slug/products", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const limit = Math.min(parseInt(req.query.limit, 10) || 24, 100);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * limit;

  const allSources = await loadVendorSources(enr.id);
  if (!allSources.length) return res.json({ page, count: 0, hasMore: false, results: [] });

  const site = await loadSiteSettings(enr.id);
  const category = (req.query.category || "").toString();
  const brandRaws = await expandBrands(req); // global brand map: canonical → raw variants

  // "all" = mix products from EVERY category the store sells (each category is
  // its own SQLite file). Query each, map to display rows, then interleave
  // (featured/newest) or globally sort (price) and page over the merged set.
  if (category === "all") {
    const dbNames = [...new Set(allSources.map((s) => s.db_name))];
    const need = offset + limit + 1; // enough to fill this page + know if there's more
    const lists = await Promise.all(dbNames.map(async (db) => {
      const catSrc = allSources.filter((s) => s.db_name === db);
      const { where, params, priceExpr } = buildListingWhere(req, catSrc, site.pricing, brandRaws);
      const order = (SORTS[req.query.sort] || SORTS.featured).replace("__PRICE__", priceExpr);
      const rows = await runReadonly(db, `SELECT * FROM PRODUCTS WHERE ${where} ORDER BY ${order} LIMIT ?`, [...params, need]).catch(() => []);
      await applyBrandToRows(rows);
      return rows.map((r) => priceRow(applyCatMap(r, catSrc), db, site.pricing));
    }));
    let merged;
    const sort = req.query.sort;
    if (sort === "price_asc") merged = [].concat(...lists).sort((a, b) => a.price - b.price);
    else if (sort === "price_desc") merged = [].concat(...lists).sort((a, b) => b.price - a.price);
    else { // featured/newest → round-robin so categories are visibly mixed, not grouped
      merged = [];
      for (let i = 0; merged.length < lists.reduce((n, l) => n + l.length, 0); i++) {
        for (const l of lists) if (l[i]) merged.push(l[i]);
      }
    }
    const pageRows = merged.slice(offset, offset + limit);
    return res.json({ page, count: pageRows.length, hasMore: merged.length > offset + limit, results: pageRows });
  }

  const dbName = category || allSources[0].db_name || "";
  const catSources = allSources.filter((s) => s.db_name === dbName);
  if (!catSources.length) return res.json({ page, count: 0, hasMore: false, results: [] });

  const { where, params, priceExpr } = buildListingWhere(req, catSources, site.pricing, brandRaws);
  const order = (SORTS[req.query.sort] || SORTS.featured).replace("__PRICE__", priceExpr);

  // fetch one extra row to know whether there's a next page without a COUNT(*)
  const sql = `SELECT * FROM PRODUCTS WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = await runReadonly(dbName, sql, [...params, limit + 1, offset]).catch(() => []);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  await applyBrandToRows(pageRows); // global brand map → canonical display brand
  res.json({ page, count: pageRows.length, hasMore, results: pageRows.map((r) => priceRow(applyCatMap(r, catSources), dbName, site.pricing)) });
}));

// GET /store/:slug/facets?category=  -> price bounds + brand list for the filter UI.
// Reflects the CURRENT source/stock scope so the slider never offers a price with
// no products behind it.
router.get("/:slug/facets", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const allSources = await loadVendorSources(enr.id);
  if (!allSources.length) return res.json({ price_min: 0, price_max: 0, brands: [] });
  const site = await loadSiteSettings(enr.id);
  const category = (req.query.category || "").toString();

  // "all" listing: merge price bounds across every category; skip the brand
  // list (brands aren't comparable across shoes+watches, so no brand filter).
  if (category === "all") {
    const priceExpr = priceSqlExpr(site.pricing);
    const dbNames = [...new Set(allSources.map((s) => s.db_name))];
    const boundsPer = await Promise.all(dbNames.map(async (db) => {
      const catSrc = allSources.filter((s) => s.db_name === db);
      const p = [];
      const scope = `(${sourceClauseSql(catSrc, p)}) AND ${AVAIL_TEXT} IN ('1','true') AND CAST(productOriginalPrice AS REAL) > 0`;
      return (await runReadonly(db, `SELECT MIN(${priceExpr}) lo, MAX(${priceExpr}) hi FROM PRODUCTS WHERE ${scope}`, p).catch(() => [{}]))[0] || {};
    }));
    const los = boundsPer.map((b) => b.lo).filter((n) => n != null);
    const his = boundsPer.map((b) => b.hi).filter((n) => n != null);
    return res.json({ price_min: Math.floor(los.length ? Math.min(...los) : 0), price_max: Math.ceil(his.length ? Math.max(...his) : 0), brands: [] });
  }

  const dbName = category || allSources[0].db_name || "";
  const catSources = allSources.filter((s) => s.db_name === dbName);
  if (!catSources.length) return res.json({ price_min: 0, price_max: 0, brands: [] });

  // scope = this category's sources + in-stock only (what a shopper can actually buy)
  const scopeParams = [];
  const scope = `(${sourceClauseSql(catSources, scopeParams)}) AND ${AVAIL_TEXT} IN ('1','true') AND CAST(productOriginalPrice AS REAL) > 0`;
  const priceExpr = priceSqlExpr(site.pricing);

  // Cascade: when a sub-category (?cat=) is picked, narrow the brand/size/price/
  // sub-brand facets to it (sub-categories themselves stay on the full category
  // so the shopper can switch). catScope adds the subcat clause to the base scope.
  const subcat = (req.query.cat || "").toString().trim();
  const catParams = [...scopeParams];
  let catScope = scope;
  if (subcat) {
    const raws = new Set([subcat]);
    for (const s of catSources) for (const [raw, canon] of Object.entries(s.catMap || {})) if (canon === subcat) raws.add(raw);
    catScope = `${scope} AND catName IN (${[...raws].map(() => "?").join(",")})`;
    catParams.push(...raws);
  }

  const bounds = (await runReadonly(
    dbName,
    `SELECT MIN(${priceExpr}) lo, MAX(${priceExpr}) hi FROM PRODUCTS WHERE ${catScope}`,
    catParams
  ).catch(() => [{}]))[0] || {};

  const brandRows = await runReadonly(
    dbName,
    `SELECT productBrand AS brand, COUNT(*) n FROM PRODUCTS
      WHERE ${catScope} AND productBrand IS NOT NULL AND TRIM(productBrand) != ''
      GROUP BY LOWER(productBrand)
      HAVING n >= 2 AND LENGTH(productBrand) <= 60`,
    catParams
  ).catch(() => []);

  // Fold raw spellings into their canonical PRIMARY brand and, under each, the
  // SECONDARY (sub-)brands — one nested tree so the filter shows a brand with its
  // own collapsible list of sub-brands. Alphabetical throughout.
  const primMap = new Map(); // primary -> { count, subs: Map(secondary -> count) }
  for (const r of brandRows) {
    const info = await brandInfo(r.brand);
    const primary = (info && info.primary) || r.brand;
    const secondary = info && info.secondary;
    if (!primMap.has(primary)) primMap.set(primary, { count: 0, subs: new Map() });
    const e = primMap.get(primary);
    e.count += Number(r.n);
    if (secondary) e.subs.set(secondary, (e.subs.get(secondary) || 0) + Number(r.n));
  }
  // keep only clean canonical brands in the filter — unmapped raw/garbled
  // spellings (SKU junk) are dropped from the facet (products still show them).
  const primSet = await primaryBrandSet();
  const brands = [...primMap]
    .filter(([name]) => primSet.has(String(name).toLowerCase()))
    .map(([name, e]) => ({
      name, count: e.count,
      subBrands: [...e.subs].map(([n, c]) => ({ name: n, count: c })).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 120);

  // sub-categories (canonical, via the vendor's category map) with in-stock counts
  // — on the FULL category (not narrowed) so the shopper can switch between them.
  const subRows = await runReadonly(
    dbName,
    `SELECT productFetchedFrom ff, catName, COUNT(*) n FROM PRODUCTS
      WHERE ${scope} AND catName IS NOT NULL AND TRIM(catName) != ''
      GROUP BY productFetchedFrom, catName`,
    scopeParams
  ).catch(() => []);
  const subMap = new Map();
  for (const r of subRows) {
    const src = catSources.find((s) => String(r.ff || "").includes(s.search_key));
    const canon = (src && src.catMap && src.catMap[r.catName]) || r.catName;
    subMap.set(canon, (subMap.get(canon) || 0) + Number(r.n));
  }
  const subcategories = [...subMap].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));

  // sizes: distinct values pulled from the JSON-array sizeName. ponytail: sampled
  // to 5000 rows to bound the scan — the size vocabulary is tiny (e.g. 36–47), so
  // a sample catches them all without reading every row in an 80k-product DB.
  const sizeRows = await runReadonly(
    dbName,
    `SELECT sizeName FROM PRODUCTS WHERE ${catScope} AND sizeName IS NOT NULL AND sizeName != '' AND sizeName != '[]' LIMIT 5000`,
    catParams
  ).catch(() => []);
  const sizeSet = new Set();
  for (const r of sizeRows) { try { for (const s of JSON.parse(r.sizeName) || []) if (s != null && String(s).trim()) sizeSet.add(String(s).trim()); } catch { /* skip */ } }
  const sizes = [...sizeSet].sort((a, b) => (parseFloat(a) - parseFloat(b)) || String(a).localeCompare(String(b))).slice(0, 60);

  res.json({
    price_min: Math.floor(bounds.lo || 0),
    price_max: Math.ceil(bounds.hi || 0),
    brands,
    subcategories,
    sizes,
  });
}));

// GET /store/:slug/subcategories?category=  -> the vendor's sub-categories for a
// parent category: distinct in-stock catNames rewritten through the category map
// to their canonical names. Powers the menu dropdown under each category. Unmapped
// raw names are included unless the vendor hides them (site.nav.hide_unmapped).
router.get("/:slug/subcategories", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const category = (req.query.category || "").toString();
  if (!category || category === "all") return res.json({ subcategories: [] });
  const catSources = await loadVendorSources(enr.id, category);
  if (!catSources.length) return res.json({ subcategories: [] });
  const site = await loadSiteSettings(enr.id);
  const showUnmapped = !(site.nav && site.nav.hide_unmapped);

  const p = [];
  const scope = `(${sourceClauseSql(catSources, p)}) AND ${AVAIL_TEXT} IN ('1','true') AND CAST(productOriginalPrice AS REAL) > 0`;
  const rows = await runReadonly(
    category,
    `SELECT DISTINCT productFetchedFrom, catName FROM PRODUCTS WHERE ${scope} AND catName IS NOT NULL AND TRIM(catName) != ''`,
    p
  ).catch(() => []);
  const byName = new Map(); // display name -> was it mapped?
  for (const r of rows) {
    const src = catSources.find((s) => String(r.productFetchedFrom || "").includes(s.search_key));
    const canon = src && src.catMap && src.catMap[r.catName];
    if (!canon && !showUnmapped) continue;
    const name = canon || r.catName;
    if (!byName.has(name)) byName.set(name, !!canon);
  }
  res.json({ subcategories: [...byName].map(([name, mapped]) => ({ name, mapped })).sort((a, b) => a.name.localeCompare(b.name)) });
}));

// GET /store/:slug/menu — the full menu tree in one call:
//   primary category → secondary categories (canonical, in-stock) → brands
//     (canonical, in-stock). Vendor-curated featured brands are pinned first,
//     then auto-derived brands fill the rest ("both ways").
router.get("/:slug/menu", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const site = await loadSiteSettings(enr.id);
  const allSources = await loadVendorSources(enr.id);
  if (!allSources.length) return res.json({ menu: [] });
  const showUnmapped = !(site.nav && site.nav.hide_unmapped);
  const curated = Array.isArray(site.nav?.brands) ? site.nav.brands.filter((b) => b && b.brand) : [];
  const navItems = (site.nav && Array.isArray(site.nav.items)) ? site.nav.items : [];
  const labelOf = (db) => navItems.find((i) => i.category === db)?.label || (db.charAt(0).toUpperCase() + db.slice(1));

  // primary categories in the vendor's order
  let dbNames = [...new Set(allSources.map((s) => s.db_name))];
  if (navItems.length) {
    const rank = new Map(navItems.map((it, i) => [it.category, i]));
    dbNames = dbNames.sort((a, b) => (rank.has(a) ? rank.get(a) : 999) - (rank.has(b) ? rank.get(b) : 999));
  }

  const menu = [];
  for (const db of dbNames) {
    const catSrc = allSources.filter((s) => s.db_name === db);
    const p = [];
    const scope = `(${sourceClauseSql(catSrc, p)}) AND ${AVAIL_TEXT} IN ('1','true') AND CAST(productOriginalPrice AS REAL) > 0`;
    const rows = await runReadonly(
      db,
      `SELECT productFetchedFrom ff, catName, productBrand brand, COUNT(*) n FROM PRODUCTS
        WHERE ${scope} AND catName IS NOT NULL AND TRIM(catName) != ''
        GROUP BY productFetchedFrom, catName, productBrand`,
      p
    ).catch(() => []);

    const bySub = new Map(); // canonical subcat -> Map(canonical brand -> count)
    for (const r of rows) {
      const src = catSrc.find((s) => String(r.ff || "").includes(s.search_key));
      const canonCat = (src && src.catMap && src.catMap[r.catName]);
      if (!canonCat && !showUnmapped) continue;
      const subName = canonCat || r.catName;
      if (!bySub.has(subName)) bySub.set(subName, new Map());
      if (r.brand && String(r.brand).trim()) {
        const brand = await canonicalBrand(r.brand);
        const bm = bySub.get(subName);
        bm.set(brand, (bm.get(brand) || 0) + Number(r.n));
      }
    }

    const curatedForDb = curated.filter((b) => b.category === db).map((b) => String(b.brand).toLowerCase());
    const subcategories = [...bySub].map(([name, bm]) => {
      let brands = [...bm].map(([bn, count]) => ({ name: bn, count }));
      brands.sort((a, b) => {
        const ac = curatedForDb.includes(a.name.toLowerCase()) ? 0 : 1;
        const bc = curatedForDb.includes(b.name.toLowerCase()) ? 0 : 1;
        return ac !== bc ? ac - bc : b.count - a.count;
      });
      return { name, brands: brands.slice(0, 12).map((b) => b.name) };
    }).sort((a, b) => a.name.localeCompare(b.name));

    menu.push({ category: db, label: labelOf(db), subcategories });
  }
  res.json({ menu });
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
  // sources, not just be in the same shared category DB — otherwise any
  // productId in the file would leak across vendors who don't sell that source.
  if (!rowBelongsToSources(row, catSources)) return res.status(404).json({ error: "Product not found" });

  const site = await loadSiteSettings(enr.id);
  // The suggestions rail is gated by the SAME source allow-list as the listing.
  // Filtering on catName alone would surface other vendors' products out of the
  // shared category DB — priced with this vendor's markup, and every tile a dead
  // link, since the detail route above correctly rejects them.
  // OOS is excluded too: a shopper here is deciding whether to buy.
  const simParams = [];
  const simSourceSql = sourceClauseSql(catSources, simParams);
  const similar = await runReadonly(
    dbName,
    `SELECT * FROM PRODUCTS
      WHERE catName = ? AND productId != ? AND ${AVAIL_TEXT} IN ('1','true')
        AND (${simSourceSql})
      ORDER BY RANDOM() LIMIT 8`,
    [row.catName, id, ...simParams]
  ).catch(() => []);

  await applyBrandToRows([row, ...similar]); // global brand map → primary brand + sub-brand
  res.json({
    product: priceRow(applyCatMap(row, catSources), dbName, site.pricing),
    similar: similar.map((r) => priceRow(applyCatMap(r, catSources), dbName, site.pricing)),
  });
}));

// POST /store/:slug/products/:dbName/:id/refresh
// Public, tenant-scoped live re-scrape. Replaces the storefront's old call to
// /dev/update-single-product, which returned the RAW SQLite row (leaking
// productOriginalPrice = supplier cost, and productFetchedFrom = which supplier
// site) to every shopper's network tab, and blocked on Chrome with no dedupe.
// This one returns ONLY a status — never product data — and triggers the same
// rate-limited background scrape the plugin refresh uses. The SPA re-reads the
// product through the redacted detail endpoint afterwards to show fresh values.
router.post("/:slug/products/:dbName/:id/refresh", resolveStore, asyncH(async (req, res) => {
  const enr = req.storeEnrollment;
  const dbName = req.params.dbName;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid product id" });

  const catSources = await loadVendorSources(enr.id, dbName);
  if (!catSources.length) return res.status(404).json({ error: "Not found" });

  const product = await findProduct(id, dbName).catch(() => null);
  // ownership gate: only re-scrape a product this vendor actually sells
  if (!product || !rowBelongsToSources(product, catSources))
    return res.status(404).json({ error: "Not found" });

  if (!isStale(product)) return res.json({ status: "fresh" });

  const key = dbName + ":" + id;
  const recentlyTried = lastAttempt.has(key) && Date.now() - lastAttempt.get(key) < RETRY_COOLDOWN_MS;
  if (!refreshing.has(key) && !recentlyTried && refreshing.size < MAX_INFLIGHT) {
    if (lastAttempt.size > 20000) lastAttempt.clear();
    refreshing.add(key);
    lastAttempt.set(key, Date.now());
    rescrape(product, dbName)
      .catch(() => {})
      .finally(() => refreshing.delete(key));
  }
  res.json({ status: "refreshing" });
}));

// ============================================================ customer auth

router.post("/:slug/auth/signup", resolveStore, asyncH(async (req, res) => {
  const { email, password, name, phone } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const em = String(email).toLowerCase().trim();
  const hash = await hashPassword(password);

  // If a guest account (from a past checkout) exists for this email, CLAIM it by
  // setting the password. If it already has a password, tell them to log in.
  const existing = (await query(
    `select id, password_hash from customers where enrollment_id=$1 and lower(email)=$2`,
    [req.storeEnrollment.id, em]
  )).rows[0];
  if (existing && existing.password_hash)
    return res.status(409).json({ error: "An account with this email already exists — please log in." });

  const row = existing
    ? (await query(
        `update customers set password_hash=$1, name=coalesce($2,name), phone=coalesce($3,phone)
         where id=$4 returning id, enrollment_id, email, name, phone`,
        [hash, name || null, phone || null, existing.id]
      )).rows[0]
    : (await query(
        `insert into customers (enrollment_id, email, password_hash, name, phone)
         values ($1,$2,$3,$4,$5) returning id, enrollment_id, email, name, phone`,
        [req.storeEnrollment.id, em, hash, name || null, phone || null]
      )).rows[0];
  res.json({ token: signCustomerToken(row), customer: row });
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
  // an unclaimed guest account (auto-created at checkout) has no password yet
  if (customer && !customer.password_hash)
    return res.status(409).json({ error: "You checked out as a guest with this email. Sign up to set a password and claim your account." });
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
  // fall back to the signed-in shopper's own address so the confirmation email
  // actually has somewhere to go (the storefront doesn't collect it separately)
  const email = buyer_email || (req.customer && req.customer.email) || null;

  const site = await loadSiteSettings(enr.id);
  if (!site.whatsapp) return res.status(400).json({ error: "This store hasn't set up WhatsApp checkout yet" });

  // The cart arrives from the browser, so every line has to be re-validated here:
  // the product must exist, be sold BY THIS VENDOR, and still be in stock. Without
  // the ownership gate this endpoint would price and sell any product in any
  // category file on the box — and an arbitrary db_name would reach path.join()
  // inside runReadonly(). Sources are grouped by db so this costs one query total.
  const allSources = await loadVendorSources(enr.id);
  const sourcesByDb = new Map();
  for (const s of allSources) {
    if (!sourcesByDb.has(s.db_name)) sourcesByDb.set(s.db_name, []);
    sourcesByDb.get(s.db_name).push(s);
  }

  const lineItems = [];
  for (const it of items) {
    const dbName = String(it.db_name || "");
    const productId = parseInt(it.product_id, 10);
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    if (!dbName || !productId) return res.status(400).json({ error: "That cart contains an invalid item." });

    const catSources = sourcesByDb.get(dbName);
    if (!catSources) return res.status(400).json({ error: "This store doesn't sell one of those products." });

    // no .catch here on purpose: a DB error must fail the order loudly rather
    // than silently dropping a line and charging the shopper less than they saw.
    const rows = await runReadonly(dbName, `SELECT * FROM PRODUCTS WHERE productId=?`, [productId]);
    const row = rows[0];
    if (!row || !rowBelongsToSources(row, catSources))
      return res.status(400).json({ error: "This store doesn't sell one of those products." });
    if (!isInStock(row))
      return res.status(409).json({ error: `"${row.productName}" just went out of stock.` });

    const priced = priceProduct(row.productOriginalPrice, site.pricing);
    if (!priced.price || priced.price <= 0)
      return res.status(409).json({ error: `"${row.productName}" is not available to order right now.` });

    const images = parseImages(row);
    lineItems.push({
      product_id: String(productId), db_name: dbName, product_name: row.productName,
      size: it.size ? String(it.size).slice(0, 40) : null,
      image_url: row.featuredimg || images[0] || null,
      page_url: productPageUrl(enr, dbName, productId), // storefront product page (not the supplier URL)
      unit_price: priced.price, qty, line_total: round2(priced.price * qty),
    });
  }
  if (!lineItems.length) return res.status(400).json({ error: "No valid items to order" });

  const subtotal = round2(lineItems.reduce((s, li) => s + li.line_total, 0));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Auto-create (or reuse) a customer account for guest checkouts so the order
    // is tracked under an account, and LOG THE BUYER IN afterwards by handing back
    // a session token. A guest account has no password ("unclaimed") until the
    // buyer signs up with the same email and sets one.
    //   - new email            -> create the account + issue a login token
    //   - existing UNCLAIMED    -> reuse it + issue a login token (they're a guest)
    //   - existing CLAIMED      -> attach the order, but NEVER issue a token on an
    //                              email alone (that would hijack a password-
    //                              protected account); the buyer must log in.
    let customerId = req.customer ? req.customer.sub : null;
    let loginToken = null;      // set when we can safely log the buyer in
    let accountExists = false;  // a password-protected account already owns this email
    const cleanEmail = email ? String(email).toLowerCase().trim() : null;
    if (!customerId && cleanEmail) {
      const existing = (await client.query(
        `select id, password_hash from customers where enrollment_id=$1 and lower(email)=lower($2)`, [enr.id, cleanEmail]
      )).rows[0];
      if (existing) {
        customerId = existing.id;
        if (existing.password_hash) accountExists = true;
        else loginToken = signCustomerToken({ id: existing.id, enrollment_id: enr.id, email: cleanEmail });
      } else {
        customerId = (await client.query(
          `insert into customers (enrollment_id, email, password_hash, name, phone)
           values ($1,$2,null,$3,$4) returning id`,
          [enr.id, cleanEmail, name, phone]
        )).rows[0].id;
        loginToken = signCustomerToken({ id: customerId, enrollment_id: enr.id, email: cleanEmail });
      }
    }

    const order = (await client.query(
      `insert into orders (enrollment_id, customer_id, buyer_name, buyer_phone, buyer_email, address, subtotal, total, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id, order_no`,
      [enr.id, customerId, name, phone, email,
       JSON.stringify(shipTo), subtotal, subtotal, note || null]
    )).rows[0];

    for (const li of lineItems) {
      await client.query(
        `insert into order_items (order_id, product_id, db_name, product_name, size, image_url, unit_price, qty, line_total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, li.product_id, li.db_name, li.product_name, li.size, li.image_url, li.unit_price, li.qty, li.line_total]
      );
    }
    await client.query("COMMIT");

    const wa_url = buildWhatsAppUrl(site.whatsapp, order.order_no, lineItems, subtotal, { ...shipTo, phone }, site.store_name || enr.slug);

    // Fire-and-forget order emails. Failures are logged inside sendMail;
    // never let a mailer hiccup break the checkout response.
    const storeName = site.store_name || enr.slug;
    const emailPayload = {
      storeName, orderNo: order.order_no, total: subtotal,
      items: lineItems, address: { ...shipTo, phone },
    };
    if (email) sendOrderConfirmationEmail({ ...emailPayload, buyerName: name, buyerEmail: email, whatsappUrl: wa_url }).catch(() => {});
    (async () => {
      try {
        // Order notification goes to the STOREFRONT's own email (site.email) when
        // set; otherwise fall back to the client/vendor account email.
        let notifyTo = site.email && String(site.email).trim();
        if (!notifyTo) {
          const vendor = (await query(`select u.email from users u join enrollments e on e.user_id=u.id where e.id=$1`, [enr.id])).rows[0];
          notifyTo = vendor?.email;
        }
        if (notifyTo) sendOrderNotificationEmail({ ...emailPayload, vendorEmail: notifyTo, buyerName: name, buyerPhone: phone });
      } catch (e) { console.error("[order-email vendor] lookup failed:", e.message); }
    })();

    // Hand back a session when we could safely create/reuse an unclaimed account,
    // so the buyer is logged in right after checkout. account_exists tells the
    // storefront to invite them to log in to their existing (password) account.
    const loginCustomer = loginToken ? { id: customerId, email: cleanEmail, name, phone } : null;
    res.json({ order_no: order.order_no, total: subtotal, wa_url, token: loginToken, customer: loginCustomer, account_exists: accountExists });
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
