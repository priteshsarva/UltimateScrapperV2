// Catalogue scan: keep the platform's view of what's in the product DBs current.
//   - categories: refresh per-source counts + auto enable/disable (categories.js)
//   - brands: extract every distinct scraped brand; when a genuinely NEW brand
//     appears that isn't in the global brand map yet, record it and notify the
//     super-admin so they can map it.
// Runs on server start and on a daily schedule.
import path from "path";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";
import { query } from "./db.js";
import { notify } from "./notifications.js";
import { refreshAllSourceCategoriesFromDB } from "./categories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FOLDER = path.resolve(__dirname, "../databases");
const CATEGORIES = ["watches", "shoes"];

const readAll = (dbName, sql) => new Promise((resolve) => {
  const db = new sqlite3.Database(path.join(DB_FOLDER, `${dbName}.db`), sqlite3.OPEN_READONLY, (e) => {
    if (e) return resolve([]);
    db.all(sql, [], (err, rows) => { db.close(); resolve(err ? [] : rows || []); });
  });
});

// Extract distinct brands across the product DBs; add newly-seen ones to
// known_brands; notify the admin about new brands that still need a mapping.
export async function refreshKnownBrands() {
  const scanned = new Map(); // lower -> original spelling
  for (const cat of CATEGORIES) {
    // same sanity filter the mapping UI uses: real brands appear on ≥2 products
    // and are short — this excludes SKU-junk that pollutes the productBrand field.
    const rows = await readAll(cat, `SELECT productBrand AS b, COUNT(*) n FROM PRODUCTS
      WHERE productBrand IS NOT NULL AND TRIM(productBrand) != ''
      GROUP BY LOWER(productBrand) HAVING n >= 2 AND LENGTH(productBrand) <= 40`);
    for (const r of rows) {
      const orig = String(r.b).trim();
      if (orig) scanned.set(orig.toLowerCase(), orig);
    }
  }

  const known = new Set((await query(`select raw_lower from known_brands`)).rows.map((r) => r.raw_lower));
  const mapped = new Set((await query(`select raw from brand_map`)).rows.map((r) => String(r.raw).toLowerCase()));

  const fresh = [...scanned].filter(([lw]) => !known.has(lw));
  if (fresh.length) {
    // bulk insert the newly-seen brands
    const vals = fresh.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(",");
    const params = fresh.flatMap(([lw, orig]) => [lw, orig]);
    await query(`insert into known_brands (raw_lower, raw) values ${vals} on conflict (raw_lower) do nothing`, params);
  }

  // First-ever run seeds the table silently (everything is "new") — don't dump a
  // notification listing hundreds of brands. Only notify on later runs.
  const firstRun = known.size === 0;
  const newUnmapped = fresh.filter(([lw]) => !mapped.has(lw)).map(([, orig]) => orig);
  if (!firstRun && newUnmapped.length) {
    const shown = newUnmapped.slice(0, 40);
    await notify({
      audience: "admin",
      type: "new_brands",
      title: `${newUnmapped.length} new brand${newUnmapped.length === 1 ? "" : "s"} need mapping`,
      body: `New scraped brand${newUnmapped.length === 1 ? "" : "s"} with no global mapping yet: ${shown.join(", ")}${newUnmapped.length > shown.length ? "…" : ""}. Map them in Brand mapping.`,
      meta: { brands: newUnmapped.slice(0, 200) },
    }).catch(() => {});
  }

  return { scanned: scanned.size, new: fresh.length, unmapped: newUnmapped.length, firstRun };
}

// Both scans together: categories + brands from the product DBs.
export async function runCatalogueScan() {
  const out = {};
  try { out.categories = await refreshAllSourceCategoriesFromDB(); }
  catch (e) { console.error("[scan] categories:", e.message); out.categories = null; }
  try { out.brands = await refreshKnownBrands(); }
  catch (e) { console.error("[scan] brands:", e.message); out.brands = null; }
  return out;
}
