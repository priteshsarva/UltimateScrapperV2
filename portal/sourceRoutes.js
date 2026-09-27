// /portal/admin/sources/*  — admin control over the scrape registry.
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { listSources, getSource, upsertSource, setSourceStatus, deleteSource } from "./sources.js";
import { enqueueScrape, scrapeQueueDepth, scrapeState } from "./scrapeQueue.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// GET /portal/admin/sources?status=active
router.get("/", async (req, res) => {
  res.json({ sources: await listSources({ status: req.query.status }) });
});

// GET /portal/admin/sources/scrape-status  -> is the big update running, + queue depth
// (must be declared before any "/:id" route so it isn't captured as an id).
router.get("/scrape-status", (_req, res) => {
  res.json({ batchRunning: !!scrapeState.batchRunning, depth: scrapeQueueDepth() });
});

// POST /portal/admin/sources/:id/scrape  -> scrape this one source now (on-demand).
// Goes through the shared single-runner queue, so it never collides with the rotator.
// Refused while the /devproductupdates batch is running.
router.post("/:id/scrape", async (req, res) => {
  if (scrapeState.batchRunning)
    return res.status(409).json({ error: "A full product update is running — try again once it finishes." });
  const source = await getSource(req.params.id);
  if (!source) return res.status(404).json({ error: "Source not found" });
  if (source.method === "MANUAL")
    return res.status(400).json({ error: "This source is MANUAL (not auto-scraped)." });
  enqueueScrape(source);   // fire-and-forget; resolves in the background
  res.json({ queued: true, depth: scrapeQueueDepth() });
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
  try {
    const cur = await getSource(req.params.id);
    if (!cur) return res.status(404).json({ error: "Not found" });
    if (req.body.status) await setSourceStatus(req.params.id, req.body.status);
    const merged = { ...cur, ...req.body, id: req.params.id };
    res.json({ source: await upsertSource(merged) });
  } catch (e) {
    // e.g. an invalid method hits the sources_method_check constraint — return a
    // clear error instead of an unhandled rejection that crash-loops the server.
    res.status(400).json({ error: e.message });
  }
});

// DELETE /portal/admin/sources/:id  — remove from the registry (blocked if in use)
router.delete("/:id", async (req, res) => {
  const cur = await getSource(req.params.id);
  if (!cur) return res.status(404).json({ error: "Not found" });
  try {
    await deleteSource(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
