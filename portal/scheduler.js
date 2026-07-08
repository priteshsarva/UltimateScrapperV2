// Daily billing job. Idempotent — safe to run repeatedly.
//   - issues renewal invoices for active shops nearing expiry
//   - emails a reminder for each unpaid invoice, once per day, until its due date
//   - expires shops whose invoice passed the due date unpaid (plugin then removes
//     their products after the 3-day grace, via the existing expiry flow)
import { query } from "./db.js";
import { generateInvoiceForEnrollment } from "./billing.js";
import { sendReminderEmail } from "./mailer.js";

export async function billingTick() {
  // 1) renewal invoices: active shops within 7 days of expiry
  const soon = (await query(
    `select id, expiry_date from enrollments
      where status='active' and plan_id is not null and expiry_date is not null
        and expiry_date <= now() + interval '7 days'`
  )).rows;
  let renewals = 0;
  for (const enr of soon) {
    try { if (await generateInvoiceForEnrollment(enr.id, { periodStart: enr.expiry_date })) renewals++; }
    catch (e) { console.error("[billing] renewal invoice:", e.message); }
  }

  // 2) daily reminders for unpaid invoices, up to the due date
  const unpaid = (await query(
    `select i.*, e.domain, u.email, u.name
       from invoices i
       join enrollments e on e.id = i.enrollment_id
       join users u on u.id = i.user_id
      where i.status in ('created','pending')
        and i.due_date >= now()
        and (i.last_reminder_at is null or i.last_reminder_at < date_trunc('day', now()))`
  )).rows;
  let reminders = 0;
  for (const inv of unpaid) {
    try {
      await sendReminderEmail({ email: inv.email, name: inv.name }, { domain: inv.domain }, inv);
      await query(`update invoices set last_reminder_at=now() where id=$1`, [inv.id]);
      reminders++;
    } catch (e) { console.error("[billing] reminder:", e.message); }
  }

  // 3) expire shops whose invoice passed the due date unpaid
  const expired = await query(
    `update enrollments set status='expired'
      where status in ('approved','active')
        and id in (
          select enrollment_id from invoices
           where status in ('created','pending') and due_date < now() and enrollment_id is not null
        )
      returning id`
  );

  return { renewals, reminders, expired: expired.rowCount };
}

// Arm a daily run via node-cron if it's installed (npm install node-cron).
// If not installed, call billingTick() from an external cron hitting
// POST /portal/admin/shops/run-billing-tick instead.
export function startScheduler() {
  import("node-cron")
    .then((cron) => {
      cron.default.schedule("0 8 * * *", () => {
        billingTick().then((r) => console.log("[billing] tick", r)).catch((e) => console.error("[billing] tick:", e.message));
      });
      console.log("[billing] daily scheduler armed for 08:00");
    })
    .catch(() => console.warn("[billing] node-cron not installed — trigger billingTick via the admin endpoint or system cron"));
}
