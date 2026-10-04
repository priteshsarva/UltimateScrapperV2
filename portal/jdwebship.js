// JD Web & Ship fulfilment client — push a storefront order out as shipments and
// take delivery status back in over a webhook. Per store (see jdwebship.sql).
//
// Shape, read off their WooCommerce plugin 1.3.4:
//   POST woocommerce/login            {email,password,device_token,mywoocommerce_domain}
//                                     -> data.token, data.user.id
//   POST woocommerce/register-webhook (Bearer) {store_host,webhook_url,webhook_token,platform}
//   POST woocommerce/place-order      (Bearer) {meta:{...}, orders:[{...,items:[...]}]}
//                                     -> data.orders -> one row PER ITEM with a jd_order_id
//   POST woocommerce/cancel-order     (Bearer) {woocommerce_order_id,status:'cancel',reason}
//   <- webhook  {order_id, woocommerce_order_id, status, trackingInfo:{company,number,url}}
//
// Two things JD does better than Selloship, and we take both: it books one shipment
// per line item (so does our shipments table), and it PUSHES status changes, so
// there is no polling and the buyer sees "out for delivery", not just an AWB.
//
// Self-check: node portal/jdwebship.js
import crypto from "node:crypto";
import { query } from "./db.js";

const BASE = (process.env.JD_API_BASE || "https://zlfarwpweupu.jdwebnship.in/api").replace(/\/+$/, "");
const PLATFORM = "woocommerce";          // their API keys everything off this
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------- credentials

// The vendor's JD password at rest. Key derived from JWT_SECRET so there is no new
// env var to forget on deploy — but that means no JWT_SECRET, no JD connection.
function credKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set — refusing to store a JD password.");
  return crypto.scryptSync(secret, "jd-web-and-ship-cred", 32);
}
export function encryptCred(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", credKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [iv.toString("base64"), c.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}
export function decryptCred(stored) {
  const [iv, tag, data] = String(stored).split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", credKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------- transport

async function call(path, { token = null, json = null, form = null } = {}) {
  const r = await fetch(`${BASE}/${String(path).replace(/^\/+/, "")}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: json ? JSON.stringify(json) : new URLSearchParams(form || {}),
  });
  const raw = await r.text();
  let body = null;
  try { body = JSON.parse(raw); } catch { /* keep raw for the error path */ }
  return { http: r.status, body, raw };
}

// Their plugin treats these as "the token died, get another one".
const isAuthError = (http, body) =>
  http === 401 || http === 403 ||
  /unauthenticated|token expired|invalid token|token_invalid|unauthorized/i.test(
    String(body?.message || body?.error || "")
  );

export async function jdLogin(email, password, storeHost) {
  const { http, body, raw } = await call("woocommerce/login", {
    form: {
      email, password,
      device_token: `woocommerce_${Math.floor(Date.now() / 1000)}`,
      mywoocommerce_domain: storeHost,
    },
  });
  const token = body?.data?.token;
  if (!token) throw new Error(body?.message || body?.error || `JD login failed (HTTP ${http}) ${raw.slice(0, 200)}`);
  return { token, user_id: String(body.data.user?.id ?? body.data.user?.retailer_id ?? "") };
}

// A store's live Bearer token: cached in the row, re-minted from the stored
// password when JD rejects it.
async function tokenFor(store, { force = false } = {}) {
  if (!force && store.jd_token) return store.jd_token;
  if (!store.jd_password_enc) throw new Error("This store's JD connection needs to be re-entered.");
  const { token, user_id } = await jdLogin(store.jd_email, decryptCred(store.jd_password_enc), hostFor(store));
  // A different retailer id means the vendor pointed us at another JD account.
  if (store.jd_user_id && user_id && user_id !== store.jd_user_id) {
    throw new Error("These JD credentials belong to a different JD account. Disconnect first, then reconnect.");
  }
  await query(`update enrollments set jd_token=$1, jd_user_id=coalesce(jd_user_id,$2) where id=$3`, [token, user_id, store.id]);
  store.jd_token = token;
  return token;
}

// One retry on an auth error, exactly like their plugin — but bounded, unlike
// their plugin, whose retry recurses on an undefined $is_retry variable.
async function authed(store, path, payload) {
  let token = await tokenFor(store);
  let r = await call(path, { token, json: payload });
  if (isAuthError(r.http, r.body)) {
    token = await tokenFor(store, { force: true });
    r = await call(path, { token, json: payload });
  }
  return r;
}

const hostFor = (store) => store.jd_store_host || `${store.slug}.${process.env.PLATFORM_HOST || "thekartify.com"}`;
const webhookUrl = () => {
  const base = (process.env.SERVER_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("SERVER_PUBLIC_URL is not set — JD has nowhere to send status updates.");
  return `${base}/jd/order-status`;
};

export async function jdRegisterWebhook(store) {
  const r = await authed(store, "woocommerce/register-webhook", {
    store_host: hostFor(store),
    webhook_url: webhookUrl(),
    webhook_token: store.jd_webhook_token,
    platform: PLATFORM,
  });
  if (r.http !== 200 || !r.body?.success) {
    throw new Error(r.body?.message || `JD rejected the webhook registration (HTTP ${r.http})`);
  }
  return true;
}

// ---------------------------------------------------------------- pure payload

// JD's statuses, in the order a parcel passes through them, mapped to words a
// buyer understands. Unknown values pass through as-is rather than being hidden.
export const JD_STATUS_LABEL = {
  pending: "Pending", success: "Shipment created",
  approved_by_retailer: "Approved", transfered_retailer_to_wholesaler: "Sent to supplier",
  approved_by_wholesaler: "Approved by supplier",
  pickup: "Pickup scheduled", pickup_initiated: "Pickup initiated",
  in_transit: "In transit", ofd: "Out for delivery", delivered: "Delivered",
  ndr: "Delivery attempted", rto: "Returning to sender", rtn_to_seller: "Returned to seller",
  lost: "Shipment lost", close: "Closed",
  cancel: "Cancelled", cancelled: "Cancelled", canceled: "Cancelled", cancelled_at_jd: "Cancelled",
};
export const jdStatusLabel = (s) => JD_STATUS_LABEL[String(s || "").toLowerCase()] || s || "";
export const JD_CANCELLED = ["cancel", "cancelled", "canceled", "cancelled_at_jd"];
export const isJdCancelled = (s) => JD_CANCELLED.includes(String(s || "").toLowerCase());
export const isJdDelivered = (s) => String(s || "").toLowerCase() === "delivered";

const nameParts = (full = "") => {
  const p = String(full).trim().split(/\s+/);
  return { first: p[0] || "", last: p.slice(1).join(" ") || p[0] || "" };
};
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// The whole place-order body. One `orders` entry for this order; JD splits it into
// one shipment per item and answers with a jd_order_id for each.
//
// Money note: JD's items carry subtotal/total for the DECLARED value, and
// is_prepaid/payment_method tell it what to collect — unlike Selloship there is no
// per-item price to scale, so semi-COD rides on `cod_due` at the order level.
export function buildJdPayload(order, items, store) {
  const a = order.address || {};
  const { first, last } = nameParts(order.buyer_name || a.name);
  const cod = order.payment_method === "cod" || order.payment_method === "semicod";
  // Their plugin converts a WC state CODE to the full name; our addresses already
  // hold the name the buyer typed, so it goes straight through.
  const addr = {
    address_1: a.line1 || "",
    address_2: a.line2 || "",
    city: a.city || "",
    state: a.state || "",
    postcode: a.pincode || "",
    country: "india",
  };
  return {
    meta: {
      store_host: hostFor(store),
      webhook_url: webhookUrl(),
      platform: PLATFORM,
      store_logo: store.logo_url || "",
    },
    orders: [{
      order_id: order.order_no,            // our reference; JD echoes it back as wc_order_id
      order_number: order.order_no,
      status: "processing",
      is_prepaid: !cod,
      payment_method: cod ? "cod" : (order.payment_method || "prepaid"),
      cod_amount: cod ? round2(order.cod_due) : 0,
      customer: { first_name: first, last_name: last, email: order.buyer_email || "", phone: order.buyer_phone || a.phone || "" },
      billing_address: addr,
      shipping_address: addr,
      items: items.map((it) => {
        const sp = typeof it.snapshot === "string" ? safeJson(it.snapshot) : (it.snapshot || {});
        return {
          product_id: it.product_id,
          product_sku: sp.sku || it.product_id,
          jd_product_id: "",                // we are not reselling JD's own catalogue
          jd_variation_product_id: "",
          wc_product_id: it.product_id,
          wc_item_id: it.id,
          jd_order_id: "",                  // blank = create; set = resync (not used yet)
          name: it.product_name + (it.size ? ` [${it.size}]` : ""),
          quantity: it.qty,
          subtotal: round2(it.line_total),
          total: round2(it.line_total),
          product_image: it.image_url || sp.thumbnail || "",
        };
      }),
      shipping_total: 0,
      discount_total: round2(order.prepaid_discount),
      total: round2(order.total),
    }],
  };
}

// Their response nests per-item rows under a key per order. Flatten to rows.
export function flattenJdOrders(data) {
  const out = [];
  for (const rows of Object.values(data?.orders || {})) {
    if (!Array.isArray(rows)) continue;
    for (const r of rows) if (r && typeof r === "object") out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- order push

const connectedStore = async (enrollmentId) => (await query(
  `select e.id, e.slug, e.jd_email, e.jd_password_enc, e.jd_user_id, e.jd_token, e.jd_webhook_token,
          s.logo_url
     from enrollments e left join site_settings s on s.enrollment_id = e.id
    where e.id=$1 and e.jd_connected_at is not null`, [enrollmentId]
)).rows[0];

// Book an order with JD. One shipments row per item JD accepts, carrying the
// jd_order_id in carrier_ref so the webhook can find it again.
// Status stays 'submitted': a booking proves the parcel left, it does NOT authorise
// releasing platform-held money — the admin still does that, now with an AWB.
export async function pushOrderToJd(orderId) {
  const order = (await query(`select * from orders where id=$1`, [orderId])).rows[0];
  if (!order) throw new Error("Order not found");
  if (order.payment_status !== "verified") throw new Error("Verify the payment before booking the shipment.");

  const store = await connectedStore(order.enrollment_id);
  if (!store) throw new Error("This store isn't connected to JD Web & Ship yet.");

  const items = (await query(`select * from order_items where order_id=$1 order by id`, [orderId])).rows;
  if (!items.length) throw new Error("Order has no items.");

  const booked = new Set((await query(
    `select carrier_parcel from shipments where order_id=$1 and courier='JD Web & Ship' and carrier_parcel is not null`,
    [orderId]
  )).rows.map((r) => r.carrier_parcel));
  const todo = items.filter((it) => !booked.has(`${order.order_no}#${it.id}`));
  if (!todo.length) return { booked: [], failed: [], skipped: items.length };

  const r = await authed(store, "woocommerce/place-order", buildJdPayload(order, todo, store));
  if (r.http >= 400 || !r.body?.success) {
    throw new Error(r.body?.message || `JD rejected the order (HTTP ${r.http}) ${r.raw.slice(0, 200)}`);
  }

  const leg = order.fulfilment_mode === "direct_to_customer" ? "wholesaler_to_customer" : "retailer_to_customer";
  const purgeAfter = new Date(Date.now() + 60 * 86400 * 1000);
  const okBooked = [], failed = [];

  for (const row of flattenJdOrders(r.body.data)) {
    const jdId = row.jd_order_id ? String(row.jd_order_id) : "";
    const itemId = row.wc_item_id || null;
    if (!jdId) {
      failed.push({ item: itemId, error: row.message || "JD returned no shipment id" });
      continue;
    }
    await query(
      `insert into shipments (order_id, leg, courier, carrier_ref, carrier_parcel, carrier_status, carrier_status_at,
                              photos, status, purge_after)
       values ($1,$2,'JD Web & Ship',$3,$4,$5,now(),'[]','submitted',$6)
       on conflict (carrier_ref) do nothing`,
      [orderId, leg, jdId, `${order.order_no}#${itemId}`, row.status || "pending", purgeAfter]
    );
    okBooked.push({ item: itemId, jd_order_id: jdId });
  }
  return { booked: okBooked, failed, skipped: items.length - todo.length };
}

// Tell JD to cancel an order's shipments (our order was cancelled).
export async function cancelOrderAtJd(orderId) {
  const order = (await query(`select * from orders where id=$1`, [orderId])).rows[0];
  if (!order) return { ok: false };
  const store = await connectedStore(order.enrollment_id);
  if (!store) return { ok: false };
  const live = (await query(
    `select 1 from shipments where order_id=$1 and courier='JD Web & Ship'
       and coalesce(carrier_status,'') not in ('cancel','cancelled','canceled','cancelled_at_jd','delivered')`,
    [orderId]
  )).rows.length;
  if (!live) return { ok: true, nothing_to_cancel: true };

  const r = await authed(store, "woocommerce/cancel-order", {
    woocommerce_order_id: order.order_no,
    status: "cancel",
    reason: "Cancelled on the store",
  });
  if (r.http >= 400) throw new Error(r.body?.message || `JD cancel failed (HTTP ${r.http})`);
  // Their reply is keyed by jd_order_id with {status:'true'|...}. Mark what it confirmed.
  for (const [jdId, rows] of Object.entries(r.body?.data?.orders || {})) {
    const res = Array.isArray(rows) ? rows[0] : rows;
    if (String(res?.status) === "true") {
      await query(
        `update shipments set carrier_status='cancel', carrier_status_at=now() where carrier_ref=$1`, [String(jdId)]
      );
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- self-check
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("portal/jdwebship.js")) {
  const { default: assert } = await import("node:assert/strict");
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-selfcheck";
  process.env.SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || "https://api.example.com";

  // credentials survive a round trip and are not stored as themselves
  const enc = encryptCred("Sw0rdf1sh!");
  assert.notEqual(enc, "Sw0rdf1sh!");
  assert.ok(!enc.includes("Sw0rdf1sh"), "ciphertext must not contain the password");
  assert.equal(decryptCred(enc), "Sw0rdf1sh!");
  assert.notEqual(encryptCred("same"), encryptCred("same"), "fresh iv per encryption");
  assert.throws(() => decryptCred(enc.slice(0, -4) + "AAAA"), "a tampered ciphertext must not decrypt");

  // payload: COD flags, declared value, address passthrough
  const items = [
    { id: "i1", product_id: "p1", product_name: "Seiko 5", size: "", qty: 1, line_total: 2350, snapshot: { sku: "SK5" }, image_url: "http://x/a.jpg" },
    { id: "i2", product_id: "p2", product_name: "Jordan 1", size: "9", qty: 2, line_total: 948, snapshot: "{\"sku\":\"AJ1\"}" },
  ];
  const order = {
    order_no: "ORD-000123", buyer_name: "Deepak Nandu", buyer_phone: "+919820524003", buyer_email: "b@example.com",
    payment_method: "cod", cod_due: 3328, total: 3298, subtotal: 3298, prepaid_discount: 0,
    address: { line1: "Meghraj Apt & Co", line2: "Saraswati Rd", city: "Mumbai", state: "Maharashtra", pincode: "400060" },
  };
  const store = { id: "e1", slug: "beepcorp", logo_url: "http://x/logo.png" };
  const p = buildJdPayload(order, items, store);
  assert.equal(p.meta.platform, "woocommerce");
  // Built from SERVER_PUBLIC_URL, whatever .env happens to hold — assert the shape,
  // not the host, so the check isn't tied to one deployment.
  assert.match(p.meta.webhook_url, /^https?:\/\/[^/]+\/jd\/order-status$/);
  assert.equal(p.orders.length, 1, "one orders entry; JD splits it per item");
  assert.equal(p.orders[0].items.length, 2);
  assert.equal(p.orders[0].is_prepaid, false, "cod -> not prepaid");
  assert.equal(p.orders[0].cod_amount, 3328, "courier collects cod_due, incl. the COD fee");
  assert.equal(p.orders[0].shipping_address.country, "india");
  assert.equal(p.orders[0].shipping_address.state, "Maharashtra", "state passes through as a name, no code lookup");
  assert.equal(p.orders[0].items[1].name, "Jordan 1 [9]");
  assert.equal(p.orders[0].items[1].product_sku, "AJ1", "sku read from a JSON-string snapshot");
  assert.equal(p.orders[0].items[1].wc_item_id, "i2");
  const prepaid = buildJdPayload({ ...order, payment_method: "prepaid", cod_due: 0 }, items, store);
  assert.equal(prepaid.orders[0].is_prepaid, true);
  assert.equal(prepaid.orders[0].cod_amount, 0, "prepaid collects nothing on delivery");

  // their nested response flattens to one row per item
  const flat = flattenJdOrders({ orders: { "ORD-000123": [{ jd_order_id: "J1", wc_item_id: "i1", status: "success" }, { jd_order_id: "J2", wc_item_id: "i2", status: "success" }] } });
  assert.equal(flat.length, 2);
  assert.deepEqual(flat.map((r) => r.jd_order_id), ["J1", "J2"]);
  assert.deepEqual(flattenJdOrders(null), [], "a missing body is not a crash");

  // status vocabulary
  assert.equal(jdStatusLabel("ofd"), "Out for delivery");
  assert.equal(jdStatusLabel("weird_new_status"), "weird_new_status", "unknown statuses pass through");
  assert.ok(isJdCancelled("cancelled_at_jd") && isJdCancelled("cancel"));
  assert.ok(isJdDelivered("Delivered") && !isJdDelivered("in_transit"));
  assert.ok(isAuthError(401, {}) && isAuthError(200, { message: "Unauthenticated." }) && !isAuthError(200, { message: "ok" }));

  console.log("jdwebship.check: all assertions passed");
}
