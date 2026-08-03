// Plugin-facing payment — keyed by the site's enrollment key (x-enrollment-key).
//
// THE POINT OF THIS FILE
//   The WordPress plugin NEVER holds gateway credentials and never talks to a
//   gateway directly. It only:
//     1) GET  /product/pay-config  — "is online payment on, what's it called, do I
//                                    have a due invoice?"  (no secrets)
//     2) POST /product/pay-start   — "make me a pay link for my due invoice"
//                                    (server builds it with the ACTIVE gateway)
//   So when the admin switches the gateway in the portal, the plugin keeps calling
//   these same two endpoints and just works — no plugin re-upload, ever.
//
// Mount under /product BEFORE the productRoutes /:id catch-all.
import { Router } from "express";
import { requireEnrollmentKey } from "./enrollmentKey.js";
import { query } from "./db.js";
import { getPaymentPublic } from "./settings.js";
import { createOrder } from "./pay0.js";

const router = Router();
const SERVER_URL = (process.env.SERVER_PUBLIC_URL || "").replace(/\/+$/, "");
const APP_URL = process.env.APP_URL || "";

// the shop's most recent unpaid invoice, or null
async function dueInvoice(enrollmentId) {
  return (await query(
    `select id, invoice_no, amount, currency, status, due_date, gateway_payment_url
       from invoices
      where enrollment_id = $1 and status in ('created','pending')
      order by created_at desc
      limit 1`,
    [enrollmentId]
  )).rows[0] || null;
}

// GET /product/pay-config  (keyed) — non-secret gateway info + this shop's due invoice
router.get("/pay-config", requireEnrollmentKey, async (req, res) => {
  try {
    const pub = await getPaymentPublic();
    const inv = await dueInvoice(req.enrollment.id);
    res.json({
      ...pub,                              // { enabled, provider, title, description }
      due_invoice: inv && {
        invoice_no: inv.invoice_no, amount: inv.amount,
        currency: inv.currency, due_date: inv.due_date, status: inv.status,
      },
      // where a browser can complete payment (portal fallback if no gateway link yet)
      portal_billing_url: APP_URL ? `${APP_URL}/billing` : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /product/pay-start  (keyed) — create a pay link for the shop's due invoice
router.post("/pay-start", requireEnrollmentKey, async (req, res) => {
  try {
    const pub = await getPaymentPublic();
    if (!pub.enabled) return res.status(400).json({ error: "Online payment is not enabled" });

    const inv = await dueInvoice(req.enrollment.id);
    if (!inv) return res.status(404).json({ error: "No due invoice for this shop" });

    // reuse an existing gateway link if one was already made for this invoice
    if (inv.gateway_payment_url) {
      return res.json({ pay_url: inv.gateway_payment_url, invoice_no: inv.invoice_no, amount: inv.amount, currency: inv.currency });
    }

    const user = (await query(`select mobile from users where id=$1`, [req.enrollment.userId])).rows[0] || {};
    const redirectUrl = SERVER_URL
      ? `${SERVER_URL}/portal/pay/callback?invoice=${inv.id}`
      : (APP_URL ? `${APP_URL}/billing` : "");

    const order = await createOrder({
      amount: inv.amount,
      orderId: `INV-${inv.id}`,          // stable per invoice so retries reuse it
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
    res.json({ pay_url: order.payment_url, invoice_no: inv.invoice_no, amount: inv.amount, currency: inv.currency });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
