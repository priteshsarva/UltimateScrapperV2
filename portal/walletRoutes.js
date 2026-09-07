// Wallet + payouts.
//   app.use("/portal", walletClientRoutes)        // vendor: wallet, payout details, request payout
//   app.use("/portal/admin", walletAdminRoutes)   // admin: payout queue, mark processing/paid/cancelled
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { getWallet, walletLedger, ledger } from "./wallet.js";
import { getPlatformConfig } from "./settings.js";
import { notify } from "./notifications.js";
import { sendMail } from "./mailer.js";
import { sendPayoutEmail } from "./orderEmails.js";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[wallet]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// In-app notification addressed to one user (platform_notifications feed).
const notifyUser = (user_id, title) => notify({ user_id, type: "payout", title }).catch((e) => console.error("[notify]", e.message));

// ============================================================ client
const clientRouter = Router();
clientRouter.use(requireAuth);

clientRouter.get("/wallet", asyncH(async (req, res) => {
  const wallet = await getWallet(req.user.sub);
  const { payout_terms_text } = await getPlatformConfig();
  const pending = (await query(`select * from payout_requests where user_id=$1 and status in ('requested','processing') order by created_at desc`, [req.user.sub])).rows;
  const history = (await query(`select * from payout_requests where user_id=$1 order by created_at desc limit 50`, [req.user.sub])).rows;

  // Ledger with the order attached, and a per-order breakdown (held vs released
  // vs paid-out) so the vendor sees exactly where each rupee came from — plus the
  // platform + gateway fee the platform kept on that order.
  const ledgerRows = (await query(
    `select l.id, l.type, l.amount, l.balance_after, l.note, l.created_at,
            o.order_no, o.status as order_status, o.total as order_total,
            o.platform_fee, o.gateway_fee
       from wallet_ledger l left join orders o on o.id = l.order_id
      where l.user_id=$1 order by l.created_at desc limit 300`, [req.user.sub]
  )).rows;
  const byOrderMap = new Map();
  for (const l of ledgerRows) {
    if (!l.order_no) continue;
    const k = l.order_no;
    const g = byOrderMap.get(k) || {
      order_no: k, order_status: l.order_status, order_total: Number(l.order_total || 0),
      platform_fee: Number(l.platform_fee || 0), gateway_fee: Number(l.gateway_fee || 0),
      held: 0, released: 0, refunded: 0, at: l.created_at,
    };
    if (l.type === "hold") g.held += Number(l.amount);
    else if (l.type === "release") g.released += Number(l.amount);
    else if (l.type === "refund") g.refunded += Number(l.amount);
    byOrderMap.set(k, g);
  }
  const by_order = [...byOrderMap.values()].map((g) => ({ ...g, outstanding: Math.max(0, g.held - g.released - g.refunded) }));

  // Lifetime totals for the summary strip.
  const paidOut = (await query(`select coalesce(sum(amount),0) v from payout_requests where user_id=$1 and status='paid'`, [req.user.sub])).rows[0].v;
  const inPayout = (await query(`select coalesce(sum(amount),0) v from payout_requests where user_id=$1 and status in ('requested','processing')`, [req.user.sub])).rows[0].v;

  res.json({ wallet, ledger: ledgerRows, by_order, terms_text: payout_terms_text, pending, payouts: history,
    totals: { paid_out: Number(paidOut), in_payout: Number(inPayout) } });
}));

clientRouter.put("/wallet/payout-details", asyncH(async (req, res) => {
  const b = req.body || {};
  await getWallet(req.user.sub);
  // Threshold is admin-controlled (global default + per-vendor), never vendor-set.
  const sets = [], params = [];
  if (b.payout_upi != null) { params.push(String(b.payout_upi).trim()); sets.push(`payout_upi=$${params.length}`); }
  if (b.payout_bank != null) { params.push(JSON.stringify(b.payout_bank)); sets.push(`payout_bank=$${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: "nothing to update" });
  params.push(req.user.sub);
  await query(`update wallets set ${sets.join(", ")}, updated_at=now() where user_id=$${params.length}`, params);
  res.json({ wallet: await getWallet(req.user.sub) });
}));

clientRouter.post("/wallet/accept-terms", asyncH(async (req, res) => {
  await getWallet(req.user.sub);
  await query(`update wallets set terms_accepted_at=now(), updated_at=now() where user_id=$1`, [req.user.sub]);
  res.json({ ok: true });
}));

// Request a payout of the current available balance. Money isn't deducted until
// an admin marks it paid (so a cancelled request restores nothing to restore).
clientRouter.post("/wallet/payout", asyncH(async (req, res) => {
  const w = await getWallet(req.user.sub);
  const { payout_terms_text } = await getPlatformConfig();
  if (payout_terms_text && payout_terms_text.trim() && !w.terms_accepted_at)
    return res.status(400).json({ error: "Please accept the payout terms first." });
  const open = (await query(`select 1 from payout_requests where user_id=$1 and status in ('requested','processing')`, [req.user.sub])).rows;
  if (open.length) return res.status(409).json({ error: "You already have a payout in progress." });
  const available = Number(w.available);
  if (available < Number(w.payout_threshold)) return res.status(400).json({ error: `You need at least ₹${w.payout_threshold} to request a payout.` });

  const method = (req.body && req.body.method) === "bank" ? "bank" : "upi";
  const destination = method === "bank"
    ? (w.payout_bank && Object.keys(w.payout_bank).length ? w.payout_bank : (req.body?.destination || {}))
    : { upi: (req.body?.upi || w.payout_upi || "").trim() };
  if (method === "upi" && !destination.upi) return res.status(400).json({ error: "Add a payout UPI ID first." });

  const r = (await query(
    `insert into payout_requests (user_id, amount, method, destination, status)
     values ($1,$2,$3,$4,'requested') returning *`,
    [req.user.sub, available, method, JSON.stringify(destination)]
  )).rows[0];
  res.json({ payout: r });
}));

// ============================================================ admin
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// Admin sets a vendor's payout threshold (per-vendor override of the global default).
adminRouter.patch("/wallets/:userId", asyncH(async (req, res) => {
  const t = Number(req.body?.payout_threshold);
  if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: "bad threshold" });
  await query(`insert into wallets (user_id, payout_threshold) values ($1,$2)
               on conflict (user_id) do update set payout_threshold=$2, updated_at=now()`, [req.params.userId, t]);
  res.json({ ok: true });
}));

// Platform money position — what the admin is holding, owes, and has earned.
adminRouter.get("/money-summary", asyncH(async (req, res) => {
  const o = (await query(
    `select coalesce(sum(total),0) collected, coalesce(sum(platform_fee),0) platform_fees,
            coalesce(sum(gateway_fee),0) gateway_fees, count(*)::int verified_orders
       from orders where payment_status='verified'`
  )).rows[0];
  const w = (await query(`select coalesce(sum(held),0) held, coalesce(sum(available),0) available from wallets`)).rows[0];
  const paidOut = (await query(`select coalesce(sum(amount),0) v from wallet_ledger where type='payout'`)).rows[0].v;
  const pendingPayouts = (await query(`select coalesce(sum(amount),0) v, count(*)::int n from payout_requests where status in ('requested','processing')`)).rows[0];
  const awaiting = (await query(`select count(*)::int n from orders where payment_status in ('unpaid','claimed')`)).rows[0].n;
  res.json({
    collected: Number(o.collected),
    platform_fees: Number(o.platform_fees),
    gateway_fees: Number(o.gateway_fees),
    platform_earnings: Number(o.platform_fees) + Number(o.gateway_fees),
    held: Number(w.held),                       // vendor money reserved (pending shipment)
    vendor_available: Number(w.available),      // vendor money owed & withdrawable
    paid_out: Number(paidOut),
    pending_payouts: Number(pendingPayouts.v),
    pending_payouts_count: pendingPayouts.n,
    verified_orders: o.verified_orders,
    awaiting_verification: awaiting,
  });
}));

// Orders whose payment still needs the admin to verify it (platform-held stores).
adminRouter.get("/payments-to-verify", asyncH(async (req, res) => {
  const rows = (await query(
    `select o.id, o.order_no, o.total, o.payment_status, o.created_at, o.buyer_name, e.payout_mode,
            coalesce(s.store_name, e.slug) as store_name
       from orders o
       join enrollments e on e.id = o.enrollment_id
       left join site_settings s on s.enrollment_id = e.id
      where o.payment_status in ('claimed','unpaid') and e.payout_mode='platform'
      order by (o.payment_status='claimed') desc, o.created_at desc limit 200`
  )).rows;
  res.json({ orders: rows });
}));

adminRouter.get("/payouts", asyncH(async (req, res) => {
  const { status } = req.query;
  const params = [];
  let sql = `select p.*, u.email as user_email, u.name as user_name, w.available as wallet_available
               from payout_requests p
               join users u on u.id = p.user_id
               left join wallets w on w.user_id = p.user_id`;
  if (status) { params.push(status); sql += ` where p.status = $${params.length}`; }
  sql += ` order by p.created_at desc limit 300`;
  res.json({ payouts: (await query(sql, params)).rows });
}));

// Move a payout through processing -> paid / cancelled. 'paid' debits the wallet
// and records a UTR; every transition notifies the vendor (in-app + email).
adminRouter.patch("/payouts/:id", asyncH(async (req, res) => {
  const { status, utr } = req.body || {};
  const p = (await query(`select * from payout_requests where id=$1`, [req.params.id])).rows[0];
  if (!p) return res.status(404).json({ error: "Payout not found" });
  if (p.status === "paid") return res.status(400).json({ error: "Already paid" });
  if (!["processing", "paid", "cancelled"].includes(status)) return res.status(400).json({ error: "bad status" });

  if (status === "paid") {
    await ledger({ user_id: p.user_id, type: "payout", amount: p.amount, note: `Payout ${utr ? "UTR " + utr : ""}`.trim() });
    await query(`update payout_requests set status='paid', utr=$2, paid_at=now(), reviewed_by=$3 where id=$1`, [p.id, utr || null, req.user.sub]);
    await notifyUser(p.user_id, `Your payout of ₹${Number(p.amount).toLocaleString("en-IN")} has been paid${utr ? ` (UTR ${utr})` : ""}.`);
  } else if (status === "processing") {
    await query(`update payout_requests set status='processing', reviewed_by=$2 where id=$1`, [p.id, req.user.sub]);
    await notifyUser(p.user_id, `Your payout of ₹${Number(p.amount).toLocaleString("en-IN")} is being processed.`);
  } else {
    await query(`update payout_requests set status='cancelled', note=$2, reviewed_by=$3 where id=$1`, [p.id, (req.body?.note || null), req.user.sub]);
    await notifyUser(p.user_id, `Your payout request of ₹${Number(p.amount).toLocaleString("en-IN")} was cancelled${req.body?.note ? `: ${req.body.note}` : ""}.`);
  }
  // email (best-effort, WooCommerce-style)
  const u = (await query(`select email from users where id=$1`, [p.user_id])).rows[0];
  sendPayoutEmail({ to: u?.email, kind: status, amount: p.amount, utr, note: req.body?.note });
  res.json({ ok: true });
}));

export { clientRouter as walletClientRoutes, adminRouter as walletAdminRoutes };
