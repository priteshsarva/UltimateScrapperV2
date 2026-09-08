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

const router = Router();
router.use(requireAuth);

// GET /portal/catalogue?q=&category=&page=&limit=&stock=&size=&brand=&source=&sort=&price_min=&price_max=
router.get("/catalogue", async (req, res) => {
  try {
    res.json(await searchCatalogue(req.query));
  } catch (e) {
    console.error("[catalogue]", e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
