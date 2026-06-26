// Manage the sources attached to an enrollment (the multi-source feature).
// Mount alongside the existing enrollment router:  app.use("/portal", enrollmentSourceRoutes)
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";

const router = Router();
router.use(requireAuth);

// wraps an async handler so a thrown/rejected error becomes a clean 500 JSON
// instead of an unhandled rejection that prints a stack trace and crashes.
const asyncH = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error("enrollmentSourceRoutes error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// matches a Postgres UUID; lets us reject a bad :id cleanly instead of throwing
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// make sure the caller owns this enrollment; returns the row or null
async function ownedEnrollment(enrollmentId, userId) {
  if (!UUID_RE.test(String(enrollmentId || ""))) return null; // not a UUID -> not found
  const r = (await query(`select id, user_id, source_id from enrollments where id=$1`, [enrollmentId])).rows[0];
  return r && r.user_id === userId ? r : null;
}

// backfill the enrollment's primary source into the child table if it's not there
// (protects enrollments created before child rows existed from losing their source)
async function ensurePrimary(enrollmentId) {
  await query(
    `insert into enrollment_sources (enrollment_id, source_id, categories)
     select e.id, e.source_id, coalesce(e.categories,'{}')
       from enrollments e where e.id=$1 and e.source_id is not null
     on conflict (enrollment_id, source_id) do nothing`,
    [enrollmentId]
  );
}

// GET /portal/enrollments/:id/sources  -> sources on this enrollment
router.get("/enrollments/:id/sources", asyncH(async (req, res) => {
  const enr = await ownedEnrollment(req.params.id, req.user.sub);
  if (!enr) return res.status(404).json({ error: "Enrollment not found" });
  await ensurePrimary(req.params.id);
  const rows = (await query(
    `select es.source_id, es.categories, s.name, s.category
       from enrollment_sources es join sources s on s.id=es.source_id
      where es.enrollment_id=$1
      order by s.name`,
    [req.params.id]
  )).rows;
  res.json({ sources: rows });
}));

// POST /portal/enrollments/:id/sources  { source_id, categories? }
// add another source to this site (must match the site's category)
router.post("/enrollments/:id/sources", asyncH(async (req, res) => {
  const { source_id, categories } = req.body || {};
  if (!source_id) return res.status(400).json({ error: "source_id required" });

  const enr = await ownedEnrollment(req.params.id, req.user.sub);
  if (!enr) return res.status(404).json({ error: "Enrollment not found" });

  const src = (await query(`select id, category from sources where id=$1`, [source_id])).rows[0];
  if (!src) return res.status(404).json({ error: "Source not found" });

  await ensurePrimary(req.params.id);

  // all sources on a site must share a category (they share one product DB)
  const existing = (await query(
    `select s.category from enrollment_sources es join sources s on s.id=es.source_id
      where es.enrollment_id=$1 limit 1`,
    [req.params.id]
  )).rows[0];
  if (existing && existing.category !== src.category) {
    return res.status(400).json({
      error: `This site sells ${existing.category}; cannot add a ${src.category} source.`,
    });
  }

  await query(
    `insert into enrollment_sources (enrollment_id, source_id, categories)
     values ($1,$2,$3)
     on conflict (enrollment_id, source_id) do update set categories=excluded.categories`,
    [req.params.id, source_id, categories || []]
  );
  res.json({ ok: true, source_id, categories: categories || [] });
}));

// PATCH /portal/enrollments/:id/sources/:sourceId  { categories }
router.patch("/enrollments/:id/sources/:sourceId", asyncH(async (req, res) => {
  const { categories } = req.body || {};
  const enr = await ownedEnrollment(req.params.id, req.user.sub);
  if (!enr) return res.status(404).json({ error: "Enrollment not found" });
  const { rowCount } = await query(
    `update enrollment_sources set categories=$1 where enrollment_id=$2 and source_id=$3`,
    [categories || [], req.params.id, req.params.sourceId]
  );
  if (!rowCount) return res.status(404).json({ error: "Source not on this enrollment" });
  res.json({ ok: true });
}));

// DELETE /portal/enrollments/:id/sources/:sourceId
router.delete("/enrollments/:id/sources/:sourceId", asyncH(async (req, res) => {
  const enr = await ownedEnrollment(req.params.id, req.user.sub);
  if (!enr) return res.status(404).json({ error: "Enrollment not found" });
  await query(
    `delete from enrollment_sources where enrollment_id=$1 and source_id=$2`,
    [req.params.id, req.params.sourceId]
  );
  res.json({ ok: true });
}));

export default router;