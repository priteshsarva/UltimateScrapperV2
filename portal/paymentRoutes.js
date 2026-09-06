// Client billing + Pay0 payment.
//   app.use("/portal", paymentRoutes)
// Note: /portal/pay/callback is intentionally unauthenticated — Pay0 redirects the
// user's browser there with no session. It verifies server-side and bounces to the app.
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { createOrder, checkStatus } from "./pay0.js";
import { markInvoicePaid } from "./billing.js";
import { sendPaymentReceivedEmail } from "./mailer.js";

const router = Router();
const APP_URL = process.env.APP_URL || "http://localhost:5174";
const SERVER_URL = (process.env.SERVER_PUBLIC_URL || "").replace(/\/+$/, "");

// list the signed-in user's invoices
router.get("/invoices", requireAuth, async (req, res) => {
  try {
    const rows = (await query(
      `select i.*, e.domain
         from invoices i
         left join enrollments e on e.id = i.enrollment_id
        where i.user_id = $1
        order by i.created_at desc`,
      [req.user.sub]
    )).rows;
    res.json({ invoices: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// start payment for an invoice -> returns Pay0 payment_url to redirect to
router.post("/invoices/:id/pay", requireAuth, async (req, res) => {
  try {
    const inv = (await query(`select * from invoices where id=$1 and user_id=$2`, [req.params.id, req.user.sub])).rows[0];
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "paid") return res.status(400).json({ error: "Already paid" });

    const user = (await query(`select mobile from users where id=$1`, [req.user.sub])).rows[0] || {};
    const orderId = `INV-${inv.id}`; // stable per invoice, so re-tries reuse the same order
    const redirectUrl = SERVER_URL ? `${SERVER_URL}/portal/pay/callback?invoice=${inv.id}` : `${APP_URL}/billing`;

    const order = await createOrder({
      amount: inv.amount,
      orderId,
      customerMobile: user.mobile,
      redirectUrl,
      remark: inv.invoice_no,
    });
    if (!order.ok || !order.payment_url) {
      return res.status(502).json({ error: "Payment gateway error", detail: order.message });
    }

    await query(
      `update invoices set gateway_order_id=$1, gateway_payment_url=$2, status='pending' where id=$3`,
      [order.order_id, order.payment_url, inv.id]
    );
    res.json({ payment_url: order.payment_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// verify + finalize a payment (shared by the callback and client polling)
async function finalize(invoiceId) {
  const inv = (await query(`select * from invoices where id=$1`, [invoiceId])).rows[0];
  if (!inv) return { ok: false, error: "not found" };
  if (inv.status === "paid") return { ok: true, paid: true };
  if (!inv.gateway_order_id) return { ok: false, error: "payment not started" };

  const st = await checkStatus(inv.gateway_order_id);
  if (!st.paid) return { ok: true, paid: false, status: st.status };

  await markInvoicePaid(inv.id, st.utr);
  const enr = inv.enrollment_id ? (await query(`select * from enrollments where id=$1`, [inv.enrollment_id])).rows[0] : null;
  const user = (await query(`select id,email,name from users where id=$1`, [inv.user_id])).rows[0];
  if (enr && user) await sendPaymentReceivedEmail(user, enr, inv);
  return { ok: true, paid: true };
}

// client polls this after returning from Pay0
router.get("/invoices/:id/verify", requireAuth, async (req, res) => {
  const owned = (await query(`select id from invoices where id=$1 and user_id=$2`, [req.params.id, req.user.sub])).rows[0];
  if (!owned) return res.status(404).json({ error: "Invoice not found" });
  try { res.json(await finalize(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Client declares they've paid this invoice by UPI (manual). Records the UTR and
// flags the invoice 'pending' so an admin can confirm it — does NOT mark it paid.
router.post("/invoices/:id/upi-claim", requireAuth, async (req, res) => {
  try {
    const inv = (await query(`select * from invoices where id=$1 and user_id=$2`, [req.params.id, req.user.sub])).rows[0];
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "paid") return res.status(400).json({ error: "Already paid" });
    const utr = (req.body && req.body.utr) ? String(req.body.utr).trim().slice(0, 64) : null;
    await query(`update invoices set status='pending', gateway='upi', utr=coalesce($2, utr) where id=$1`, [inv.id, utr]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- admin: manual invoice reconciliation (UPI) ----------
// List invoices (optionally by status) with who owes and for which shop.
router.get("/admin/invoices", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let sql = `select i.*, e.domain, u.email as user_email, u.name as user_name
                 from invoices i
                 left join enrollments e on e.id = i.enrollment_id
                 left join users u on u.id = i.user_id`;
    if (status) { params.push(status); sql += ` where i.status = $${params.length}`; }
    sql += ` order by i.created_at desc limit 500`;
    res.json({ invoices: (await query(sql, params)).rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Confirm a UPI/manual payment: marks paid + activates/extends the shop + emails.
router.post("/admin/invoices/:id/mark-paid", requireAuth, requireAdmin, async (req, res) => {
  try {
    const inv = (await query(`select * from invoices where id=$1`, [req.params.id])).rows[0];
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "paid") return res.json({ ok: true, already: true });
    const utr = (req.body && req.body.utr) ? String(req.body.utr).trim().slice(0, 64) : inv.utr;
    await markInvoicePaid(inv.id, utr);
    const enr = inv.enrollment_id ? (await query(`select * from enrollments where id=$1`, [inv.enrollment_id])).rows[0] : null;
    const user = (await query(`select id,email,name from users where id=$1`, [inv.user_id])).rows[0];
    if (enr && user) sendPaymentReceivedEmail(user, enr, inv).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pay0 redirects the browser here after payment; verify then bounce back to the app
router.get("/pay/callback", async (req, res) => {
  const invoiceId = req.query.invoice;
  if (invoiceId) { try { await finalize(String(invoiceId)); } catch (e) { /* ignore, app will re-verify */ } }
  res.redirect(`${APP_URL}/billing?paid=${invoiceId || ""}`);
});

export default router;
