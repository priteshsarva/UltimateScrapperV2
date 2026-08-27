// Client-facing catalogue research: browse the RAW scraped products across ALL
// source sites we hold, with the supplier product URL + source name (so a vendor
// can see where a product comes from and open it). Read-only over the SQLite
// category files. This intentionally exposes the supplier link — it's the
// vendor's own research tool, NOT the shopper-facing storefront.
//   app.use("/portal", catalogueRoutes)  ->  GET /portal/catalogue
import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FOLDER = path.resolve(__dirname, "../databases");
const CATEGORIES = ["watches", "shoes"];

function runReadonly(dbName, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(DB_FOLDER, `${dbName}.db`), sqlite3.OPEN_READONLY, (e) => {
      if (e) return reject(e);
      db.all(sql, params, (err, rows) => { db.close(); if (err) reject(err); else resolve(rows || []); });
    });
  });
}
const parseImages = (row) => { try { const a = JSON.parse(row.imageUrl); return Array.isArray(a) ? a.filter(Boolean) : []; } catch { return row.imageUrl ? [row.imageUrl] : []; } };
const parseSizes = (row) => { try { const a = JSON.parse(row.sizeName); return Array.isArray(a) ? a.filter(Boolean) : []; } catch { return []; } };

const router = Router();
router.use(requireAuth);

// GET /portal/catalogue?q=&category=&page=&limit=
router.get("/catalogue", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const cat = (req.query.category || "").toString();
    const stock = (req.query.stock || "").toString();        // in | out | "" (all)
    const size = (req.query.size || "").toString().trim();
    const brand = (req.query.brand || "").toString().trim().toLowerCase();
    const source = (req.query.source || "").toString();
    const sort = (req.query.sort || "").toString();
    const priceMin = parseFloat(req.query.price_min);
    const priceMax = parseFloat(req.query.price_max);
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 60);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const sources = (await query(`select id, name, search_key, category from sources`)).rows;
    const sourceFor = (fetchedFrom, category) =>
      sources.find((s) => s.category === category && s.search_key && fetchedFrom && String(fetchedFrom).includes(s.search_key));

    // a selected source pins the category + its own products
    const srcRow = source ? sources.find((s) => s.id === source) : null;
    let cats = CATEGORIES.includes(cat) ? [cat] : CATEGORIES;
    if (srcRow) cats = [srcRow.category];

    const AV = `LOWER(CAST(COALESCE(availability,'0') AS TEXT))`;
    const SORTS = {
      newest: "productLastUpdated DESC",
      price_asc: "CAST(productOriginalPrice AS REAL) ASC",
      price_desc: "CAST(productOriginalPrice AS REAL) DESC",
      name: "productName COLLATE NOCASE ASC",
    };
    const orderBy = SORTS[sort] || SORTS.newest;

    const buildWhere = () => {
      const where = [`CAST(productOriginalPrice AS REAL) > 0`];
      const params = [];
      if (q) { where.push(`(LOWER(productName) LIKE ? OR LOWER(productBrand) LIKE ?)`); params.push(`%${q}%`, `%${q}%`); }
      if (stock === "in") where.push(`${AV} IN ('1','true')`);
      else if (stock === "out") where.push(`${AV} NOT IN ('1','true')`);
      if (size) { where.push(`sizeName LIKE ?`); params.push(`%"${size}"%`); } // sizeName is a JSON array
      if (brand) { where.push(`LOWER(productBrand) LIKE ?`); params.push(`%${brand}%`); }
      if (isFinite(priceMin)) { where.push(`CAST(productOriginalPrice AS REAL) >= ?`); params.push(priceMin); }
      if (isFinite(priceMax)) { where.push(`CAST(productOriginalPrice AS REAL) <= ?`); params.push(priceMax); }
      if (srcRow) { where.push(`productFetchedFrom LIKE ?`); params.push(`%${srcRow.search_key}%`); }
      return { clause: where.join(" AND "), params };
    };
    const need = offset + limit + 1;

    const lists = await Promise.all(cats.map(async (c) => {
      const { clause, params } = buildWhere();
      const rows = await runReadonly(
        c,
        `SELECT productId, productName, productBrand, productOriginalPrice, productUrl, productFetchedFrom,
                featuredimg, imageUrl, sizeName, catName, availability
           FROM PRODUCTS WHERE ${clause} ORDER BY ${orderBy} LIMIT ?`,
        [...params, need]
      ).catch(() => []);
      return rows.map((r) => {
        const src = sourceFor(r.productFetchedFrom, c);
        const imgs = parseImages(r);
        return {
          category: c,
          productId: r.productId,
          name: r.productName,
          brand: r.productBrand,
          original_price: Math.round(Number(r.productOriginalPrice) || 0),
          image: r.featuredimg || imgs[0] || null,
          sizes: parseSizes(r),
          catName: r.catName,
          in_stock: ["1", "true"].includes(String(r.availability ?? "0").toLowerCase()),
          product_url: r.productUrl, // supplier link — opens in a new tab
          source_name: src ? src.name : (String(r.productFetchedFrom || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "—"),
        };
      });
    }));

    // merge the per-category lists. For price/name sorts, sort the merged set so
    // the ordering holds across categories; for "newest" (default) interleave
    // round-robin so both categories are represented near the top.
    let merged;
    if (sort === "price_asc") merged = [].concat(...lists).sort((a, b) => a.original_price - b.original_price);
    else if (sort === "price_desc") merged = [].concat(...lists).sort((a, b) => b.original_price - a.original_price);
    else if (sort === "name") merged = [].concat(...lists).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    else {
      merged = [];
      const total = lists.reduce((n, l) => n + l.length, 0);
      for (let i = 0; merged.length < total; i++) for (const l of lists) if (l[i]) merged.push(l[i]);
    }
    const pageRows = merged.slice(offset, offset + limit);
    res.json({ page, count: pageRows.length, hasMore: merged.length > offset + limit, results: pageRows });
  } catch (e) {
    console.error("[catalogue]", e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
