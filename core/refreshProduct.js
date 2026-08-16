// Shared single-product refresh core, extracted from /dev/update-single-product.
// PLACE AT: core/refreshProduct.js
//
// Exposes granular pieces (find / isStale / rescrape) so the NEW keyed route can
// background just the scrape, plus refreshSingleProduct() which keeps the OLD /dev
// route's exact blocking behaviour.
import sqlite3 from "sqlite3";
import path from "path";
import { SITES_REGISTRY } from "../config/sites.js";
import { scrapeSingleProductMethodA } from "./strategies/liveMethodA.js";
import { scrapeSingleProductMethodB } from "./strategies/LiveMethodB.js";

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
  const siteConfig = SITES_REGISTRY.find(
    (s) => fetchedFrom.includes(s.base_url) || fetchedFrom.includes(s.searchKey)
  );
  if (!siteConfig) return null;
  if (siteConfig.method === "METHOD_A") return await scrapeSingleProductMethodA(product.productUrl, dbName);
  if (siteConfig.method === "METHOD_B") return await scrapeSingleProductMethodB(product.productUrl, dbName);
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
