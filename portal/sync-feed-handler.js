// ============================================================================
// UPDATED /product/sync-feed  — cross-category aware + STOCK-ORDERED BACKFILL.
//
// NEW in this version: the `stock` query param.
//   ?stock=in   -> only in-stock products
//   ?stock=out  -> only out-of-stock products
//   (omitted)   -> everything, exactly as before
//
// Plugin v3.7.0 uses this to run the backfill in two passes (in-stock first,
// then out-of-stock) so a new store fills with sellable products immediately.
// Omitting the param keeps older plugins working unchanged.
//
// DEPLOY THIS BEFORE UPDATING THE PLUGIN. If the plugin ships first, the server
// ignores `stock`, backfill_in pulls everything and backfill_out pulls it all
// again — harmless (the plugin's ts-skip makes the second pass cheap) but wasteful.
//
// Requires these imports at the top of productRoutes.js:
//   import sqlite3 from "sqlite3";
//   import path from "path";
//   import { fileURLToPath } from "url";
//   const __dirname = path.dirname(fileURLToPath(import.meta.url));
//
// IMPORTANT: keep whatever DB_FOLDER value your current file already uses.
const DB_FOLDER = path.resolve(__dirname, "../databases");
// ============================================================================

// availability arrives from the scrapers as 0/1, and historically as
// 'true'/'false' strings on some rows. COALESCE matters: without it a NULL
// availability makes both `= 1` and `NOT (= 1)` evaluate to NULL, and the row
// would be invisible to BOTH backfill passes — silently never imported.
// NULL is treated as out-of-stock, matching the plugin's normalize_availability().
const IS_IN_STOCK =
  "(COALESCE(LOWER(CAST(availability AS TEXT)), '0') IN ('1','true','yes'))";

router.get("/sync-feed", requireEnrollmentKey, async (req, res) => {
  const by    = req.query.by === "ts" ? "ts" : "id";
  const after = parseInt(req.query.after, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);

  // (0) optional stock filter — anything other than 'in'/'out' means unfiltered
  const stock = req.query.stock === "in" ? "in"
              : req.query.stock === "out" ? "out"
              : "";

  const sources = req.enrollment.sources || [];

  // (1) which category/database to read. Defaults to the first source's category
  //     so old callers that don't pass ?category= keep working.
  const category = (req.query.category || (sources[0] && sources[0].sourceCategory) || "").toString();
  if (!category) {
    return res.json({ by, after, count: 0, results: [] });
  }

  // (2) the database file is named after the category
  const dbName = category;

  // (3) only the sources that belong to this category (a store may now hold
  //     sources from several categories; each category is a separate DB)
  const catSources = sources.filter((s) => s.sourceCategory === category);
  if (catSources.length === 0) {
    return res.json({ by, after, count: 0, results: [] });
  }

  // keyset cursor column: by id -> productId ; by ts -> the epoch-ms integer
  const cursorCol = by === "ts" ? "CAST(productLastUpdated AS INTEGER)" : "productId";

  // build "(fetchedFrom LIKE key1 [AND catName IN (...)]) OR (...)" across this
  // category's sources. Empty categories[] means "all categories for that source".
  const params = [after];
  const sourceClauses = catSources.map((s) => {
    let clause = "productFetchedFrom LIKE '%' || ? || '%'";
    params.push(s.searchKey);
    if (Array.isArray(s.categories) && s.categories.length) {
      const placeholders = s.categories.map(() => "?").join(",");
      clause += ` AND catName IN (${placeholders})`;
      params.push(...s.categories);
    }
    return `(${clause})`;
  });
  params.push(limit);

  // (4) stock clause — no bound params, so it can sit anywhere in the WHERE
  //     without disturbing the existing parameter order.
  const stockClause =
      stock === "in"  ? ` AND ${IS_IN_STOCK}`
    : stock === "out" ? ` AND NOT ${IS_IN_STOCK}`
    : "";

  const sql = `
    SELECT *
      FROM PRODUCTS
     WHERE ${cursorCol} > ?
       AND (${sourceClauses.join(" OR ")})
       ${stockClause}
     ORDER BY ${cursorCol} ASC
     LIMIT ?`;

  const dbFile = path.join(DB_FOLDER, `${dbName}.db`);
  let db;
  try {
    db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY);
    const rows = await new Promise((resolve, reject) =>
      db.all(sql, params, (err, r) => (err ? reject(err) : resolve(r || [])))
    );

    // tag every row with the database it came from (not a column in PRODUCTS),
    // and swap its category to the canonical display name if the admin mapped one.
    for (const row of rows) {
      row.dbName = dbName;
      const src = catSources.find(
        (s) => s.searchKey && row.productFetchedFrom && row.productFetchedFrom.includes(s.searchKey)
      );
      if (src && src.catMap && src.catMap[row.catName]) {
        row.catName = src.catMap[row.catName];
      }
    }

    res.json({ by, after, count: rows.length, results: rows, stock: stock || undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (db) db.close();
  }
});
