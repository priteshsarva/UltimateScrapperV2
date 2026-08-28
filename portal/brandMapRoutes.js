// Super-admin GLOBAL brand mapping. Maps raw scraped brand strings to clean
// canonical names, applied across every storefront (display + facets + filter).
//   app.use("/portal/admin", brandMapRoutes)  -> /portal/admin/brand-map, /brands
import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { invalidateBrandMap } from "./brandMap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FOLDER = path.resolve(__dirname, "../databases");
const CATEGORIES = ["watches", "shoes"];
const readAll = (dbName, sql, p = []) => new Promise((resolve) => {
  const db = new sqlite3.Database(path.join(DB_FOLDER, `${dbName}.db`), sqlite3.OPEN_READONLY, (e) => {
    if (e) return resolve([]);
    db.all(sql, p, (err, rows) => { db.close(); resolve(err ? [] : rows || []); });
  });
});

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /portal/admin/brand-map -> all mappings (canonical = primary brand)
router.get("/brand-map", async (_req, res) => {
  try { res.json({ mappings: (await query(`select raw, canonical, secondary, updated_at from brand_map order by canonical, secondary nulls first, raw`)).rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /portal/admin/brand-map  { raw, canonical (primary), secondary? }  -> upsert
router.put("/brand-map", async (req, res) => {
  const raw = (req.body?.raw || "").toString().trim();
  const canonical = (req.body?.canonical || "").toString().trim();
  const secondary = (req.body?.secondary || "").toString().trim() || null;
  if (!raw || !canonical) return res.status(400).json({ error: "raw and primary brand required" });
  try {
    await query(
      `insert into brand_map (raw, canonical, secondary) values ($1,$2,$3)
       on conflict (raw) do update set canonical = excluded.canonical, secondary = excluded.secondary, updated_at = now()`,
      [raw.toLowerCase(), canonical, secondary]
    );
    invalidateBrandMap();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /portal/admin/brand-map/:raw
router.delete("/brand-map/:raw", async (req, res) => {
  try {
    await query(`delete from brand_map where raw = $1`, [decodeURIComponent(req.params.raw).toLowerCase()]);
    invalidateBrandMap();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /portal/admin/brands?q=&category= -> distinct raw brands across products
// (the pool the admin maps from). Merged across category DBs.
router.get("/brands", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const cat = (req.query.category || "").toString();
    const cats = CATEGORIES.includes(cat) ? [cat] : CATEGORIES;
    const where = ["productBrand IS NOT NULL", "TRIM(productBrand) != ''"];
    const p = [];
    if (q) { where.push("LOWER(productBrand) LIKE ?"); p.push(`%${q}%`); }
    const lists = await Promise.all(cats.map((c) =>
      readAll(c, `SELECT productBrand AS brand, COUNT(*) n FROM PRODUCTS WHERE ${where.join(" AND ")} GROUP BY LOWER(productBrand) HAVING n >= 2 ORDER BY n DESC LIMIT 300`, p)
    ));
    const merged = new Map();
    for (const rows of lists) for (const r of rows) merged.set(r.brand, (merged.get(r.brand) || 0) + Number(r.n));
    // keep the 300 most-common (bound), then sort ALPHABETICALLY for the admin list
    const brands = [...merged].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 300)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ brands });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
