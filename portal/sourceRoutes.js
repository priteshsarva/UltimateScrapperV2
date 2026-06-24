// /portal/admin/sources/*  — admin control over the scrape registry.
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { listSources, getSource, upsertSource, setSourceStatus } from "./sources.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /portal/admin/sources?status=active
router.get("/", async (req, res) => {
  res.json({ sources: await listSources({ status: req.query.status }) });
});

// POST /portal/admin/sources   { id, name, category, method, base_url, search_key }
router.post("/", async (req, res) => {
  const { id, name, category, method, base_url, search_key } = req.body || {};
  if (!id || !category || !method)
    return res.status(400).json({ error: "id, category, method required" });
  try {
    res.json({ source: await upsertSource({ id, name, category, method, base_url, search_key }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /portal/admin/sources/:id   (edit any field, or { status:'paused'|'active' })
router.patch("/:id", async (req, res) => {
  const cur = await getSource(req.params.id);
  if (!cur) return res.status(404).json({ error: "Not found" });
  if (req.body.status) await setSourceStatus(req.params.id, req.body.status);
  const merged = { ...cur, ...req.body, id: req.params.id };
  res.json({ source: await upsertSource(merged) });
});

export default router;
