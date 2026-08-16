// SQLite maintenance: integrity check, corruption repair (via `.recover`), and
// archiving stale-and-unavailable products. Operates on the per-category product
// DBs in ./databases/<cat>.db.
//
// Repair uses the sqlite3 CLI's `.recover` (the only reliable rebuild for a
// malformed image). Output is STREAMED file->CLI so a 100k-row dump never sits
// in memory on the small VPS. The original is backed up, transient files are
// cleaned, and the rebuilt DB is verified before it replaces the original.
import sqlite3 from "sqlite3";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { once } from "events";
import { dbManager } from "../models/dbManager.js";

const DB_DIR = path.resolve("./databases");
const SQLITE_BIN = process.env.SQLITE3_BIN || "sqlite3";

// out-of-stock predicate — IDENTICAL to sync-feed's bucket so "unavailable" here
// means exactly what the plugin treats as out of stock.
const OOS_SQL = `LOWER(CAST(COALESCE(availability,'0') AS TEXT)) NOT IN ('1','true')`;
// only rows whose productLastUpdated is a real epoch-ms stamp (>= 2001) — guards
// against never-scraped rows that still hold a CURRENT_TIMESTAMP text default.
const TS_SQL = `CAST(productLastUpdated AS INTEGER)`;
const MIN_MS = 1000000000000;

// ---- helpers ---------------------------------------------------------------

export function listCategoryDbs() {
  if (!fs.existsSync(DB_DIR)) return [];
  return fs.readdirSync(DB_DIR)
    .filter((f) => f.endsWith(".db"))
    .filter((f) => !/\.(corrupt|rebuilt)-/.test(f)) // skip our own backups/temps
    .map((f) => f.replace(/\.db$/, ""));
}

const dbPathFor = (category) => path.join(DB_DIR, `${String(category).toLowerCase()}.db`);

// run a read query on a throwaway connection; resolves { rows } or { error }
function readOnly(dbPath, sql, params = []) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve({ error: err.message });
    });
    db.all(sql, params, (err, rows) => {
      db.close(() => {});
      if (err) return resolve({ error: err.message });
      resolve({ rows });
    });
  });
}

async function countProducts(dbPath) {
  const r = await readOnly(dbPath, "SELECT COUNT(*) AS n FROM PRODUCTS");
  return r.rows ? r.rows[0].n : null;
}

// PRAGMA integrity_check — returns { ok, result } or { ok:false, error }
export async function integrityCheck(category) {
  const dbPath = dbPathFor(category);
  if (!fs.existsSync(dbPath)) return { category, ok: false, error: "file not found" };
  const r = await readOnly(dbPath, "PRAGMA integrity_check");
  if (r.error) return { category, ok: false, error: r.error };
  const result = r.rows.map((x) => x.integrity_check).join("; ");
  const rows = await countProducts(dbPath);
  return { category, ok: result === "ok", result, rows };
}

export async function healthAll() {
  return Promise.all(listCategoryDbs().map((c) => integrityCheck(c)));
}

// remove the -wal / -shm sidecars for a db path (safe: only when not open)
function cleanSidecars(dbPath) {
  const removed = [];
  for (const ext of ["-wal", "-shm", "-journal"]) {
    const p = dbPath + ext;
    try { if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(path.basename(p)); } } catch {}
  }
  return removed;
}

// is the sqlite3 CLI available?
async function haveSqliteCli() {
  try {
    const p = spawn(SQLITE_BIN, ["--version"]);
    const [code] = await once(p, "close");
    return code === 0;
  } catch { return false; }
}

// ---- repair ----------------------------------------------------------------

// Rebuild a malformed DB via `.recover`. Returns a detailed result object.
export async function repairDb(category) {
  const cat = String(category).toLowerCase();
  const dbPath = dbPathFor(cat);
  if (!fs.existsSync(dbPath)) return { ok: false, category: cat, error: "file not found" };

  // 1) release our own handle so the CLI has exclusive access
  try { await dbManager.closeDb(cat); } catch {}

  // 2) if it's already healthy, just tidy sidecars and return
  const pre = await integrityCheck(cat);
  const rowsBefore = pre.rows ?? (await countProducts(dbPath));
  if (pre.ok) {
    const cleaned = cleanSidecars(dbPath);
    return { ok: true, category: cat, alreadyHealthy: true, rows: rowsBefore, cleaned };
  }

  if (!(await haveSqliteCli())) {
    return { ok: false, category: cat, error: `sqlite3 CLI not found (tried "${SQLITE_BIN}"). Install it (apt install sqlite3) or set SQLITE3_BIN.`, integrity: pre.result || pre.error };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const recSql = path.join(process.env.TMPDIR || DB_DIR, `${cat}.recover-${stamp}.sql`);
  const newDb = path.join(DB_DIR, `${cat}.rebuilt-${stamp}.db`);
  const transient = () => { for (const p of [recSql, newDb, newDb + "-wal", newDb + "-shm"]) { try { fs.existsSync(p) && fs.rmSync(p, { force: true }); } catch {} } };

  try {
    // 3) dump recovered SQL to a file (streamed — never buffered in memory)
    await new Promise(async (resolve, reject) => {
      const out = fs.createWriteStream(recSql);
      const p = spawn(SQLITE_BIN, [dbPath, ".recover"]);
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.stdout.pipe(out);
      p.on("error", reject);
      out.on("error", reject);
      const [code] = await once(p, "close");
      out.end();
      await once(out, "finish").catch(() => {});
      // .recover often exits non-zero on a corrupt source yet still emits usable
      // SQL — so we don't hard-fail here; the post-integrity check is the gate.
      if (!fs.existsSync(recSql) || fs.statSync(recSql).size === 0) {
        return reject(new Error(`.recover produced no SQL (code ${code}) ${stderr}`.trim()));
      }
      resolve();
    });

    // 4) build the fresh DB from the recovered SQL, defensive mode OFF (the
    //    recovered script pokes sqlite_schema, which strict/defensive rejects).
    await new Promise(async (resolve, reject) => {
      const p = spawn(SQLITE_BIN, [newDb]);
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d.toString()));
      p.on("error", reject);
      p.stdin.write(".dbconfig defensive off\n");
      const rd = fs.createReadStream(recSql);
      rd.on("error", reject);
      rd.pipe(p.stdin);
      const [code] = await once(p, "close");
      if (code !== 0 && stderr) console.warn(`⚠️ [repair] load warnings for ${cat}: ${stderr.slice(0, 500)}`);
      resolve();
    });

    // 5) verify the rebuilt DB BEFORE touching the original
    const post = await readOnly(newDb, "PRAGMA integrity_check");
    const rowsAfter = await countProducts(newDb);
    const postOk = post.rows && post.rows.map((x) => x.integrity_check).join("; ") === "ok";
    if (!postOk || !rowsAfter) {
      transient();
      return { ok: false, category: cat, error: "rebuilt DB failed verification — original left untouched", rebuiltIntegrity: post.error || (post.rows && post.rows[0]?.integrity_check), rowsAfter };
    }

    // 6) swap: back up the corrupt original, move the rebuilt one into place
    const backup = path.join(DB_DIR, `${cat}.corrupt-${stamp}.db`);
    cleanSidecars(dbPath);            // drop the (now irrelevant) corrupt WAL/SHM
    fs.renameSync(dbPath, backup);
    fs.renameSync(newDb, dbPath);
    cleanSidecars(newDb);            // any sidecars left at the temp path

    // 7) clean the recover script (and the temp db sidecars, already handled)
    const cleaned = [];
    try { if (fs.existsSync(recSql)) { fs.rmSync(recSql, { force: true }); cleaned.push(path.basename(recSql)); } } catch {}

    return {
      ok: true, category: cat, repaired: true,
      rowsBefore, rowsAfter, recovered: rowsAfter,
      backup: path.basename(backup),
      cleaned,
      note: "Corrupt original saved as the backup file; delete it once you've confirmed data is intact.",
    };
  } catch (e) {
    transient();
    return { ok: false, category: cat, error: e.message };
  }
}

// ---- archive stale + unavailable ------------------------------------------

// promised run/get on a fresh writable connection with FK cascade on
function open(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}
const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

function cutoffMs(months) {
  const m = Math.max(0, parseFloat(months) || 0) || 2;
  return { cutoff: Date.now() - m * 30 * 24 * 60 * 60 * 1000, months: m };
}

const WHERE_STALE_OOS = `${OOS_SQL} AND ${TS_SQL} >= ${MIN_MS} AND ${TS_SQL} < ?`;

// dry run: how many rows WOULD be archived for a category
export async function previewArchive(category, months) {
  const dbPath = dbPathFor(category);
  if (!fs.existsSync(dbPath)) return { category, error: "file not found" };
  const { cutoff, months: m } = cutoffMs(months);
  const r = await readOnly(dbPath, `SELECT COUNT(*) AS n FROM PRODUCTS WHERE ${WHERE_STALE_OOS}`, [cutoff]);
  if (r.error) return { category, error: r.error };
  return { category, months: m, wouldArchive: r.rows[0].n };
}

// move stale + unavailable products into PRODUCTS_ARCHIVE (same DB), then delete
// them from PRODUCTS so sync-feed stops serving them. Reversible: the rows live
// on in PRODUCTS_ARCHIVE with archivedAt / archiveReason.
export async function archiveStale(category, months) {
  const cat = String(category).toLowerCase();
  const dbPath = dbPathFor(cat);
  if (!fs.existsSync(dbPath)) return { category: cat, error: "file not found" };
  const { cutoff, months: m } = cutoffMs(months);

  // use our own handle so schema (and FK pragma) are consistent, then free it
  const db = await open(dbPath);
  try {
    await run(db, "PRAGMA busy_timeout = 15000");
    await run(db, "PRAGMA foreign_keys = ON"); // cascade junction rows on delete
    // archive table mirrors PRODUCTS + two bookkeeping columns; idempotent
    await run(db, `CREATE TABLE IF NOT EXISTS PRODUCTS_ARCHIVE AS
                   SELECT *, CAST(NULL AS INTEGER) AS archivedAt, CAST(NULL AS TEXT) AS archiveReason
                   FROM PRODUCTS WHERE 0`);

    await run(db, "BEGIN IMMEDIATE");
    let moved = 0;
    try {
      const ins = await run(db,
        `INSERT INTO PRODUCTS_ARCHIVE
           SELECT *, ${Date.now()} AS archivedAt, 'stale-oos' AS archiveReason
           FROM PRODUCTS WHERE ${WHERE_STALE_OOS}`, [cutoff]);
      const del = await run(db, `DELETE FROM PRODUCTS WHERE ${WHERE_STALE_OOS}`, [cutoff]);
      moved = del.changes ?? ins.changes ?? 0;
      await run(db, "COMMIT");
    } catch (e) {
      await run(db, "ROLLBACK").catch(() => {});
      throw e;
    }

    const remaining = (await get(db, "SELECT COUNT(*) AS n FROM PRODUCTS")).n;
    const archived = (await get(db, "SELECT COUNT(*) AS n FROM PRODUCTS_ARCHIVE")).n;
    return { category: cat, months: m, archivedNow: moved, productsRemaining: remaining, archiveTotal: archived };
  } finally {
    await new Promise((r) => db.close(() => r()));
  }
}

// archive across every category DB
export async function archiveStaleAll(months) {
  const out = [];
  for (const c of listCategoryDbs()) {
    try { out.push(await archiveStale(c, months)); }
    catch (e) { out.push({ category: c, error: e.message }); }
  }
  return out;
}
