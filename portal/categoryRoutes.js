// Category endpoints.
//  client: read the enabled categories for a source (to pick from)
//  admin : list all (incl disabled), toggle enabled, re-refresh on demand
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { getSource, listSources } from "./sources.js";
import {
  listSourceCategories, setCategoryEnabled,
  refreshSourceCategoriesFromDB, refreshAllSourceCategoriesFromDB, scrapeSourceCategories,
} from "./categories.js";
import { scrapeCategoriesA, scrapeCategoriesB } from "./scrapeCategories.js";

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

// POST /portal/admin/sources/preview   { url, method? }
// Ad-hoc: scrape the category list from ANY storefront URL WITHOUT creating a
// source. Read-only — writes nothing to Postgres or SQLite. For testing a site
// before you approve it. `method` defaults to METHOD_B for jdwebconnect/
// jdwebnship hosts (the /categories SPA layout), else METHOD_A.
adminRouter.post("/preview", async (req, res) => {
  const url = req.body && req.body.url;
  if (!url) return res.status(400).json({ error: "url required" });

  let method = (req.body && req.body.method || "").toUpperCase();
  if (method !== "METHOD_A" && method !== "METHOD_B") {
    method = /jdweb(nship|connect)/i.test(url) ? "METHOD_B" : "METHOD_A";
  }

  try {
    const categories = method === "METHOD_B"
      ? await scrapeCategoriesB(url)
      : await scrapeCategoriesA(url);
    res.json({ ok: true, url, method, count: categories.length, categories });
  } catch (e) {
    console.error(`[categories] preview failed for ${url}:`, e.message);
    res.status(500).json({ error: e.message, url, method });
  }
});

// POST /portal/admin/sources/categories/refresh-all  -> re-derive EVERY source's
// categories (+ counts, + in-stock) from the stored products, and zero stale ones.
adminRouter.post("/categories/refresh-all", async (req, res) => {
  try {
    const n = await refreshAllSourceCategoriesFromDB();
    res.json({ ok: true, categories: n });
  } catch (e) {
    console.error("[categories] refresh-all failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

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
