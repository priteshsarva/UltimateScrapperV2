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

// ---- Payment: a PROVIDER REGISTRY ----------------------------------
// Config shape in app_settings key 'payment':
//   { active: 'pay0', providers: { pay0: { label,title,description,base_url,
//                                          api_key,secret,webhook_url,enabled } } }
// Admin picks the `active` gateway and edits its fields. Secrets NEVER leave the
// server. The WordPress plugin reads only getPaymentPublic() (no keys) and asks
// the server to create pay links — so switching the gateway here needs no plugin
// update. New providers are added by extending DEFAULT_PROVIDERS + a small
// adapter in the pay routes; the storage/UI already generalise.
const DEFAULT_PROVIDERS = {
  pay0: {
    label: "Pay0 (UPI)",
    title: "UPI (Scan & Pay)",
    description: "Pay securely with any UPI app.",
    base_url: "https://pay0.shop/api",
    api_key: "",       // Pay0 "API Key" = user_token on the create-order call
    secret: "",        // Pay0 "Secret" — for webhook verification
    webhook_url: "",   // informational (shown in the admin UI)
    enabled: false,
  },
};

// Read the registry, migrating the old single-object shape and merging defaults.
async function paymentRegistry() {
  const s = await readRow("payment");
  // legacy { provider/user_token/base_url/enabled } -> registry
  if (s && !s.providers && (s.user_token || s.provider)) {
    return {
      active: "pay0",
      providers: {
        pay0: {
          ...DEFAULT_PROVIDERS.pay0,
          api_key: s.user_token || "",
          base_url: s.base_url || DEFAULT_PROVIDERS.pay0.base_url,
          enabled: s.enabled != null ? !!s.enabled : !!s.user_token,
        },
      },
    };
  }
  const providers = {};
  for (const id of Object.keys(DEFAULT_PROVIDERS)) {
    providers[id] = { ...DEFAULT_PROVIDERS[id], ...((s.providers && s.providers[id]) || {}) };
  }
  return { active: s.active || "pay0", providers };
}

// The ACTIVE provider, with env fallback for pay0.
export async function getActiveProvider() {
  const reg = await paymentRegistry();
  const id = reg.active;
  const p = reg.providers[id] || DEFAULT_PROVIDERS[id] || {};
  if (id === "pay0") {
    return {
      id,
      label: p.label, title: p.title, description: p.description, webhook_url: p.webhook_url,
      base_url: p.base_url || process.env.PAY0_BASE_URL || "https://pay0.shop/api",
      api_key: p.api_key || process.env.PAY0_USER_TOKEN || "",
      secret: p.secret || "",
      enabled: p.enabled != null ? !!p.enabled : !!(p.api_key || process.env.PAY0_USER_TOKEN),
    };
  }
  return { id, ...p };
}

// Back-compat for pay0.js (it expects user_token/base_url/enabled).
export async function getPaymentConfig() {
  const a = await getActiveProvider();
  return { provider: a.id, base_url: a.base_url, user_token: a.api_key, secret: a.secret, enabled: a.enabled };
}

// Whole registry for the admin UI, secrets masked.
export async function getPaymentRegistryMasked() {
  const reg = await paymentRegistry();
  const providers = {};
  for (const [id, p] of Object.entries(reg.providers)) {
    providers[id] = {
      ...p,
      api_key: p.api_key ? "********" : "",
      secret: p.secret ? "********" : "",
      hasKey: !!p.api_key, hasSecret: !!p.secret,
    };
  }
  return { active: reg.active, providers };
}

// Save one provider's fields (masked/blank secrets are preserved, not wiped).
export async function savePaymentProvider(id, fields) {
  const reg = await paymentRegistry();
  const cur = reg.providers[id] || DEFAULT_PROVIDERS[id] || {};
  const next = { ...cur, ...fields };
  if (!fields.api_key || fields.api_key === "********") next.api_key = cur.api_key || "";
  if (!fields.secret  || fields.secret  === "********") next.secret  = cur.secret  || "";
  reg.providers[id] = next;
  await saveSettings("payment", reg);
  return getPaymentRegistryMasked();
}

// Choose which gateway is live.
export async function setActiveProvider(id) {
  const reg = await paymentRegistry();
  if (!reg.providers[id]) throw new Error(`Unknown provider: ${id}`);
  reg.active = id;
  await saveSettings("payment", reg);
  return getPaymentRegistryMasked();
}

// ---- Platform UPI (manual collection for our OWN billing to vendors) --------
// Not a gateway — a UPI VPA vendors pay their plan invoice into, then send us
// the screenshot. We confirm the invoice by hand. Stored in app_settings key
// 'platform_upi', env fallback so it works before anything is saved.
export async function getPlatformUpi() {
  const s = await readRow("platform_upi");
  return {
    upi_id:   s.upi_id   || process.env.PLATFORM_UPI_ID       || "",
    upi_name: s.upi_name || process.env.PLATFORM_UPI_NAME     || "Server Products",
    whatsapp: s.whatsapp || process.env.PLATFORM_BILLING_WHATSAPP || "",
  };
}

export async function savePlatformUpi(fields) {
  const cur = await getPlatformUpi();
  const next = {
    upi_id:   fields.upi_id   != null ? String(fields.upi_id).trim()   : cur.upi_id,
    upi_name: fields.upi_name != null ? String(fields.upi_name).trim() : cur.upi_name,
    whatsapp: fields.whatsapp != null ? String(fields.whatsapp).trim() : cur.whatsapp,
  };
  await saveSettings("platform_upi", next);
  return next;
}

// Non-secret view for the plugin / client — NEVER includes keys. Includes the
// platform UPI so the client billing screen can offer "pay by UPI".
export async function getPaymentPublic() {
  const a = await getActiveProvider();
  const upi = await getPlatformUpi();
  return { enabled: a.enabled, provider: a.id, title: a.title, description: a.description, upi };
}
