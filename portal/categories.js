// Category discovery + access.
//  - Existing sources: read clean per-source categories from SQLite PRODUCTS (instant).
//  - New sources (approval): live-scrape the category page first.
//  - Stored in Supabase source_categories; admin enable/disable is preserved on refresh.
//
// TWO PATHS, DELIBERATELY DIFFERENT:
//   refreshSourceCategoriesFromDB  -> counts only. NEVER deprecates, because it
//                                     reads categories that have products; a real
//                                     category with no products yet is simply absent.
//   scrapeSourceCategories         -> full reconcile against the live category page,
//                                     which IS the authoritative list, so it may
//                                     deprecate categories that have disappeared.
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { query, pool } from "./db.js";
import { getSource, listSources } from "./sources.js";
import { scrapeCategoriesA, scrapeCategoriesB } from "./scrapeCategories.js";
import { reconcileCategories } from "./reconcileCategories.js";

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
const AVAIL_IN = `LOWER(CAST(COALESCE(availability,'0') AS TEXT)) IN ('1','true')`;

async function readCategoriesFromDB(source) {
  const db = await openReadonly(source.category);
  try {
    const rows = await allAsync(
      db,
      `SELECT catName AS name, COUNT(*) AS c,
              SUM(CASE WHEN ${AVAIL_IN} THEN 1 ELSE 0 END) AS instock
         FROM PRODUCTS
        WHERE productFetchedFrom LIKE '%' || ? || '%'
          AND catName IS NOT NULL
          AND TRIM(catName) <> ''
          AND catName NOT LIKE '%,%'
        GROUP BY catName`,
      [source.search_key]
    );
    // name + total + in-stock count. slug/img come from the live category-page
    // scrape (the CATEGORIES table is globally deduped and would borrow another
    // source's slug/img).
    return rows.map((r) => ({ name: r.name, count: r.c, inStock: r.instock || 0 }));
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

// Count-only upsert. Used ONLY by the DB path — it never deprecates and never
// touches `enabled` on an existing row.
async function upsertCategories(sourceId, cats, { withCount = true } = {}) {
  for (const c of cats) {
    await query(
      `insert into source_categories (source_id, cat_name, slug, img, product_count, in_stock_count)
       values ($1,$2,$3,$4,$5,$7)
       on conflict (source_id, cat_name) do update set
         product_count  = case when $6 then excluded.product_count else source_categories.product_count end,
         in_stock_count = case when $6 then excluded.in_stock_count else source_categories.in_stock_count end,
         slug           = coalesce(excluded.slug, source_categories.slug),
         img            = coalesce(excluded.img, source_categories.img),
         updated_at     = now()`,
      [sourceId, c.name, c.slug || null, c.img || null, c.count || 0, withCount, c.inStock || 0]
    );
  }
}

// Existing source: instant, from products already in SQLite.
// Refreshes counts. Does NOT deprecate — see the note at the top of this file.
export async function refreshSourceCategoriesFromDB(sourceId) {
  const source = await getSource(sourceId);
  if (!source) throw new Error("Source not found");
  const cats = await readCategoriesFromDB(source);
  await upsertCategories(sourceId, cats, { withCount: true });
  // Correct stale rows: any stored category with NO products in the DB any more
  // gets zeroed (total + in-stock), so it surfaces as "no products" instead of a
  // wrong old count. We zero rather than delete to preserve admin enable/disable.
  const names = cats.map((c) => c.name);
  await query(
    `update source_categories set product_count = 0, in_stock_count = 0, updated_at = now()
      where source_id = $1 and (cardinality($2::text[]) = 0 or cat_name <> all($2))`,
    [sourceId, names]
  );
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

// New source (categories-first on approval) and the accurate refresh for existing
// sources: live-scrape the category page (headless Chrome) for exact per-source
// name + url + img, merge in product counts from SQLite, then RECONCILE.
//
// Returns the reconcile result object, not a bare count. Callers that want the
// old number should read `.scrapedCount`.
export async function scrapeSourceCategories(source, opts = {}) {
  let cats = [];
  if (source.method === "METHOD_A") cats = await scrapeCategoriesA(source.base_url);
  else if (source.method === "METHOD_B") cats = await scrapeCategoriesB(source.base_url);
  else throw new Error(`Unknown scrape method "${source.method}" for source ${source.id}`);

  // No de-dupe here any more: reconcileCategories de-dupes by handle, which is
  // more accurate than by name (two nav entries can share a label).

  // accurate per-source counts from SQLite, keyed by the catName on products
  let counts = new Map();
  try {
    counts = await readCategoryCounts(source);
  } catch (_) {
    /* no products yet — fine, counts stay 0 */
  }

  const scraped = cats.map((c) => ({
    name: c.name,
    url: c.slug,                       // scrapers return the absolute URL as `slug`
    img: c.img,
    productCount: counts.get(c.name) ?? 0,
  }));

  const result = await reconcileCategories(pool, source.id, scraped, {
    countsByName: counts,              // lets reconcile recover counts after a rename
    dryRun: opts.dryRun === true,
    minRatio: opts.minRatio,
  });

  const bits = [`${result.scrapedCount} scraped`, `${result.updated} updated`];
  if (result.added.length)      bits.push(`${result.added.length} added`);
  if (result.renamed.length)    bits.push(`${result.renamed.length} renamed`);
  if (result.revived.length)    bits.push(`${result.revived.length} revived`);
  if (result.adopted.length)    bits.push(`${result.adopted.length} adopted`);
  if (result.deprecated.length) bits.push(`${result.deprecated.length} DEPRECATED`);
  console.log(`[categories] ${source.id}${result.dryRun ? " (dry run)" : ""}: ${bits.join(", ")}`);
  for (const r of result.renamed)    console.log(`  renamed:    "${r.from}" -> "${r.to}"`);
  for (const d of result.deprecated) console.log(`  deprecated: "${d.name}" (was enabled: ${d.wasEnabled})`);

  return result;
}

export async function listSourceCategories(sourceId, { enabledOnly = false, includeDeprecated = true } = {}) {
  const conds = ["source_id=$1"];
  if (enabledOnly) conds.push("enabled=true");
  if (!includeDeprecated) conds.push("status='active'");
  const { rows } = await query(
    `select cat_name, slug, handle, img, product_count, in_stock_count, enabled, status,
            previous_name, last_seen_at, deprecated_at
       from source_categories
      where ${conds.join(" and ")}
      order by (status='deprecated'), product_count desc, cat_name asc`,
    [sourceId]
  );
  // no_stock: has products on record but none in stock right now → "no products"
  return rows.map((r) => ({ ...r, no_stock: (r.product_count || 0) === 0 || (r.in_stock_count || 0) === 0 }));
}

export async function setCategoryEnabled(sourceId, catName, enabled) {
  const { rowCount } = await query(
    `update source_categories set enabled=$1, updated_at=now()
      where source_id=$2 and cat_name=$3`,
    [enabled, sourceId, catName]
  );
  return rowCount > 0;
}
