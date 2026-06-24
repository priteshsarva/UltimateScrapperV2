// Category endpoints.
//  client: read the enabled categories for a source (to pick from)
//  admin : list all (incl disabled), toggle enabled, re-refresh on demand
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { getSource } from "./sources.js";
import {
  listSourceCategories, setCategoryEnabled,
  refreshSourceCategoriesFromDB, scrapeSourceCategories,
} from "./categories.js";

// ---------- client ----------
const clientRouter = Router();
clientRouter.use(requireAuth);

// GET /portal/sources/:id/categories  -> enabled categories to choose from
clientRouter.get("/:id/categories", async (req, res) => {
  res.json({ categories: await listSourceCategories(req.params.id, { enabledOnly: true }) });
});

// ---------- admin ----------
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// GET /portal/admin/sources/:id/categories  -> all, including disabled
adminRouter.get("/:id/categories", async (req, res) => {
  res.json({ categories: await listSourceCategories(req.params.id, { enabledOnly: false }) });
});

// PATCH /portal/admin/sources/:id/categories  { cat_name, enabled }
adminRouter.patch("/:id/categories", async (req, res) => {
  const { cat_name, enabled } = req.body || {};
  if (cat_name == null || typeof enabled !== "boolean")
    return res.status(400).json({ error: "cat_name and enabled (boolean) required" });
  const ok = await setCategoryEnabled(req.params.id, cat_name, enabled);
  if (!ok) return res.status(404).json({ error: "Category not found" });
  res.json({ ok: true });
});

// POST /portal/admin/sources/:id/categories/refresh  { mode: 'db' | 'scrape' }
//   db (default) = re-read from products (existing source)
//   scrape       = live re-scrape the category page (e.g. the site changed its menu)
adminRouter.post("/:id/categories/refresh", async (req, res) => {
  const source = await getSource(req.params.id);
  if (!source) return res.status(404).json({ error: "Source not found" });
  const mode = (req.body && req.body.mode) || "db";
  try {
    const n = mode === "scrape"
      ? await scrapeSourceCategories(source)
      : await refreshSourceCategoriesFromDB(source.id);
    res.json({ ok: true, mode, categories: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export { clientRouter as sourceCategoryRoutes, adminRouter as adminSourceCategoryRoutes };
