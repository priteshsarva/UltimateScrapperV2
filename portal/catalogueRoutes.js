// Client-facing catalogue research: browse the RAW scraped products across ALL
// source sites we hold, with the supplier product URL + source name (so a vendor
// can see where a product comes from and open it). Read-only. Intentionally
// exposes the supplier link — it's the vendor's own research tool, NOT the
// shopper-facing storefront. The actual query lives in ./catalogueSearch.js and
// is shared with the public search landing.
//   app.use("/portal", catalogueRoutes)  ->  GET /portal/catalogue
import { Router } from "express";
import { requireAuth } from "./auth.js";
import { searchCatalogue } from "./catalogueSearch.js";
import { logCatalogue } from "./activityLog.js";
import { kickLiveRefresh } from "./searchRoutes.js";

const router = Router();
router.use(requireAuth);

// GET /portal/catalogue?q=&category=&page=&limit=&stock=&size=&brand=&source=&sort=&price_min=&price_max=
router.get("/catalogue", async (req, res) => {
  try {
    const out = await searchCatalogue(req.query);
    const q = (req.query.q || "").toString().trim();
    if (q.length >= 2) logCatalogue({
      event: "search", scope: "vendor", user_id: req.user.sub,
      q, category: req.query.category || null, results_count: out.count,
      filters: { stock: req.query.stock, brand: req.query.brand, size: req.query.size, source: req.query.source, sort: req.query.sort },
    });
    res.json(out);
  } catch (e) {
    console.error("[catalogue]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Vendor clicked a product in the research tool — record which one (fire-and-forget).
router.post("/catalogue/click", (req, res) => {
  const b = req.body || {};
  logCatalogue({
    event: "open", scope: "vendor", user_id: req.user.sub,
    category: b.category || null, product_id: b.productId ? String(b.productId).slice(0, 80) : null,
    product_name: b.name ? String(b.name).slice(0, 300) : null, source_name: b.source ? String(b.source).slice(0, 120) : null,
  });
  // Opening a product also kicks a background live re-scrape (same cooldown /
  // in-flight budget as the public search landing) so the vendor sees fresh
  // price/stock next load.
  kickLiveRefresh(b.category, b.productId);
  res.json({ ok: true });
});

export default router;
