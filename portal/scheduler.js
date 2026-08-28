// Daily billing job. Idempotent — safe to run repeatedly.
//   - issues renewal invoices for active shops nearing expiry
//   - emails a reminder for each unpaid invoice, once per day, until its due date
//   - expires shops whose invoice passed the due date unpaid (plugin then removes
//     their products after the 3-day grace, via the existing expiry flow)
import { query } from "./db.js";
import { generateInvoiceForEnrollment } from "./billing.js";
import { sendReminderEmail, sendMail } from "./mailer.js";
import { notify } from "./notifications.js";

// Hosted storefronts get a 5-day grace after their plan expires: the store stays
// live, but the owner is emailed (up to 3×/day) and gets an in-portal notification.
// Unpaid past the grace window → the store auto-pauses (resolveStore 404s it).
const HOSTED_GRACE_DAYS = 5;

export async function hostedExpiryTick() {
  const overdue = (await query(
    `select e.id, e.slug, e.expiry_date, e.last_reminder_at, u.id as user_id, u.email, u.name,
            (e.expiry_date + interval '${HOSTED_GRACE_DAYS} days') as pause_at
       from enrollments e join users u on u.id = e.user_id
      where e.type = 'hosted' and e.status = 'active'
        and e.expiry_date is not null and e.expiry_date < now()`
  )).rows;

  let reminders = 0, paused = 0, notified = 0;
  for (const s of overdue) {
    const graceEnds = new Date(s.pause_at);
    // past the grace window → pause the store
    if (graceEnds < new Date()) {
      await query(`update enrollments set status='paused' where id=$1`, [s.id]);
      await notify({ user_id: s.user_id, type: "store_paused", title: `"${s.slug}" has been paused`,
        body: `Your storefront was paused after ${HOSTED_GRACE_DAYS} days unpaid past expiry. Renew to bring it back online.` });
      try {
        await sendMail({ to: s.email, subject: `Your storefront ${s.slug} has been paused`,
          text: `Hi ${s.name || ""},\n\nYour storefront "${s.slug}" was paused because the renewal wasn't paid within ${HOSTED_GRACE_DAYS} days of expiry. Renew from your portal to bring it back online.` });
      } catch (e) { console.error("[hosted] pause email:", e.message); }
      paused++;
      continue;
    }

    // in grace → email at most once every 3h (cron runs 3×/day → ~3 emails/day)
    const last = s.last_reminder_at ? new Date(s.last_reminder_at).getTime() : 0;
    if (Date.now() - last >= 3 * 3600 * 1000) {
      try {
        await sendMail({ to: s.email, subject: `Action needed — renew ${s.slug} to keep it live`,
          text: `Hi ${s.name || ""},\n\nYour plan for "${s.slug}" has expired. The store stays live until ${graceEnds.toDateString()}, after which it will pause automatically. Renew now from your portal to avoid interruption.` });
        await query(`update enrollments set last_reminder_at=now() where id=$1`, [s.id]);
        reminders++;
      } catch (e) { console.error("[hosted] reminder email:", e.message); }
    }

    // one in-portal notification per day
    const dup = (await query(
      `select 1 from platform_notifications where user_id=$1 and type='store_expiring' and created_at >= date_trunc('day', now()) limit 1`,
      [s.user_id]
    )).rows[0];
    if (!dup) {
      await notify({ user_id: s.user_id, type: "store_expiring", title: `"${s.slug}" needs renewal`,
        body: `Your plan expired. Renew before ${graceEnds.toDateString()} or the store will pause.` });
      notified++;
    }
  }
  return { reminders, paused, notified };
}

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
      // hosted expiry: 3×/day so grace reminders go out ~3 times daily
      cron.default.schedule("0 8,14,20 * * *", () => {
        hostedExpiryTick().then((r) => console.log("[hosted] expiry tick", r)).catch((e) => console.error("[hosted] expiry tick:", e.message));
      });
      console.log("[billing] daily scheduler armed for 08:00; hosted expiry at 08/14/20");
    })
    .catch(() => console.warn("[billing] node-cron not installed — trigger billingTick via the admin endpoint or system cron"));
}
