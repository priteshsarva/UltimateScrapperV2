// ============================================================================
// UPDATED /product/sync-feed  — cross-category aware.
// Replace your existing sync-feed route with this. The ONLY new behaviour is the
// `category` query param (so the plugin can pull each database separately);
// everything else — keyset pagination, per-source WHERE, dbName tagging — is
// unchanged and backward compatible (no `category` => first source's category).
//
// Requires these imports at the top of productRoutes.js (you almost certainly
// already have them, since your current sync-feed opens these DBs):
//
//   import sqlite3 from "sqlite3";
//   import path from "path";
//   import { fileURLToPath } from "url";
//   const __dirname = path.dirname(fileURLToPath(import.meta.url));
//
// IMPORTANT: keep whatever DB_FOLDER value your current file already uses.
// In portal/ files it's "../databases"; if productRoutes.js sits elsewhere,
// use the same relative path your working sync-feed already uses.
const DB_FOLDER = path.resolve(__dirname, "../databases");
// ============================================================================

router.get("/sync-feed", requireEnrollmentKey, async (req, res) => {
  const by    = req.query.by === "ts" ? "ts" : "id";
  const after = parseInt(req.query.after, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);

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

  const sql = `
    SELECT *
      FROM PRODUCTS
     WHERE ${cursorCol} > ?
       AND (${sourceClauses.join(" OR ")})
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

    res.json({ by, after, count: rows.length, results: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (db) db.close();
  }
});
