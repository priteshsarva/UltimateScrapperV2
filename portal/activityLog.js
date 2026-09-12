// Central activity logging — fire-and-forget, never throws into the caller.
// Search/click recording lives here now; login-attempt + email logging (the rest
// of the logs epic) will hang off the same module.
import { query } from "./db.js";

// Record a catalogue search or product-open. Pass a plain object; unknown fields
// are ignored. Attribution: user_id when signed in, else device_id.
export function logCatalogue(row = {}) {
  const {
    event, scope = null, user_id = null, device_id = null,
    q = null, category = null, filters = null, results_count = null,
    product_id = null, product_name = null, source_name = null,
  } = row;
  if (!event) return;
  query(
    `insert into catalogue_activity
       (event, scope, user_id, device_id, q, category, filters, results_count, product_id, product_name, source_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [event, scope, user_id, device_id, q, category, filters ? JSON.stringify(filters) : null,
     results_count, product_id, product_name, source_name]
  ).catch((e) => console.error("[activityLog]", e.message));
}

// Record a login attempt (password or OTP), success or failure.
export function logLoginAttempt({ identifier = null, method = null, user_id = null, success = false, reason = null, ip = null } = {}) {
  query(
    `insert into login_attempts (identifier, method, user_id, success, reason, ip) values ($1,$2,$3,$4,$5,$6)`,
    [identifier, method, user_id, !!success, reason, ip ? String(ip).slice(0, 60) : null]
  ).catch((e) => console.error("[activityLog:login]", e.message));
}

// Record an email send (fired from mailer.sendMail for every email).
export function logEmail({ to_email = null, to_name = null, to_mobile = null, subject = null, reason = null, success = false, error = null } = {}) {
  query(
    `insert into email_log (to_email, to_name, to_mobile, subject, reason, success, error) values ($1,$2,$3,$4,$5,$6,$7)`,
    [to_email, to_name, to_mobile, subject, reason, !!success, error]
  ).catch((e) => console.error("[activityLog:email]", e.message));
}
