// Per-user wallet + double-entry-ish ledger. Platform-mode order money is held
// here and released to the seller only when shipment proof is approved.
//
//   balances: available (withdrawable) + held (pending release)
//   ledger types: hold | release | payout | refund | fee | adjust
//
// Every mutation writes a wallet_ledger row with balance_after (of `available`)
// so the history reconciles. Splits (multiple entries for one order) run inside
// one transaction via withWallets().
import { pool, query } from "./db.js";

export async function getWallet(userId) {
  await query(
    `insert into wallets (user_id) values ($1) on conflict (user_id) do nothing`, [userId]
  );
  return (await query(`select * from wallets where user_id=$1`, [userId])).rows[0];
}

// Low-level: apply one ledger entry to a user's wallet using an existing client
// (so callers can batch several inside a transaction). Positive `amount` always;
// the `type` decides which balances move.
async function applyEntry(client, { user_id, type, amount, order_id = null, order_item_id = null, note = null }) {
  amount = Number(amount) || 0;
  await client.query(`insert into wallets (user_id) values ($1) on conflict (user_id) do nothing`, [user_id]);
  const w = (await client.query(`select available, held from wallets where user_id=$1 for update`, [user_id])).rows[0];
  let available = Number(w.available), held = Number(w.held);
  switch (type) {
    case "hold":    held += amount; break;                    // money reserved for a pending order
    case "release": held -= amount; available += amount; break; // proof approved -> seller can withdraw
    case "refund":  held -= amount; break;                     // order cancelled before release
    case "payout":  available -= amount; break;               // paid out to the seller
    case "fee":     available -= amount; break;
    case "adjust":  available += amount; break;               // manual correction (amount may be negative via note)
    default: throw new Error(`unknown ledger type: ${type}`);
  }
  if (held < 0) held = 0;
  await client.query(`update wallets set available=$2, held=$3, updated_at=now() where user_id=$1`, [user_id, available, held]);
  await client.query(
    `insert into wallet_ledger (user_id, order_id, order_item_id, type, amount, balance_after, note)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [user_id, order_id, order_item_id, type, amount, available, note]
  );
  return { available, held };
}

// Run a set of ledger entries atomically.
export async function withLedger(entries) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = [];
    for (const e of entries) out.push(await applyEntry(client, e));
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// One-off entry (its own transaction).
export const ledger = (entry) => withLedger([entry]).then((r) => r[0]);

export async function walletLedger(userId, limit = 100) {
  return (await query(
    `select * from wallet_ledger where user_id=$1 order by created_at desc limit $2`, [userId, limit]
  )).rows;
}
