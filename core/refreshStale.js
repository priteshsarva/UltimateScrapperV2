// Bulk "live refresh of stale-but-in-stock products" — the engine behind the
// GET /refreshstale route. Finds every product that is marked in stock
// (availability 1/true) AND hasn't been updated in the last X days, then live-
// re-scrapes each one. rescrape() writes the fresh row back and ALREADY flips
// availability -> 0 on a 404 / dead page (see core/strategies/liveMethod*.js),
// so a product that has vanished from its source ends up out of stock here.
//
// Predicates mirror portal/dbMaintenance.js exactly so "in stock" / "a real
// timestamp" mean the same thing everywhere. productLastUpdated is an epoch-ms
// integer on scraped rows; the >= MIN_MS guard skips never-scraped rows that
// still hold the CURRENT_TIMESTAMP text default (they'd CAST to a tiny number
// and look infinitely stale).
//
// Run the self-check:  node core/refreshStale.js
import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { listCategoryDbs } from "../portal/dbMaintenance.js";
import { rescrape } from "./refreshProduct.js";

const DB_DIR = path.resolve("./databases");
const MIN_MS = 1000000000000; // ignore text-default / pre-2001 timestamps
const IN_STOCK = `LOWER(CAST(COALESCE(availability,'0') AS TEXT)) IN ('1','true')`;
const TS = `CAST(productLastUpdated AS INTEGER)`;

// Candidate rows for one category DB: in stock + a real epoch stamp older than
// the cutoff + a usable productUrl (the live scraper updates WHERE productUrl=?).
// Oldest first, so a capped run always refreshes the most stale products.
export function findStaleInStock(dbPath, cutoffMs, limit) {
  const sql = `SELECT productId, productUrl, productFetchedFrom, productLastUpdated
               FROM PRODUCTS
               WHERE ${IN_STOCK}
                 AND ${TS} >= ${MIN_MS} AND ${TS} < ?
                 AND productUrl IS NOT NULL AND productUrl <> ''
               ORDER BY ${TS} ASC
               LIMIT ?`;
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (e) => { if (e) return reject(e); });
    db.all(sql, [cutoffMs, limit], (e, rows) => { db.close(() => {}); e ? reject(e) : resolve(rows || []); });
  });
}

// Orchestrate across one or all category DBs. Sequential on purpose: one Chrome
// at a time keeps the small VPS safe, and `limit` hard-caps a single run.
// ponytail: sequential + hard limit; add worker concurrency only if a run can't
// keep pace with how fast products go stale.
export async function refreshStaleInStock({ days, limit = 500, category = null, log = () => {} } = {}) {
  const d = parseFloat(days);
  if (!Number.isFinite(d) || d < 0) throw new Error("days must be a non-negative number");
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  const cats = category ? [String(category).toLowerCase()] : listCategoryDbs();
  let remaining = Math.max(1, parseInt(limit, 10) || 500);

  const summary = { days: d, limit: remaining, scanned: 0, refreshed: 0, markedOOS: 0, failed: 0, categories: [] };

  for (const cat of cats) {
    if (remaining <= 0) break;
    const dbPath = path.join(DB_DIR, `${cat}.db`);
    if (!fs.existsSync(dbPath)) { summary.categories.push({ category: cat, error: "file not found" }); continue; }

    let rows = [];
    try { rows = await findStaleInStock(dbPath, cutoff, remaining); }
    catch (e) { summary.categories.push({ category: cat, error: e.message }); continue; }

    let refreshed = 0, markedOOS = 0, failed = 0;
    log(`[refresh-stale] ${cat}: ${rows.length} stale in-stock product(s) to refresh`);
    for (const row of rows) {
      if (remaining <= 0) break;
      remaining--; summary.scanned++;
      try {
        const updated = await rescrape(row, cat);
        if (updated === null) { failed++; summary.failed++; log(`  – no scrape config: ${row.productUrl}`); continue; }
        refreshed++; summary.refreshed++;
        if (Number(updated.availability) === 0) { markedOOS++; summary.markedOOS++; log(`  ✓ OUT OF STOCK: ${row.productUrl}`); }
        else log(`  ✓ updated: ${row.productUrl}`);
      } catch (e) { failed++; summary.failed++; log(`  ✗ ${row.productUrl} -> ${e.message}`); }
    }
    summary.categories.push({ category: cat, candidates: rows.length, refreshed, markedOOS, failed });
  }
  return summary;
}

// ---- self-check: the candidate predicate is the load-bearing bit ----
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("core/refreshStale.js")) {
  const tmp = path.join(os.tmpdir(), `refreshstale-selfcheck-${Date.now()}.db`);
  const now = Date.now();
  const ok = (c, m) => { if (!c) { console.error("FAIL:", m); try { fs.rmSync(tmp, { force: true }); } catch {} process.exit(1); } };
  const db = new sqlite3.Database(tmp, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (e) => { if (e) { console.error("FAIL: temp db open:", e.message); process.exit(1); } });
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
  (async () => {
    await run(`CREATE TABLE PRODUCTS (productId INTEGER, productUrl TEXT, productFetchedFrom TEXT, availability, productLastUpdated)`);
    const ins = (id, url, avail, ts) => run(`INSERT INTO PRODUCTS VALUES (?,?,?,?,?)`, [id, url, "x", avail, ts]);
    const old = now - 10 * 24 * 3600 * 1000;   // 10 days old
    const fresh = now - 1 * 24 * 3600 * 1000;   // 1 day old
    await ins(1, "u1", 1, old);                 // ✓ stale + in stock (1)
    await ins(2, "u2", "true", old);            // ✓ stale + in stock ("true")
    await ins(3, "u3", 0, old);                 // ✗ out of stock
    await ins(4, "u4", 1, fresh);               // ✗ not stale yet
    await ins(5, "u5", 1, "2025-02-03 17:40:37"); // ✗ text default (CAST < MIN_MS)
    await ins(6, null, 1, old);                 // ✗ no productUrl
    await new Promise((r) => db.close(r));

    const cutoff = now - 3 * 24 * 3600 * 1000;  // older than 3 days
    const rows = await findStaleInStock(tmp, cutoff, 500);
    const ids = rows.map((r) => r.productId).sort();
    ok(JSON.stringify(ids) === JSON.stringify([1, 2]), `expected [1,2], got ${JSON.stringify(ids)}`);
    // oldest-first ordering + limit
    const limited = await findStaleInStock(tmp, cutoff, 1);
    ok(limited.length === 1 && limited[0].productId === 1, "limit/order broken");
    try { fs.rmSync(tmp, { force: true }); } catch {}
    console.log("refreshStale OK");
  })().catch((e) => { console.error(e); try { fs.rmSync(tmp, { force: true }); } catch {} process.exit(1); });
}
