// Admin DB maintenance endpoints.
//   app.use("/portal/admin/db", dbMaintenanceRoutes)   // admin-only
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { healthAll, integrityCheck, repairDb, listCategoryDbs } from "./dbMaintenance.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /portal/admin/db/health -> integrity + row count of every category DB
router.get("/health", async (_req, res) => {
  try { res.json({ databases: await healthAll() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /portal/admin/db/health/:category
router.get("/health/:category", async (req, res) => {
  try { res.json(await integrityCheck(req.params.category)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /portal/admin/db/repair  { category }
// Rebuilds a corrupt DB via .recover, backs up the original, cleans temp files.
router.post("/repair", async (req, res) => {
  const category = (req.body && req.body.category || "").trim();
  if (!category) return res.status(400).json({ error: "category required", available: listCategoryDbs() });
  try {
    const result = await repairDb(category);
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Archive endpoints live in portal/archiveRoutes.js (no Authorization required).

export default router;
