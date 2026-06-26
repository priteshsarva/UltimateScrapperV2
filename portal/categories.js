// Category discovery + access.
//  - Existing sources: read clean per-source categories from SQLite PRODUCTS (instant).
//  - New sources (approval): live-scrape the category page first.
//  - Stored in Supabase source_categories; admin enable/disable is preserved on refresh.
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "./db.js";
import { getSource, listSources } from "./sources.js";
import { scrapeCategoriesA, scrapeCategoriesB } from "./scrapeCategories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// databases/ sits at the server root (sibling of portal/). Adjust if yours differs.
const DB_FOLDER = path.resolve(__dirname, "../databases");

function openReadonly(category) {
  const file = path.join(DB_FOLDER, `${category}.db`);
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) =>
      err ? reject(err) : resolve(db)
    );
  });
}
const allAsync = (db, sql, p = []) =>
  new Promise((res, rej) => db.all(sql, p, (e, rows) => (e ? rej(e) : res(rows || []))));
const closeAsync = (db) => new Promise((res) => db.close(() => res()));

// Clean per-source categories from PRODUCTS.
// Scoped by productFetchedFrom; excludes empty + corrupted comma-joined catNames.
async function readCategoriesFromDB(source) {
  const db = await openReadonly(source.category);
  try {
    const rows = await allAsync(
      db,
      `SELECT catName AS name, COUNT(*) AS c
         FROM PRODUCTS
        WHERE productFetchedFrom LIKE '%' || ? || '%'
          AND catName IS NOT NULL
          AND TRIM(catName) <> ''
          AND catName NOT LIKE '%,%'
        GROUP BY catName`,
      [source.search_key]
    );
    // name + count only. slug/img are NOT taken from the CATEGORIES table because
    // that table is globally deduped (it would borrow another source's slug/img).
    // Accurate slug/img come from the live category-page scrape instead.
    return rows.map((r) => ({ name: r.name, count: r.c }));
  } finally {
    await closeAsync(db);
  }
}

// per-source { catName -> product_count }, for merging into live-scraped categories
async function readCategoryCounts(source) {
  const db = await openReadonly(source.category);
  try {
    const rows = await allAsync(
      db,
      `SELECT catName AS name, COUNT(*) AS c
         FROM PRODUCTS
        WHERE productFetchedFrom LIKE '%' || ? || '%'
          AND catName IS NOT NULL
          AND TRIM(catName) <> ''
          AND catName NOT LIKE '%,%'
        GROUP BY catName`,
      [source.search_key]
    );
    return new Map(rows.map((r) => [r.name, r.c]));
  } finally {
    await closeAsync(db);
  }
}

async function upsertCategories(sourceId, cats, { withCount = true } = {}) {
  for (const c of cats) {
    await query(
      `insert into source_categories (source_id, cat_name, slug, img, product_count)
       values ($1,$2,$3,$4,$5)
       on conflict (source_id, cat_name) do update set
         product_count = case when $6 then excluded.product_count else source_categories.product_count end,
         slug          = coalesce(excluded.slug, source_categories.slug),
         img           = coalesce(excluded.img, source_categories.img),
         updated_at    = now()`,
      [sourceId, c.name, c.slug || null, c.img || null, c.count || 0, withCount]
    );
  }
}

// Existing source: instant, from products already in SQLite.
export async function refreshSourceCategoriesFromDB(sourceId) {
  const source = await getSource(sourceId);
  if (!source) throw new Error("Source not found");
  const cats = await readCategoriesFromDB(source);
  await upsertCategories(sourceId, cats, { withCount: true });
  return cats.length;
}

export async function refreshAllSourceCategoriesFromDB() {
  const sources = await listSources({});
  let total = 0;
  for (const s of sources) {
    try {
      total += await refreshSourceCategoriesFromDB(s.id);
    } catch (e) {
      console.error("category refresh failed:", s.id, e.message);
    }
  }
  return total;
}

// New source (categories-first on approval) and the accurate fix for existing
// sources: live-scrape the category page (headless Chrome) for exact per-source
// name + slug + img, then merge in product counts from the DB.
export async function scrapeSourceCategories(source) {
  let cats = [];
  if (source.method === "METHOD_A") cats = await scrapeCategoriesA(source.base_url);
  else if (source.method === "METHOD_B") cats = await scrapeCategoriesB(source.base_url);

  const seen = new Set();
  cats = cats.filter((c) => c.name && !seen.has(c.name) && seen.add(c.name));

  // accurate per-source counts from the DB, matched by catName
  let counts = new Map();
  try { counts = await readCategoryCounts(source); } catch (_) { /* no products yet */ }
  cats = cats.map((c) => ({ ...c, count: counts.get(c.name) || 0 }));

  // withCount:true so counts are written and the scraped slug/img overwrite
  // any stale/contaminated values from an earlier DB-read populate.
  await upsertCategories(source.id, cats, { withCount: true });
  return cats.length;
}

export async function listSourceCategories(sourceId, { enabledOnly = false } = {}) {
  const { rows } = await query(
    `select cat_name, slug, img, product_count, enabled
       from source_categories
      where source_id=$1 ${enabledOnly ? "and enabled=true" : ""}
      order by product_count desc, cat_name asc`,
    [sourceId]
  );
  return rows;
}

export async function setCategoryEnabled(sourceId, catName, enabled) {
  const { rowCount } = await query(
    `update source_categories set enabled=$1, updated_at=now()
      where source_id=$2 and cat_name=$3`,
    [enabled, sourceId, catName]
  );
  return rowCount > 0;
}
