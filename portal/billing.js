// Billing core: generate an invoice for a shop (priced from its plan), and
// mark an invoice paid (which activates/extends the shop). Both are idempotent-safe.
import { query } from "./db.js";
import { getPlan } from "./plans.js";

function addInterval(date, interval, count) {
  const d = new Date(date);
  if (interval === "year") d.setFullYear(d.getFullYear() + (count || 1));
  else d.setMonth(d.getMonth() + (count || 1));
  return d;
}

/**
 * Create an invoice for a shop for one billing period, priced from its plan.
 * periodStart defaults to the shop's current expiry (renewal) or now (first bill).
 * Returns the invoice, or null if the shop has no plan. Safe against duplicates
 * (unique index on enrollment_id + period_start).
 */
export async function generateInvoiceForEnrollment(enrollmentId, { periodStart } = {}) {
  const enr = (await query(`select * from enrollments where id=$1`, [enrollmentId])).rows[0];
  if (!enr || !enr.plan_id) return null;
  const plan = await getPlan(enr.plan_id);
  if (!plan) return null;

  const start = periodStart ? new Date(periodStart)
    : (enr.expiry_date ? new Date(enr.expiry_date) : new Date());
  const end = addInterval(start, plan.interval, plan.interval_count);
  const due = start; // due at the start of the period it pays for

  try {
    const seq = (await query(`select nextval('invoice_no_seq') as n`)).rows[0].n;
    const { rows } = await query(
      `insert into invoices
         (user_id, enrollment_id, plan_id, item, amount, currency, status,
          period_start, period_end, due_date, invoice_no, gateway)
       values ($1,$2,$3,$4,$5,$6,'created',$7,$8,$9,$10,'pay0')
       returning *`,
      [enr.user_id, enr.id, plan.id, `${plan.name} — ${enr.domain}`,
       plan.price, plan.currency, start, end, due, `INV-${seq}`]
    );
    return rows[0];
  } catch (e) {
    if (e.code === "23505") { // invoice already exists for this shop+period
      return (await query(
        `select * from invoices where enrollment_id=$1 and period_start=$2`,
        [enr.id, start]
      )).rows[0] || null;
    }
    throw e;
  }
}

/**
 * Mark an invoice paid and activate/extend its shop to the invoice's period_end.
 * Idempotent: re-calling on an already-paid invoice is a no-op.
 */
export async function markInvoicePaid(invoiceId, utr) {
  const inv = (await query(`select * from invoices where id=$1`, [invoiceId])).rows[0];
  if (!inv) return null;
  if (inv.status === "paid") return inv;

  await query(
    `update invoices set status='paid', paid_at=now(), utr=coalesce($2, utr) where id=$1`,
    [invoiceId, utr || null]
  );

  if (inv.enrollment_id) {
    await query(
      `update enrollments
          set status='active', expiry_date=$2, renewal_date=$2
        where id=$1`,
      [inv.enrollment_id, inv.period_end]
    );
  }
  return (await query(`select * from invoices where id=$1`, [invoiceId])).rows[0];
}
