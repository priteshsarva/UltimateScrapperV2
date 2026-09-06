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
  const ledgerRows = await walletLedger(req.user.sub, 100);
  const { payout_terms_text } = await getPlatformConfig();
  const pending = (await query(`select * from payout_requests where user_id=$1 and status in ('requested','processing') order by created_at desc`, [req.user.sub])).rows;
  const history = (await query(`select * from payout_requests where user_id=$1 order by created_at desc limit 50`, [req.user.sub])).rows;
  res.json({ wallet, ledger: ledgerRows, terms_text: payout_terms_text, pending, payouts: history });
}));

clientRouter.put("/wallet/payout-details", asyncH(async (req, res) => {
  const b = req.body || {};
  await getWallet(req.user.sub);
  const sets = [], params = [];
  if (b.payout_upi != null) { params.push(String(b.payout_upi).trim()); sets.push(`payout_upi=$${params.length}`); }
  if (b.payout_bank != null) { params.push(JSON.stringify(b.payout_bank)); sets.push(`payout_bank=$${params.length}`); }
  if (b.payout_threshold != null) { params.push(Number(b.payout_threshold) || 0); sets.push(`payout_threshold=$${params.length}`); }
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
  if (!w.terms_accepted_at) return res.status(400).json({ error: "Please accept the payout terms first." });
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
  // email (best-effort)
  const u = (await query(`select email, name from users where id=$1`, [p.user_id])).rows[0];
  if (u?.email) sendMail({ to: u.email, subject: `Payout ${status}`,
    html: `<p>Hi ${u.name || ""}, your payout of ₹${Number(p.amount).toLocaleString("en-IN")} is now <b>${status}</b>${status === "paid" && utr ? ` (UTR ${utr})` : ""}.</p>` }).catch(() => {});
  res.json({ ok: true });
}));

export { clientRouter as walletClientRoutes, adminRouter as walletAdminRoutes };
