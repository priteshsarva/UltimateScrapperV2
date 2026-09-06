// Payment verification + two-leg shipments (money-in and release).
//   app.use("/portal", fulfilmentClientRoutes)
//   app.use("/portal/admin", fulfilmentAdminRoutes)
//
// Flow: admin/vendor verifies payment -> verifyOrderPayment holds each party's
// share. Wholesaler ships to retailer (leg 1) + retailer ships to customer
// (leg 2), each with 2-10 parcel photos. Admin approves a leg -> that leg's
// party's held share is RELEASED to their available balance. Photos auto-purge
// after 60 days (admin can download first).
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { withLedger } from "./wallet.js";
import { verifyOrderPayment, refundOrder } from "./orderVerify.js";
import { notify } from "./notifications.js";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[fulfilment]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PURGE_DAYS = 60;

// Release each listed user's OUTSTANDING hold (hold - already released/refunded)
// for an order.
async function releaseOutstanding(orderId, userIds) {
  if (!userIds.length) return [];
  const { rows } = await query(
    `select user_id,
        coalesce(sum(amount) filter (where type='hold'),0)
        - coalesce(sum(amount) filter (where type in ('release','refund')),0) as outstanding
       from wallet_ledger where order_id=$1 and user_id = any($2) group by user_id`,
    [orderId, userIds]
  );
  const entries = rows.filter((r) => Number(r.outstanding) > 0).map((r) => ({
    user_id: r.user_id, type: "release", amount: round2(r.outstanding), order_id: orderId, note: "Shipment confirmed",
  }));
  if (entries.length) await withLedger(entries);
  return entries;
}

// user_ids of the wholesale suppliers on an order
async function supplierUserIds(orderId) {
  const { rows } = await query(
    `select distinct e.user_id from order_items oi join enrollments e on e.id = oi.supplier_enrollment_id
      where oi.order_id=$1 and oi.supplier_enrollment_id is not null`, [orderId]
  );
  return rows.map((r) => r.user_id);
}

// Is this user a party to the order for the given leg?
async function canSubmitLeg(userId, order, leg) {
  if (leg === "retailer_to_customer") {
    const store = (await query(`select user_id from enrollments where id=$1`, [order.enrollment_id])).rows[0];
    return store && store.user_id === userId;
  }
  // wholesaler_to_retailer: any supplier on the order
  return (await supplierUserIds(order.id)).includes(userId);
}

// ============================================================ client
const clientRouter = Router();
clientRouter.use(requireAuth);

// Vendor confirms the buyer's payment for one of THEIR store's orders.
clientRouter.post("/hosted-sites/:id/orders/:orderId/verify-payment", asyncH(async (req, res) => {
  const own = (await query(`select 1 from enrollments where id=$1 and user_id=$2`, [req.params.id, req.user.sub])).rows[0];
  if (!own) return res.status(404).json({ error: "Site not found" });
  const ord = (await query(`select id from orders where id=$1 and enrollment_id=$2`, [req.params.orderId, req.params.id])).rows[0];
  if (!ord) return res.status(404).json({ error: "Order not found" });
  res.json(await verifyOrderPayment(ord.id, { utr: req.body?.utr }));
}));

// Submit a shipment leg with parcel photos (2..10).
clientRouter.post("/shipments", asyncH(async (req, res) => {
  const { order_id, leg, courier, tracking_no, photos } = req.body || {};
  if (!order_id || !["wholesaler_to_retailer", "retailer_to_customer"].includes(leg)) return res.status(400).json({ error: "order_id and a valid leg are required" });
  const pics = Array.isArray(photos) ? photos.filter((p) => p && p.url) : [];
  if (pics.length < 2) return res.status(400).json({ error: "At least 2 parcel photos are required." });
  if (pics.length > 10) return res.status(400).json({ error: "Up to 10 photos." });

  const order = (await query(`select * from orders where id=$1`, [order_id])).rows[0];
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!(await canSubmitLeg(req.user.sub, order, leg))) return res.status(403).json({ error: "You're not a party to this shipment." });

  const purgeAfter = new Date(Date.now() + PURGE_DAYS * 86400 * 1000);
  const r = (await query(
    `insert into shipments (order_id, leg, shipped_by, courier, tracking_no, photos, status, purge_after)
     values ($1,$2,$3,$4,$5,$6,'submitted',$7) returning *`,
    [order_id, leg, req.user.sub, courier || null, tracking_no || null, JSON.stringify(pics), purgeAfter]
  )).rows[0];
  res.json({ shipment: r });
}));

// Shipments the current user is a party to (as supplier or store owner).
clientRouter.get("/shipments", asyncH(async (req, res) => {
  const { order_id } = req.query;
  if (order_id) {
    return res.json({ shipments: (await query(`select * from shipments where order_id=$1 order by created_at`, [order_id])).rows });
  }
  const { rows } = await query(
    `select s.*, o.order_no from shipments s join orders o on o.id=s.order_id where s.shipped_by=$1 order by s.created_at desc limit 200`,
    [req.user.sub]
  );
  res.json({ shipments: rows });
}));

// ============================================================ admin
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.post("/orders/:id/verify-payment", asyncH(async (req, res) => {
  res.json(await verifyOrderPayment(req.params.id, { utr: req.body?.utr }));
}));
adminRouter.post("/orders/:id/refund", asyncH(async (req, res) => {
  res.json(await refundOrder(req.params.id));
}));

adminRouter.get("/shipments", asyncH(async (req, res) => {
  const { status } = req.query;
  const params = [];
  let sql = `select s.*, o.order_no, o.enrollment_id, u.email as shipped_by_email
               from shipments s join orders o on o.id=s.order_id
               left join users u on u.id=s.shipped_by`;
  if (status) { params.push(status); sql += ` where s.status=$${params.length}`; }
  sql += ` order by s.created_at desc limit 300`;
  res.json({ shipments: (await query(sql, params)).rows });
}));

// Approve a leg -> release that leg's party's held share. Reject -> just mark.
adminRouter.patch("/shipments/:id", asyncH(async (req, res) => {
  const { status, note } = req.body || {};
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "status must be approved or rejected" });
  const s = (await query(`select * from shipments where id=$1`, [req.params.id])).rows[0];
  if (!s) return res.status(404).json({ error: "Shipment not found" });
  if (s.status === "approved") return res.status(400).json({ error: "Already approved" });

  await query(`update shipments set status=$1, note=$2, reviewed_by=$3, reviewed_at=now() where id=$4`, [status, note || null, req.user.sub, s.id]);

  if (status === "approved") {
    const userIds = s.leg === "retailer_to_customer"
      ? (await query(`select user_id from enrollments e join orders o on o.enrollment_id=e.id where o.id=$1`, [s.order_id])).rows.map((r) => r.user_id)
      : await supplierUserIds(s.order_id);
    const released = await releaseOutstanding(s.order_id, userIds);
    for (const e of released) notify({ user_id: e.user_id, type: "payout", title: `₹${Number(e.amount).toLocaleString("en-IN")} released to your wallet (shipment confirmed).` }).catch(() => {});
    return res.json({ ok: true, released });
  }
  // rejected -> notify the submitter to re-upload
  notify({ user_id: s.shipped_by, type: "system", title: `Your shipment proof was rejected${note ? `: ${note}` : ""}. Please re-upload.` }).catch(() => {});
  res.json({ ok: true });
}));

// Photos about to be purged (>= (60 - graceDays) old). Gives admin the URLs to
// download for local backup before the cron deletes them.
adminRouter.get("/shipments/purge-preview", asyncH(async (req, res) => {
  const graceDays = Number(req.query.grace) || 7;
  const cutoff = new Date(Date.now() + graceDays * 86400 * 1000);
  const { rows } = await query(
    `select s.id, s.order_id, o.order_no, s.leg, s.photos, s.purge_after
       from shipments s join orders o on o.id=s.order_id
      where s.purged=false and s.purge_after <= $1 and jsonb_array_length(s.photos) > 0
      order by s.purge_after`, [cutoff]
  );
  const files = [];
  for (const r of rows) for (const p of (r.photos || [])) if (p.url) files.push({ order_no: r.order_no, leg: r.leg, purge_after: r.purge_after, url: p.url });
  res.json({ shipments: rows.length, files });
}));

export { clientRouter as fulfilmentClientRoutes, adminRouter as fulfilmentAdminRoutes };
