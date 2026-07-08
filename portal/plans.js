// Plan tiers — CRUD helpers. Plans are data the admin manages; shops reference one
// and invoices are priced from it.
import { query } from "./db.js";

const FIELDS = ["name", "price", "currency", "interval", "interval_count", "description", "active", "sort_order"];

export async function listPlans({ activeOnly = false } = {}) {
  const where = activeOnly ? "where active = true" : "";
  return (await query(`select * from plans ${where} order by sort_order, price`)).rows;
}

export async function getPlan(id) {
  return (await query(`select * from plans where id = $1`, [id])).rows[0] || null;
}

export async function createPlan(p) {
  const {
    name, price,
    currency = "INR", interval = "month", interval_count = 1,
    description = null, active = true, sort_order = 0,
  } = p;
  return (await query(
    `insert into plans (name, price, currency, interval, interval_count, description, active, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning *`,
    [name, price, currency, interval, interval_count, description, active, sort_order]
  )).rows[0];
}

export async function updatePlan(id, patch) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of FIELDS) {
    if (patch[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(patch[k]); }
  }
  if (!sets.length) return getPlan(id);
  vals.push(id);
  return (await query(`update plans set ${sets.join(", ")} where id = $${i} returning *`, vals)).rows[0] || null;
}
