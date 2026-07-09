// New, KEYED live single-product refresh — for the new plugin only.
// The old /dev/update-single-product route stays exactly as-is for the old system.
//
// Mount it BEFORE the tenant line so it bypasses the old tenantIdentify layer
// (it authenticates via the enrollment key instead):
//   import productRefreshRoute from "./portal/productRefreshRoute.js";
//   app.use("/product", productRefreshRoute);              // <-- keyed, no tenantIdentify
//   app.use("/product", tenantIdentify, productRoutes);    // old system, unchanged
//
// It reuses your EXISTING re-scrape logic. Extract the core of your current
// /dev/update-single-product handler into a shared function:
//   export async function refreshSingleProduct(productId, dbName) { ...lookup + stale check + live scrape + write back...; return productRow | null }
// ...and both the old /dev route and this one call it (no duplicated scraper code).
import { Router } from "express";
import { requireEnrollmentKey } from "./enrollmentKey.js";
import { refreshSingleProduct } from "../core/refreshProduct.js"; // <-- adjust path to where you extract it

const router = Router();

// GET /product/refresh-one?productId=70850&category=watches
router.get("/refresh-one", requireEnrollmentKey, async (req, res) => {
  try {
    const productId = req.query.productId;
    const category = req.query.category || req.query.productDb; // accept either name
    if (!productId || !category) {
      return res.status(400).json({ error: "productId and category required" });
    }

    // only sources this store is enrolled in, for this category
    const catSources = (req.enrollment.sources || []).filter((s) => s.sourceCategory === category);
    if (!catSources.length) return res.status(403).json({ error: "Not enrolled in this category" });

    // your existing logic (now shared): re-scrape if stale, return the fresh row
    const result = await refreshSingleProduct(productId, category);
    if (!result || !result.product) return res.status(404).json({ error: "Product not found" });
    const product = result.product;

    // security: the product must belong to one of THIS store's sources
    const src = catSources.find(
      (s) => s.searchKey && product.productFetchedFrom && product.productFetchedFrom.includes(s.searchKey)
    );
    if (!src) return res.status(403).json({ error: "Product not in your catalogue" });

    // apply this store's category grouping, same as sync-feed
    if (src.catMap && src.catMap[product.catName]) product.catName = src.catMap[product.catName];
    product.dbName = category;

    res.json({ status: result.status, product });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
