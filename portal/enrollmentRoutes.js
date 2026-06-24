// /portal/*  — client-facing enrollment management (requires client JWT).
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";
import { generateEnrollmentKey } from "./keys.js";

const router = Router();
router.use(requireAuth);

// GET /portal/enrollments  -> my sites
router.get("/enrollments", async (req, res) => {
  const { rows } = await query(
    `select id, domain, source_id, enrollment_key, status, categories,
            renewal_date, expiry_date, last_sync_at, created_at
       from enrollments where user_id=$1 order by created_at desc`,
    [req.user.sub]
  );
  res.json({ enrollments: rows });
});

// POST /portal/enrollments  { domain, source_id }  -> pending + issued key
router.post("/enrollments", async (req, res) => {
  const { domain, source_id } = req.body || {};
  if (!domain || !source_id)
    return res.status(400).json({ error: "domain and source_id required" });
  try {
    const src = await query(`select 1 from sources where id=$1`, [source_id]);
    if (!src.rowCount) return res.status(400).json({ error: "Unknown source_id" });

    const key = generateEnrollmentKey();
    const { rows } = await query(
      `insert into enrollments (user_id, domain, source_id, enrollment_key, status, categories)
       values ($1,$2,$3,$4,'pending','{}')
       returning id, domain, source_id, enrollment_key, status, categories, expiry_date`,
      [req.user.sub, domain, source_id, key]
    );
    res.json({ enrollment: rows[0] });
  } catch (err) {
    if (err.code === "23505")
      return res.status(409).json({ error: "That domain is already enrolled for this source" });
    console.error("create enrollment error:", err);
    res.status(500).json({ error: "Could not create enrollment" });
  }
});

// PATCH /portal/enrollments/:id/categories  { categories: [...] }
router.patch("/enrollments/:id/categories", async (req, res) => {
  const { categories } = req.body || {};
  if (!Array.isArray(categories))
    return res.status(400).json({ error: "categories must be an array" });
  const { rowCount } = await query(
    `update enrollments set categories=$1 where id=$2 and user_id=$3`,
    [categories, req.params.id, req.user.sub]
  );
  if (!rowCount) return res.status(404).json({ error: "Enrollment not found" });
  res.json({ ok: true });
});

export default router;
