// Admin-editable config (SMTP + payment gateway), stored in app_settings.
//
// DESIGN
//   Config lives in the app_settings table (key 'smtp' | 'payment', value JSON)
//   so an admin can edit it from the portal. Every value falls back to the
//   corresponding .env var, so the app keeps working before the migration runs
//   and before anything is saved in the UI. DB overrides env when present.
//
//   Reads are cached for a few seconds and the cache is dropped on write, so
//   pay0.js / mailer.js can call these on every request cheaply and still pick
//   up an admin change within seconds.
import { query } from "./db.js";

const TTL_MS = 5000;
const cache = new Map(); // key -> { at, value }

async function readRow(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = {};
  try {
    const row = (await query(`select value from app_settings where key=$1`, [key])).rows[0];
    value = (row && row.value) || {};
  } catch {
    // app_settings may not exist yet (pre-migration) — fall back to env
    value = {};
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function saveSettings(key, value) {
  await query(
    `insert into app_settings (key, value, updated_at)
     values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value]
  );
  cache.delete(key);
  return value;
}

// ---- SMTP -----------------------------------------------------------
export async function getSmtpConfig() {
  const s = await readRow("smtp");
  return {
    host:   s.host   || process.env.SMTP_HOST || "",
    port:   parseInt(s.port || process.env.SMTP_PORT || "587", 10),
    secure: s.secure != null ? !!s.secure : process.env.SMTP_SECURE === "true",
    user:   s.user   || process.env.SMTP_USER || "",
    pass:   s.pass   || process.env.SMTP_PASS || "",
    from:   s.from   || process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@localhost",
  };
}

// what the admin UI shows — password masked, never sent raw to the browser
export async function getSmtpConfigMasked() {
  const c = await getSmtpConfig();
  return { ...c, pass: c.pass ? "********" : "", hasPass: !!c.pass };
}

// ---- Payment (Pay0) -------------------------------------------------
export async function getPaymentConfig() {
  const s = await readRow("payment");
  return {
    provider:   s.provider   || "pay0",
    base_url:   s.base_url   || process.env.PAY0_BASE_URL || "https://pay0.shop/api",
    user_token: s.user_token || process.env.PAY0_USER_TOKEN || "",
    // online payment is "on" once a token exists, unless explicitly disabled
    enabled:    s.enabled != null ? !!s.enabled : !!(s.user_token || process.env.PAY0_USER_TOKEN),
  };
}

export async function getPaymentConfigMasked() {
  const c = await getPaymentConfig();
  return { ...c, user_token: c.user_token ? "********" : "", hasToken: !!c.user_token };
}

// Non-secret view for the plugin / client: is online payment available, and via
// what provider. NEVER includes the token.
export async function getPaymentPublic() {
  const c = await getPaymentConfig();
  return { enabled: c.enabled, provider: c.provider };
}
