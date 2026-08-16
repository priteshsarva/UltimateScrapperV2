// Admin DB maintenance endpoints.
//   app.use("/portal/admin/db", dbMaintenanceRoutes)   // admin-only
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import {
  healthAll, integrityCheck, repairDb,
  previewArchive, archiveStale, archiveStaleAll, listCategoryDbs,
} from "./dbMaintenance.js";

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

// GET /portal/admin/db/archive-stale/preview?category=&months=2  (dry run)
// category omitted -> preview every DB.
router.get("/archive-stale/preview", async (req, res) => {
  const { category, months } = req.query;
  try {
    if (category) return res.json(await previewArchive(category, months));
    const all = [];
    for (const c of listCategoryDbs()) all.push(await previewArchive(c, months));
    res.json({ months: parseFloat(months) || 2, databases: all });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /portal/admin/db/archive-stale  { category?, months? }
// Moves products that are out of stock AND untouched for `months` (default 2)
// into PRODUCTS_ARCHIVE. Omit category to run across all DBs.
router.post("/archive-stale", async (req, res) => {
  const { category, months } = req.body || {};
  try {
    if (category) return res.json(await archiveStale(category, months));
    res.json({ databases: await archiveStaleAll(months) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
