// Shared single-product refresh core — extracted from the /dev/update-single-product
// handler (steps 4–7: find -> 1h staleness check -> identify method -> live scrape).
// PLACE THIS AT: core/refreshProduct.js
//
// It does NOT push to WooCommerce — the caller decides how to sync:
//   - the old /dev route calls syncProductToAllSites() after this (unchanged behaviour)
//   - the new keyed /product/refresh-one returns the data so the plugin upserts it itself
import sqlite3 from "sqlite3";
import path from "path";
import { SITES_REGISTRY } from "../config/sites.js";
import { scrapeSingleProductMethodA } from "./strategies/liveMethodA.js";
import { scrapeSingleProductMethodB } from "./strategies/LiveMethodB.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Find a product in {dbName}.db and, if older than 1 hour, re-scrape it live
 * (the scraper writes the fresh row back to that DB, same as your /dev flow).
 * @returns {Promise<{ product: object|null, status: string, error?: string }>}
 *          status: 'skipped' (fresh) | 'success' (re-scraped) |
 *                  'not-found' | 'no-config' | 'stale-scrape-failed'
 */
export async function refreshSingleProduct(productId, dbName, productUrl = null) {
  // 1) locate the product in the given DB (fresh, independent connection)
  const dbPath = path.resolve(`./databases/${dbName}.db`);
  const db = new sqlite3.Database(dbPath);
  db.run("PRAGMA busy_timeout = 30000");

  const sql = productUrl
    ? "SELECT * FROM PRODUCTS WHERE productUrl = ?"
    : "SELECT * FROM PRODUCTS WHERE productId = ?";
  const param = productUrl || productId;

  const localProduct = await new Promise((resolve, reject) => {
    db.get(sql, [param], (err, row) => (err ? reject(err) : resolve(row)));
  });
  db.close();

  if (!localProduct) return { product: null, status: "not-found" };

  // 2) freshness check — return as-is if updated within the last hour
  const lastUpdated = parseInt(localProduct.productLastUpdated);
  if (Date.now() - lastUpdated < ONE_HOUR_MS) {
    return { product: localProduct, status: "skipped" };
  }

  // 3) identify the source site + scrape method
  const fetchedFrom = localProduct.productFetchedFrom || localProduct.productUrl || "";
  const siteConfig = SITES_REGISTRY.find(
    (site) => fetchedFrom.includes(site.base_url) || fetchedFrom.includes(site.searchKey)
  );
  if (!siteConfig) return { product: localProduct, status: "no-config" };

  // 4) live re-scrape (scraper writes back to the DB)
  let fresh = null;
  try {
    if (siteConfig.method === "METHOD_A") {
      fresh = await scrapeSingleProductMethodA(localProduct.productUrl, dbName);
    } else if (siteConfig.method === "METHOD_B") {
      fresh = await scrapeSingleProductMethodB(localProduct.productUrl, dbName);
    } else {
      throw new Error("Unknown scraping method");
    }
  } catch (err) {
    return { product: localProduct, status: "stale-scrape-failed", error: err.message };
  }

  fresh = fresh || localProduct;
  fresh.dbName = dbName;
  return { product: fresh, status: "success" };
}
