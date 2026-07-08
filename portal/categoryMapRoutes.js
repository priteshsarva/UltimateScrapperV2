// Client: each store manages its own category grouping.
//   app.use("/portal", categoryMapRoutes)
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";
import { enrollmentCategoriesWithMap, saveEnrollmentMappings, listCanonicalsForEnrollment } from "./categoryMap.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router();
router.use(requireAuth);

async function owns(enrollmentId, userId) {
  if (!UUID_RE.test(enrollmentId)) return false;
  return (await query(`select 1 from enrollments where id=$1 and user_id=$2`, [enrollmentId, userId])).rowCount > 0;
}

// GET /portal/enrollments/:id/category-map -> attached sources + categories + current canonical
router.get("/enrollments/:id/category-map", async (req, res) => {
  try {
    if (!(await owns(req.params.id, req.user.sub))) return res.status(404).json({ error: "Not found" });
    res.json({
      sources: await enrollmentCategoriesWithMap(req.params.id),
      canonicals: await listCanonicalsForEnrollment(req.params.id),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /portal/enrollments/:id/category-map { mappings: [{ source_id, cat_name, canonical }] }
router.post("/enrollments/:id/category-map", async (req, res) => {
  const { mappings } = req.body || {};
  if (!Array.isArray(mappings)) return res.status(400).json({ error: "mappings array required" });
  try {
    if (!(await owns(req.params.id, req.user.sub))) return res.status(404).json({ error: "Not found" });
    await saveEnrollmentMappings(req.params.id, mappings);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
