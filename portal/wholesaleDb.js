// wholesale.db helper. The catalogue is stored in databases/wholesale.db using
// the same PRODUCTS schema as every scraped category, plus a few wholesale-only
// columns (stock, listing status, primary category, last-verified, meta JSON).
// dbManager.getDb('wholesale') auto-creates the base schema; we add the extra
// columns here (idempotent — SQLite has no ADD COLUMN IF NOT EXISTS).
import { dbManager } from "../models/dbManager.js";

const EXTRA = [
  ["stockQty", "INTEGER"],
  ["listingStatus", "TEXT DEFAULT 'active'"],   // active | paused | rejected | needs_review
  ["primaryCat", "TEXT"],
  ["lastVerifiedAt", "DATETIME"],
  ["wholesaleMeta", "TEXT"],                     // JSON { mrp, moq, sku }
  ["ownerEnrollmentId", "TEXT"],                // which wholesaler owns this row
];

const run = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, (e) => (e ? rej(e) : res())));
const all = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const get = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));

let ensured = false;
export async function wholesaleDb() {
  const db = await dbManager.getDb("wholesale");
  if (!ensured) {
    const cols = (await all(db, "PRAGMA table_info(PRODUCTS)")).map((c) => c.name);
    for (const [name, type] of EXTRA) {
      if (!cols.includes(name)) await run(db, `ALTER TABLE PRODUCTS ADD COLUMN ${name} ${type}`);
    }
    await run(db, "CREATE INDEX IF NOT EXISTS idx_products_owner ON PRODUCTS(ownerEnrollmentId)");
    ensured = true;
  }
  return db;
}

export const wsRun = run;
export const wsAll = all;
export const wsGet = get;
