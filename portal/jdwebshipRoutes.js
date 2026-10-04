// JD Web & Ship: per-store connection, order push, and the PUBLIC status webhook.
//   app.use("/portal", jdClientRoutes)
//   app.use("/jd", jdWebhookRoutes)     <- no auth; authenticated by the store's token
import { Router } from "express";
import crypto from "node:crypto";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";
import { notify } from "./notifications.js";
import {
  jdLogin, jdRegisterWebhook, pushOrderToJd, encryptCred,
  jdStatusLabel, isJdCancelled, isJdDelivered,
} from "./jdwebship.js";
import { notifyBuyerShipped, outstandingHold } from "./fulfilmentRoutes.js";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[jd]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// ============================================================ vendor
const clientRouter = Router();
clientRouter.use(requireAuth);

const ownsSite = async (siteId, userId) =>
  (await query(`select id, slug from enrollments where id=$1 and user_id=$2`, [siteId, userId])).rows[0];

// Never returns the token, the password or the webhook secret.
clientRouter.get("/hosted-sites/:id/jd", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const r = (await query(
    `select jd_email, jd_connected_at, jd_auto_push from enrollments where id=$1`, [req.params.id]
  )).rows[0] || {};
  res.json({
    connected: !!r.jd_connected_at,
    email: r.jd_email || null,
    connected_at: r.jd_connected_at || null,
    auto_push: !!r.jd_auto_push,
  });
}));

clientRouter.post("/hosted-sites/:id/jd/connect", asyncH(async (req, res) => {
  const site = await ownsSite(req.params.id, req.user.sub);
  if (!site) return res.status(404).json({ error: "Site not found" });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "JD email and password are required." });

  const host = `${site.slug}.${process.env.PLATFORM_HOST || "thekartify.com"}`;
  let acct;
  try { acct = await jdLogin(email, password, host); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  // Keep the token AND the password (encrypted) — JD's token expires and only the
  // password can mint a new one. Webhook token is per store: it is how JD's inbound
  // calls are attributed back to this storefront.
  const webhookToken = crypto.randomBytes(24).toString("hex");
  await query(
    `update enrollments set jd_email=$1, jd_password_enc=$2, jd_user_id=$3, jd_token=$4,
            jd_webhook_token=coalesce(jd_webhook_token,$5), jd_connected_at=now() where id=$6`,
    [email, encryptCred(password), acct.user_id, acct.token, webhookToken, req.params.id]
  );

  // Register the status webhook straight away; without it JD books parcels but we
  // never learn they moved. A failure here is reported, and the connection is kept
  // so the vendor can retry rather than re-typing their password.
  const store = (await query(
    `select id, slug, jd_email, jd_password_enc, jd_token, jd_webhook_token from enrollments where id=$1`, [req.params.id]
  )).rows[0];
  try {
    await jdRegisterWebhook(store);
    res.json({ connected: true, email, webhook: "registered" });
  } catch (e) {
    res.json({ connected: true, email, webhook: "failed", warning: `Connected, but JD refused the status webhook: ${e.message}` });
  }
}));

clientRouter.post("/hosted-sites/:id/jd/register-webhook", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const store = (await query(
    `select id, slug, jd_email, jd_password_enc, jd_token, jd_webhook_token from enrollments
      where id=$1 and jd_connected_at is not null`, [req.params.id]
  )).rows[0];
  if (!store) return res.status(409).json({ error: "Connect your JD account first." });
  try { await jdRegisterWebhook(store); res.json({ webhook: "registered" }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

clientRouter.delete("/hosted-sites/:id/jd/connect", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  // The webhook token stays, so updates about parcels already booked still land.
  await query(
    `update enrollments set jd_email=null, jd_password_enc=null, jd_token=null,
            jd_connected_at=null, jd_auto_push=false where id=$1`, [req.params.id]
  );
  res.json({ connected: false, auto_push: false });
}));

clientRouter.put("/hosted-sites/:id/jd/auto-push", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const on = req.body?.auto_push === true;
  const r = (await query(
    `update enrollments set jd_auto_push=$1 where id=$2 and jd_connected_at is not null returning jd_auto_push`,
    [on, req.params.id]
  )).rows[0];
  if (!r) return res.status(409).json({ error: "Connect your JD account first." });
  res.json({ auto_push: r.jd_auto_push });
}));

clientRouter.post("/hosted-sites/:id/orders/:orderId/jd-push", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const own = (await query(`select 1 from orders where id=$1 and enrollment_id=$2`, [req.params.orderId, req.params.id])).rows[0];
  if (!own) return res.status(404).json({ error: "Order not found" });
  try { res.json(await pushOrderToJd(req.params.orderId)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// ============================================================ public webhook
// JD POSTs here on every status change. Authenticated ONLY by the per-store token
// in the x-jd-webhook-token header, so everything in the body is untrusted until
// that token has matched a store AND the shipment belongs to that same store.
const webhookRouter = Router();

webhookRouter.post("/order-status", asyncH(async (req, res) => {
  const incoming = String(req.get("x-jd-webhook-token") || "").trim();
  if (!incoming) return res.status(401).json({ error: "Missing webhook token" });

  const store = (await query(
    `select id from enrollments where jd_webhook_token=$1`, [incoming]
  )).rows[0];
  if (!store) {
    console.warn("[jd webhook] unknown token");          // never log the token itself
    return res.status(401).json({ error: "Invalid webhook token" });
  }

  const b = req.body || {};
  const jdId = b.order_id != null ? String(b.order_id) : "";
  const status = String(b.status || "").trim();
  if (!jdId || !status) return res.status(400).json({ error: "order_id and status are required" });

  // The shipment must belong to the store whose token signed this call — otherwise
  // one vendor's token could drive another vendor's parcels.
  const ship = (await query(
    `select s.id, s.order_id, s.carrier_status, o.enrollment_id, o.status as order_status
       from shipments s join orders o on o.id = s.order_id
      where s.carrier_ref=$1 and s.courier='JD Web & Ship' and o.enrollment_id=$2`,
    [jdId, store.id]
  )).rows[0];
  if (!ship) return res.status(404).json({ error: "Unknown shipment for this store" });

  const t = b.trackingInfo || {};
  await query(
    `update shipments set carrier_status=$1, carrier_status_at=now(),
            courier=coalesce(nullif($2,''), courier),
            tracking_no=coalesce(nullif($3,''), tracking_no),
            tracking_url=coalesce(nullif($4,''), tracking_url)
      where id=$5`,
    [status, String(t.company || "").trim(), String(t.number || "").trim(), String(t.url || "").trim(), ship.id]
  );

  // First time this parcel has a tracking number -> the buyer's one-shot email.
  notifyBuyerShipped(ship.id).catch(() => {});

  // All of this order's JD parcels delivered -> the order is complete. Only when
  // the platform is holding nothing: completing it early would drop the order off
  // the admin's pending-shipment queue while a vendor's money is still held.
  if (isJdDelivered(status)) {
    const left = (await query(
      `select count(*)::int as n from shipments
        where order_id=$1 and courier='JD Web & Ship'
          and coalesce(lower(carrier_status),'') <> 'delivered'
          and coalesce(lower(carrier_status),'') not in ('cancel','cancelled','canceled','cancelled_at_jd')`,
      [ship.order_id]
    )).rows[0].n;
    if (left === 0 && ship.order_status !== "completed" && (await outstandingHold(ship.order_id)) === 0) {
      await query(`update orders set status='completed', updated_at=now() where id=$1`, [ship.order_id]);
    }
  }

  // JD can also cancel at their end. We do NOT cancel the store's order off the
  // back of a webhook — that would refund/cancel money on a third party's say-so.
  // The vendor is told, and decides.
  if (isJdCancelled(status)) {
    const owner = (await query(`select user_id from enrollments where id=$1`, [ship.enrollment_id])).rows[0];
    const ord = (await query(`select order_no from orders where id=$1`, [ship.order_id])).rows[0];
    if (owner) notify({
      user_id: owner.user_id, type: "system",
      title: `JD cancelled a shipment for ${ord?.order_no || "an order"}. Re-book it or cancel the order yourself.`,
    }).catch(() => {});
  }

  res.json({ success: true, jd_order_id: jdId, status, label: jdStatusLabel(status) });
}));

export { clientRouter as jdClientRoutes, webhookRouter as jdWebhookRoutes };
