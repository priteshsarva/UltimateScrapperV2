// /portal/admin/*  — single-admin controls (requires admin JWT).
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { addMonth, todayISO, dateISO } from "./keys.js";

const router = Router();
router.use(requireAuth, requireAdmin);

async function audit(actor, action, target, meta) {
  await query(
    `insert into audit_log (actor, action, target, meta) values ($1,$2,$3,$4)`,
    [actor, action, target, meta ? JSON.stringify(meta) : null]
  ).catch(() => {});
}

// GET /portal/admin/enrollments?status=pending
router.get("/enrollments", async (req, res) => {
  const { status } = req.query;
  const sql = `select e.*, u.email as owner_email
                 from enrollments e join users u on u.id = e.user_id
                ${status ? "where e.status = $1" : ""}
                order by e.created_at desc`;
  const { rows } = await query(sql, status ? [status] : []);
  res.json({ enrollments: rows });
});

// POST /portal/admin/enrollments/:id/approve
router.post("/enrollments/:id/approve", async (req, res) => {
  const { rows } = await query(
    `update enrollments set status='approved'
      where id=$1 and status='pending' returning domain`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: "Not in pending state" });
  await audit(req.user.email, "Approved enrollment", rows[0].domain);
  res.json({ ok: true });
});

// POST /portal/admin/enrollments/:id/reject
router.post("/enrollments/:id/reject", async (req, res) => {
  const { rows } = await query(
    `update enrollments set status='rejected' where id=$1 returning domain`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  await audit(req.user.email, "Rejected enrollment", rows[0].domain);
  res.json({ ok: true });
});

// POST /portal/admin/enrollments/:id/activate
// First activation OR renewal: set active, extend expiry by one month.
// (Pay0 will later call this exact logic on confirmed payment.)
router.post("/enrollments/:id/activate", async (req, res) => {
  const { rows } = await query(
    `select expiry_date, domain from enrollments where id=$1`,
    [req.params.id]
  );
  const enr = rows[0];
  if (!enr) return res.status(404).json({ error: "Not found" });

  const today = todayISO();
  const cur = dateISO(enr.expiry_date);
  const base = cur && cur > today ? cur : today; // extend, don't shorten
  const newExpiry = addMonth(base);

  await query(
    `update enrollments set status='active', renewal_date=$1, expiry_date=$2 where id=$3`,
    [today, newExpiry, req.params.id]
  );
  await audit(req.user.email, "Activated/renewed enrollment", enr.domain, { newExpiry });
  res.json({ ok: true, expiry_date: newExpiry });
});

export default router;
