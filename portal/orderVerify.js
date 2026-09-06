// Confirm a storefront order's payment. This is the money-in split:
//   - decrement wholesale stock (reserve-on-verify, per the design)
//   - for platform-held (payout_mode='platform') orders, HOLD each party's share
//     in their wallet: wholesaler gets their wholesale cost, the retailer gets the
//     remaining margin, the platform keeps its fee + gateway fee.
//   - mark the order verified + confirmed and freeze the split amounts on it.
// Shipment-photo approval later RELEASES the held amounts (see shipmentRoutes).
import { pool, query } from "./db.js";
import { getPlatformConfig } from "./settings.js";
import { withLedger } from "./wallet.js";
import { wholesaleDb, wsRun, wsGet } from "./wholesaleDb.js";

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function verifyOrderPayment(orderId, { utr = null } = {}) {
  const order = (await query(`select * from orders where id=$1`, [orderId])).rows[0];
  if (!order) throw new Error("Order not found");
  if (order.payment_status === "verified") return { ok: true, already: true };

  const items = (await query(`select * from order_items where order_id=$1`, [orderId])).rows;
  const store = (await query(`select id, user_id, payout_mode, gateway_fee_pct from enrollments where id=$1`, [order.enrollment_id])).rows[0];
  const cfg = await getPlatformConfig();
  const total = Number(order.total);

  // 1. decrement wholesale stock
  const db = await wholesaleDb();
  for (const it of items) {
    if (it.db_name !== "wholesale") continue;
    const row = await wsGet(db, `SELECT stockQty, listingStatus FROM PRODUCTS WHERE productId=?`, [it.product_id]);
    if (!row || row.stockQty == null) continue; // unlimited stock
    const next = Math.max(0, Number(row.stockQty) - Number(it.qty));
    const avail = row.listingStatus === "active" && next > 0 ? 1 : 0;
    await wsRun(db, `UPDATE PRODUCTS SET stockQty=?, availability=?, productLastUpdated=? WHERE productId=?`, [next, avail, new Date().toISOString(), it.product_id]);
  }

  // 2. compute the split
  const perSupplier = new Map(); // supplier_enrollment_id -> wholesale cost total
  for (const it of items) {
    if (it.db_name === "wholesale" && it.supplier_enrollment_id && it.cost_price != null) {
      const amt = round2(Number(it.cost_price) * Number(it.qty));
      perSupplier.set(it.supplier_enrollment_id, round2((perSupplier.get(it.supplier_enrollment_id) || 0) + amt));
    }
  }
  const wholesalerTotal = round2([...perSupplier.values()].reduce((s, v) => s + v, 0));
  const platformFee = round2(total * (Number(cfg.fee_pct) || 0) / 100);
  const gatewayPct = store.gateway_fee_pct != null ? Number(store.gateway_fee_pct) : Number(cfg.gateway_fee_pct) || 0;
  const gatewayFee = round2(total * gatewayPct / 100);
  const retailerShare = round2(total - wholesalerTotal - platformFee - gatewayFee);

  // 3. platform-held orders: hold each party's share in their wallet
  if (store.payout_mode === "platform") {
    const entries = [];
    // resolve supplier enrollment -> user_id
    for (const [supEnr, amount] of perSupplier) {
      const sup = (await query(`select user_id from enrollments where id=$1`, [supEnr])).rows[0];
      if (sup && amount > 0) entries.push({ user_id: sup.user_id, type: "hold", amount, order_id: orderId, note: "Wholesale share (pending shipment)" });
    }
    if (store.user_id && retailerShare > 0) entries.push({ user_id: store.user_id, type: "hold", amount: retailerShare, order_id: orderId, note: "Sale margin (pending shipment)" });
    if (entries.length) await withLedger(entries);
  }

  // 4. mark verified + confirmed, freeze the split
  await query(
    `update orders set payment_status='verified', payment_utr=coalesce($2, payment_utr), status='confirmed',
       share_wholesaler=$3, share_retailer=$4, platform_fee=$5, gateway_fee=$6, updated_at=now()
     where id=$1`,
    [orderId, utr, wholesalerTotal, retailerShare, platformFee, gatewayFee]
  );
  return { ok: true, split: { wholesalerTotal, retailerShare, platformFee, gatewayFee, held: store.payout_mode === "platform" } };
}

// Refund/cancel a verified order: release holds back out (refund) and (optionally)
// restore stock. Used when an admin cancels after verification.
export async function refundOrder(orderId) {
  const order = (await query(`select * from orders where id=$1`, [orderId])).rows[0];
  if (!order || order.payment_status !== "verified") return { ok: false };
  const holds = (await query(`select user_id, sum(amount) amt from wallet_ledger where order_id=$1 and type='hold' group by user_id`, [orderId])).rows;
  const released = (await query(`select user_id, sum(amount) amt from wallet_ledger where order_id=$1 and type in ('release','refund') group by user_id`, [orderId])).rows;
  const relMap = new Map(released.map((r) => [r.user_id, Number(r.amt)]));
  const entries = [];
  for (const h of holds) {
    const outstanding = round2(Number(h.amt) - (relMap.get(h.user_id) || 0));
    if (outstanding > 0) entries.push({ user_id: h.user_id, type: "refund", amount: outstanding, order_id: orderId, note: "Order cancelled" });
  }
  if (entries.length) await withLedger(entries);
  await query(`update orders set payment_status='refunded', status='cancelled', updated_at=now() where id=$1`, [orderId]);
  return { ok: true };
}
