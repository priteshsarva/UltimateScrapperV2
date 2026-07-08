// Admin: manage canonical category mappings.
//   app.use("/portal/admin", categoryMapRoutes)
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { sourceCategoriesWithMap, saveMappings, listCanonicals } from "./categoryMap.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// a source's categories + their current canonical
router.get("/sources/:id/category-map", async (req, res) => {
  try { res.json({ categories: await sourceCategoriesWithMap(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// save mappings: { mappings: [{ cat_name, canonical }] }  (blank canonical clears it)
router.post("/sources/:id/category-map", async (req, res) => {
  const { mappings } = req.body || {};
  if (!Array.isArray(mappings)) return res.status(400).json({ error: "mappings array required" });
  try { await saveMappings(req.params.id, mappings); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// distinct canonical names (autocomplete)
router.get("/canonical-categories", async (req, res) => {
  try { res.json({ canonicals: await listCanonicals() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
