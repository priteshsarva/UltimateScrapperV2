// Shared single-product refresh core, extracted from /dev/update-single-product.
// PLACE AT: core/refreshProduct.js
//
// Exposes granular pieces (find / isStale / rescrape) so the NEW keyed route can
// background just the scrape, plus refreshSingleProduct() which keeps the OLD /dev
// route's exact blocking behaviour.
import sqlite3 from "sqlite3";
import path from "path";
import { SITES_REGISTRY } from "../config/sites.js";
import { listSources } from "../portal/sources.js";
import { scrapeSingleProductMethodA } from "./strategies/liveMethodA.js";
import { scrapeSingleProductMethodB } from "./strategies/LiveMethodB.js";

// Which scrape method a product's source uses. Resolved from the LIVE Postgres
// source registry FIRST (an admin can add a source without a code deploy — those
// products would otherwise get no live refresh), then the static SITES_REGISTRY
// as a fallback. base_url is matched before search_key because the full URL
// distinguishes look-alike keys (e.g. watchflex on cartpe vs jdwebnship).
let _srcCache = { at: 0, rows: [] };
async function activeSources() {
  if (_srcCache.rows.length && Date.now() - _srcCache.at < 60_000) return _srcCache.rows;
  try { _srcCache = { at: Date.now(), rows: await listSources() }; } catch { /* keep stale */ }
  return _srcCache.rows;
}
export async function resolveMethod(fetchedFrom) {
  const ff = String(fetchedFrom || "");
  const srcs = await activeSources();
  const pg = srcs.find((s) => s.base_url && ff.includes(s.base_url))
          || srcs.find((s) => s.search_key && ff.includes(s.search_key));
  if (pg && pg.method) return pg.method;
  const reg = SITES_REGISTRY.find((s) => ff.includes(s.base_url))
           || SITES_REGISTRY.find((s) => ff.includes(s.searchKey));
  if (reg) return reg.method;
  // last resort: hyphen/underscore-insensitive key match — catches renamed
  // sources (e.g. "uzerwatch" vs "uzer-watch").
  const nk = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const ffn = nk(ff);
  const fuzzy = srcs.find((s) => s.search_key && nk(s.search_key).length >= 5 && ffn.includes(nk(s.search_key)))
             || SITES_REGISTRY.find((s) => s.searchKey && nk(s.searchKey).length >= 5 && ffn.includes(nk(s.searchKey)));
  return fuzzy ? fuzzy.method : null;
}

export const ONE_HOUR_MS = 60 * 60 * 1000;

// How old a product must be before a page view triggers a live re-scrape.
// Was 1h — far too aggressive: on a busy store, nearly every view was >1h old,
// so each one queued a Chrome scrape and the 2-slot gate backed up to hundreds
// "ahead". Widened to 3 days (override with REFRESH_STALE_MS).
export const STALE_MS = Math.max(
  ONE_HOUR_MS,
  parseInt(process.env.REFRESH_STALE_MS, 10) || 3 * 24 * 60 * 60 * 1000
);

// quick DB lookup (fresh, independent connection) — returns the row or null
export async function findProduct(productId, dbName, productUrl = null) {
  const dbPath = path.resolve(`./databases/${dbName}.db`);
  const db = new sqlite3.Database(dbPath);
  db.run("PRAGMA busy_timeout = 30000");
  const sql = productUrl
    ? "SELECT * FROM PRODUCTS WHERE productUrl = ?"
    : "SELECT * FROM PRODUCTS WHERE productId = ?";
  const param = productUrl || productId;
  const row = await new Promise((resolve, reject) => {
    db.get(sql, [param], (err, r) => (err ? reject(err) : resolve(r)));
  });
  db.close();
  return row || null;
}

export function isStale(product) {
  const ts = parseInt(product.productLastUpdated);
  if (!Number.isFinite(ts)) return false; // unknown age -> don't trigger a scrape
  return Date.now() - ts >= STALE_MS;
}

// live re-scrape (scraper writes the fresh row back to the DB). Returns fresh data or null.
export async function rescrape(product, dbName) {
  const fetchedFrom = product.productFetchedFrom || product.productUrl || "";
  const method = await resolveMethod(fetchedFrom);
  if (method === "METHOD_A") return await scrapeSingleProductMethodA(product.productUrl, dbName);
  if (method === "METHOD_B") return await scrapeSingleProductMethodB(product.productUrl, dbName);
  return null;
}

// Blocking combo — used by the OLD /dev route (behaviour unchanged).
export async function refreshSingleProduct(productId, dbName, productUrl = null) {
  const localProduct = await findProduct(productId, dbName, productUrl);
  if (!localProduct) return { product: null, status: "not-found" };
  if (!isStale(localProduct)) return { product: localProduct, status: "skipped" };
  try {
    const fresh = await rescrape(localProduct, dbName);
    if (fresh === null) return { product: localProduct, status: "no-config" };
    fresh.dbName = dbName;
    return { product: fresh, status: "success" };
  } catch (err) {
    return { product: localProduct, status: "stale-scrape-failed", error: err.message };
  }
}
