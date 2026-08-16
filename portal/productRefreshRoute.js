// New, KEYED live single-product refresh — NON-BLOCKING, with trigger logging.
// Returns instantly: 'fresh' (product current) or 'refreshing' (scrape kicked off
// in the background). Logs which product URL triggered it and from which store.
//
// Mount BEFORE the tenant line:
//   import productRefreshRoute from "./portal/productRefreshRoute.js";
//   app.use("/product", productRefreshRoute);
//   app.use("/product", tenantIdentify, productRoutes);
import { Router } from "express";
import { requireEnrollmentKey } from "./enrollmentKey.js";
import { findProduct, isStale, rescrape } from "../core/refreshProduct.js"; // adjust path if needed

const router = Router();

const refreshing = new Set();
const lastAttempt = new Map();
const RETRY_COOLDOWN_MS = 60 * 1000;

// Hard ceiling on background live scrapes in flight at once. With CHROME_MAX=2
// this keeps the browser gate's waiter queue tiny instead of climbing into the
// hundreds when a busy store gets crawled. Extra views just return the current
// row (status "refreshing") without queuing another scrape. Override with
// REFRESH_MAX_INFLIGHT.
const MAX_INFLIGHT = Math.max(1, parseInt(process.env.REFRESH_MAX_INFLIGHT, 10) || 4);

// GET /product/refresh-one?productId=70850&category=watches
router.get("/refresh-one", requireEnrollmentKey, async (req, res) => {
  const domain = (req.enrollment && req.enrollment.domain) || "?";
  try {
    const productId = req.query.productId;
    const category = req.query.category || req.query.productDb;
    if (!productId || !category) return res.status(400).json({ error: "productId and category required" });

    const catSources = (req.enrollment.sources || []).filter((s) => s.sourceCategory === category);
    if (!catSources.length) {
      console.log(`[refresh-one] ${domain} id=${productId} db=${category} -> 403 not-enrolled`);
      return res.status(403).json({ error: "Not enrolled in this category" });
    }

    const product = await findProduct(productId, category);
    if (!product) {
      console.log(`[refresh-one] ${domain} id=${productId} db=${category} -> 404 not-found`);
      return res.status(404).json({ error: "Product not found" });
    }

    const url = product.productUrl || product.productFetchedFrom || "(no url)";

    const src = catSources.find(
      (s) => s.searchKey && product.productFetchedFrom && product.productFetchedFrom.includes(s.searchKey)
    );
    if (!src) {
      console.log(`[refresh-one] ${domain} ${url} -> 403 not-in-catalogue`);
      return res.status(403).json({ error: "Product not in your catalogue" });
    }

    const apply = (p) => {
      if (src.catMap && src.catMap[p.catName]) p.catName = src.catMap[p.catName];
      p.dbName = category;
      return p;
    };

    if (!isStale(product)) {
      console.log(`[refresh-one] ${domain} ${url} -> fresh (no scrape)`);
      return res.json({ status: "fresh", product: apply(product) });
    }

    // stale — start ONE background scrape (rate-limited), return without waiting
    const key = category + ":" + productId;
    const recentlyTried = lastAttempt.has(key) && Date.now() - lastAttempt.get(key) < RETRY_COOLDOWN_MS;
    if (refreshing.has(key)) {
      console.log(`[refresh-one] ${domain} ${url} -> refreshing (scrape already running)`);
    } else if (recentlyTried) {
      console.log(`[refresh-one] ${domain} ${url} -> refreshing (cooldown, skipped new scrape)`);
    } else if (refreshing.size >= MAX_INFLIGHT) {
      // gate is saturated — don't pile on. The row is still returned below.
      console.log(`[refresh-one] ${domain} ${url} -> refreshing (busy: ${refreshing.size}/${MAX_INFLIGHT} in flight, skipped)`);
    } else {
      // keep the cooldown map from growing without bound over days of traffic
      if (lastAttempt.size > 20000) lastAttempt.clear();
      refreshing.add(key);
      lastAttempt.set(key, Date.now());
      console.log(`[refresh-one] ${domain} TRIGGERED live scrape: ${url} (id=${productId}, db=${category})`);
      rescrape(product, category)
        .then(() => console.log(`[refresh-one] ${domain} scrape DONE: ${url}`))
        .catch((e) => console.log(`[refresh-one] ${domain} scrape FAILED: ${url} -> ${e.message}`))
        .finally(() => refreshing.delete(key));
    }
    return res.json({ status: "refreshing", product: apply(product) });
  } catch (e) {
    console.log(`[refresh-one] ${domain} error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

export default router;
