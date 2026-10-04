// Selloship connection + order push, per store.
//   app.use("/portal", selloshipClientRoutes)
//
// The vendor types their Selloship email + password ONCE here; we exchange it for
// their vendor_id and drop the password (selloship.js explains why that is enough).
// Booking is explicit — a button, not a side effect of payment verification — so a
// bad address can't silently book fifty wrong parcels. Auto-push can come later.
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";
import { selloshipLogin, pushOrderToSelloship } from "./selloship.js";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[selloship]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

const clientRouter = Router();
clientRouter.use(requireAuth);

const ownsSite = async (siteId, userId) =>
  (await query(`select id, slug from enrollments where id=$1 and user_id=$2`, [siteId, userId])).rows[0];

// What the portal shows on the store's fulfilment tab. Never returns vendor_id —
// that value plus the email IS the API credential.
clientRouter.get("/hosted-sites/:id/selloship", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const r = (await query(
    `select selloship_email, selloship_store_name, selloship_flags, selloship_connected_at, selloship_auto_push
       from enrollments where id=$1`, [req.params.id]
  )).rows[0] || {};
  res.json({
    connected: !!r.selloship_connected_at,
    email: r.selloship_email || null,
    store_name: r.selloship_store_name || null,
    flags: r.selloship_flags || null,
    connected_at: r.selloship_connected_at || null,
    auto_push: !!r.selloship_auto_push,
  });
}));

// Automatic (book the moment a payment is verified) vs manual (the button on the
// order). Manual always works; this only decides whether we also do it for them.
clientRouter.put("/hosted-sites/:id/selloship/auto-push", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const on = req.body?.auto_push === true;
  const r = (await query(
    `update enrollments set selloship_auto_push=$1 where id=$2 and selloship_vendor_id is not null
     returning selloship_auto_push`, [on, req.params.id]
  )).rows[0];
  if (!r) return res.status(409).json({ error: "Connect your Selloship account first." });
  res.json({ auto_push: r.selloship_auto_push });
}));

clientRouter.post("/hosted-sites/:id/selloship/connect", asyncH(async (req, res) => {
  const site = await ownsSite(req.params.id, req.user.sub);
  if (!site) return res.status(404).json({ error: "Site not found" });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Selloship email and password are required." });

  // Throws with Selloship's own message on bad credentials — shown to the vendor.
  const acct = await selloshipLogin(email, password, `https://${site.slug}.thekartify.com`);

  await query(
    `update enrollments set selloship_vendor_id=$1, selloship_email=$2, selloship_store_name=$3,
            selloship_flags=$4, selloship_connected_at=now() where id=$5`,
    [acct.vendor_id, acct.email, acct.store_name, JSON.stringify(acct.flags), req.params.id]
  );
  // The password is NOT persisted — it went no further than this request.
  res.json({ connected: true, store_name: acct.store_name, email: acct.email, flags: acct.flags });
}));

clientRouter.delete("/hosted-sites/:id/selloship/connect", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  await query(
    `update enrollments set selloship_vendor_id=null, selloship_email=null, selloship_store_name=null,
            selloship_flags=null, selloship_connected_at=null, selloship_auto_push=false where id=$1`, [req.params.id]
  );
  res.json({ connected: false, auto_push: false });
}));

// Book an order's parcels with Selloship. Safe to call twice — parcels already
// booked are skipped, not duplicated.
clientRouter.post("/hosted-sites/:id/orders/:orderId/selloship-push", asyncH(async (req, res) => {
  if (!(await ownsSite(req.params.id, req.user.sub))) return res.status(404).json({ error: "Site not found" });
  const own = (await query(`select 1 from orders where id=$1 and enrollment_id=$2`, [req.params.orderId, req.params.id])).rows[0];
  if (!own) return res.status(404).json({ error: "Order not found" });
  try {
    res.json(await pushOrderToSelloship(req.params.orderId));
  } catch (e) {
    // Vendor-facing failures (not connected / unverified payment / Selloship said
    // no) are 400s with their text, not 500s.
    res.status(400).json({ error: e.message });
  }
}));

export { clientRouter as selloshipClientRoutes };
