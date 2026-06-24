// Scrape requests: client create/list + admin queue/approve/reject.
// Approve does the categories-first flow: create source -> scrape category list
// (fast, so the client can pick) -> enqueue the full bulk scrape in the background.
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { upsertSource } from "./sources.js";
import { enqueueScrape } from "./scrapeQueue.js";
import { scrapeSourceCategories, refreshSourceCategoriesFromDB } from "./categories.js";

// ---------- client ----------
const clientRouter = Router();
clientRouter.use(requireAuth);

// POST /portal/scrape-requests   { site_url, category }
clientRouter.post("/", async (req, res) => {
  const { site_url, category } = req.body || {};
  if (!site_url || !category)
    return res.status(400).json({ error: "site_url and category required" });
  const { rows } = await query(
    `insert into scrape_requests (user_id, site_url, category)
     values ($1,$2,$3)
     returning id, site_url, category, status, created_at`,
    [req.user.sub, site_url, category]
  );
  res.json({ request: rows[0] });
});

// GET /portal/scrape-requests   -> mine
clientRouter.get("/", async (req, res) => {
  const { rows } = await query(
    `select id, site_url, category, status, created_at, decided_at
       from scrape_requests where user_id=$1 order by created_at desc`,
    [req.user.sub]
  );
  res.json({ requests: rows });
});

// ---------- admin ----------
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// GET /portal/admin/scrape-requests?status=pending
adminRouter.get("/", async (req, res) => {
  const { status } = req.query;
  const sql = `select r.*, u.email as owner_email
                 from scrape_requests r join users u on u.id = r.user_id
                ${status ? "where r.status=$1" : ""}
                order by r.created_at desc`;
  const { rows } = await query(sql, status ? [status] : []);
  res.json({ requests: rows });
});

// POST /portal/admin/scrape-requests/:id/approve
// body: { source_id, name, method, base_url, search_key }
adminRouter.post("/:id/approve", async (req, res) => {
  const { source_id, name, method, base_url, search_key } = req.body || {};
  if (!source_id || !method || !base_url)
    return res.status(400).json({ error: "source_id, method, base_url required" });

  const reqRow = (await query(`select * from scrape_requests where id=$1`, [req.params.id])).rows[0];
  if (!reqRow) return res.status(404).json({ error: "Request not found" });

  // 1) create/configure the source
  const source = await upsertSource({
    id: source_id,
    name: name || source_id,
    category: reqRow.category,          // shoes/watches came from the client's request
    method,
    base_url,
    search_key: search_key || source_id,
    status: "active",
  });

  await query(`update scrape_requests set status='approved', decided_at=now() where id=$1`, [req.params.id]);
  await query(
    `insert into audit_log (actor, action, target) values ($1,'Approved scrape request',$2)`,
    [req.user.email, reqRow.site_url]
  );

  // 2) categories-first: scrape just the category list now (so the client can pick)
  let categoriesFound = 0;
  try {
    categoriesFound = await scrapeSourceCategories(source);
  } catch (e) {
    console.error("category scrape failed:", source.id, e.message);
  }

  // 3) full bulk scrape in the background through the shared queue;
  //    refresh category counts from the DB once it finishes.
  enqueueScrape(source)
    .then(() => refreshSourceCategoriesFromDB(source.id).catch(() => {}))
    .catch(() => {});

  res.json({ ok: true, source_id: source.id, categoriesFound });
});

// POST /portal/admin/scrape-requests/:id/reject
adminRouter.post("/:id/reject", async (req, res) => {
  const { rows } = await query(
    `update scrape_requests set status='rejected', decided_at=now() where id=$1 returning site_url`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  await query(
    `insert into audit_log (actor, action, target) values ($1,'Rejected scrape request',$2)`,
    [req.user.email, rows[0].site_url]
  );
  res.json({ ok: true });
});

export { clientRouter as scrapeRequestRoutes, adminRouter as adminScrapeRequestRoutes };
