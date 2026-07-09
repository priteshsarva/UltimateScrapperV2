// New, KEYED live single-product refresh — NON-BLOCKING.
// Returns instantly: 'fresh' (product current) or 'refreshing' (scrape kicked off
// in the background). The plugin polls until it goes fresh. This means no request
// hangs for the 5–15s scrape, and no WordPress PHP worker is held that whole time.
//
// Mount BEFORE the tenant line:
//   import productRefreshRoute from "./portal/productRefreshRoute.js";
//   app.use("/product", productRefreshRoute);
//   app.use("/product", tenantIdentify, productRoutes);
import { Router } from "express";
import { requireEnrollmentKey } from "./enrollmentKey.js";
import { findProduct, isStale, rescrape } from "../core/refreshProduct.js"; // adjust path if needed

const router = Router();

// in-memory: products currently being scraped, and when each was last attempted
const refreshing = new Set();
const lastAttempt = new Map();
const RETRY_COOLDOWN_MS = 60 * 1000; // don't re-fire a scrape for the same product within 60s

// GET /product/refresh-one?productId=70850&category=watches
router.get("/refresh-one", requireEnrollmentKey, async (req, res) => {
  try {
    const productId = req.query.productId;
    const category = req.query.category || req.query.productDb;
    if (!productId || !category) return res.status(400).json({ error: "productId and category required" });

    const catSources = (req.enrollment.sources || []).filter((s) => s.sourceCategory === category);
    if (!catSources.length) return res.status(403).json({ error: "Not enrolled in this category" });

    const product = await findProduct(productId, category);
    if (!product) return res.status(404).json({ error: "Product not found" });

    // the product must belong to one of THIS store's sources
    const src = catSources.find(
      (s) => s.searchKey && product.productFetchedFrom && product.productFetchedFrom.includes(s.searchKey)
    );
    if (!src) return res.status(403).json({ error: "Product not in your catalogue" });

    const apply = (p) => {
      if (src.catMap && src.catMap[p.catName]) p.catName = src.catMap[p.catName];
      p.dbName = category;
      return p;
    };

    // fresh enough — return immediately
    if (!isStale(product)) return res.json({ status: "fresh", product: apply(product) });

    // stale — start ONE background scrape (rate-limited), return without waiting
    const key = category + ":" + productId;
    const recentlyTried = lastAttempt.has(key) && Date.now() - lastAttempt.get(key) < RETRY_COOLDOWN_MS;
    if (!refreshing.has(key) && !recentlyTried) {
      refreshing.add(key);
      lastAttempt.set(key, Date.now());
      rescrape(product, category)
        .catch(() => {})
        .finally(() => refreshing.delete(key));
    }
    return res.json({ status: "refreshing", product: apply(product) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
