// Admin shop lifecycle.
//   app.use("/portal/admin/shops", shopAdminRoutes)
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { generateInvoiceForEnrollment } from "./billing.js";
import { sendShopApprovedEmail } from "./mailer.js";
import { billingTick } from "./scheduler.js";

const router = Router();
router.use(requireAuth, requireAdmin);

// assign / change a shop's plan (needed before approval; also fixes legacy plan-less shops)
router.patch("/:id/plan", async (req, res) => {
  const { plan_id } = req.body || {};
  if (!plan_id) return res.status(400).json({ error: "plan_id required" });
  try {
    const r = await query(`update enrollments set plan_id=$1 where id=$2 returning id, plan_id`, [plan_id, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Shop not found" });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// approve a shop -> generate its first invoice immediately -> email the owner
router.post("/:id/approve", async (req, res) => {
  try {
    const enr = (await query(`select * from enrollments where id=$1`, [req.params.id])).rows[0];
    if (!enr) return res.status(404).json({ error: "Shop not found" });
    if (!enr.plan_id) return res.status(400).json({ error: "Assign a plan to this shop before approving." });

    await query(`update enrollments set status='approved' where id=$1`, [enr.id]);

    const invoice = await generateInvoiceForEnrollment(enr.id, { periodStart: new Date() });
    if (!invoice) return res.status(500).json({ error: "Could not generate invoice (check the shop's plan)." });

    const user = (await query(`select id,email,name from users where id=$1`, [enr.user_id])).rows[0];
    if (user) await sendShopApprovedEmail(user, enr, invoice);

    await query(`insert into audit_log (actor, action, target) values ($1,'Approved shop + issued invoice',$2)`,
      [req.user.email, enr.domain]);

    res.json({ ok: true, invoice });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// manual trigger for the daily billing job (for testing, or an external system cron)
router.post("/run-billing-tick", async (req, res) => {
  try { res.json(await billingTick()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
