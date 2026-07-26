// Category endpoints.
//  client: read the enabled categories for a source (to pick from)
//  admin : list all (incl disabled), toggle enabled, re-refresh on demand
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { getSource, listSources } from "./sources.js";
import {
  listSourceCategories, setCategoryEnabled,
  refreshSourceCategoriesFromDB, scrapeSourceCategories,
} from "./categories.js";

// ---------- client ----------
const clientRouter = Router();
clientRouter.use(requireAuth);

// GET /portal/sources  -> active sources (for the enroll / add-source picker)
clientRouter.get("/", async (req, res) => {
  try {
    const all = await listSources({});
    const sources = all
      .filter((s) => s.status === "active")
      .map((s) => ({ id: s.id, name: s.name, category: s.category }));
    res.json({ sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /portal/sources/:id/categories  -> enabled categories to choose from
// Deprecated categories are hidden from clients: a category the supplier has
// dropped should not appear in the picker.
clientRouter.get("/:id/categories", async (req, res) => {
  res.json({
    categories: await listSourceCategories(req.params.id, {
      enabledOnly: true,
      includeDeprecated: false,
    }),
  });
});

// ---------- admin ----------
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// GET /portal/admin/sources/:id/categories  -> all, including disabled + deprecated
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

// POST /portal/admin/sources/:id/categories/refresh
//   { mode: 'db' | 'scrape', dryRun?: boolean }
//
//   db (default) = re-read counts from products (existing source). Never deprecates.
//   scrape       = live re-scrape the category page and RECONCILE:
//                  renames tracked, new categories added disabled,
//                  vanished categories marked deprecated.
//   dryRun       = scrape mode only; reports what WOULD change, writes nothing.
adminRouter.post("/:id/categories/refresh", async (req, res) => {
  const source = await getSource(req.params.id);
  if (!source) return res.status(404).json({ error: "Source not found" });

  const mode   = (req.body && req.body.mode) || "db";
  const dryRun = !!(req.body && req.body.dryRun);

  try {
    if (mode === "scrape") {
      const result = await scrapeSourceCategories(source, { dryRun });
      // `categories` kept for backwards compatibility with the existing portal UI
      return res.json({ ok: true, mode, dryRun, categories: result.scrapedCount, result });
    }

    const n = await refreshSourceCategoriesFromDB(source.id);
    return res.json({ ok: true, mode, categories: n });
  } catch (e) {
    console.error(`[categories] refresh failed for ${source.id}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

export { clientRouter as sourceCategoryRoutes, adminRouter as adminSourceCategoryRoutes };
