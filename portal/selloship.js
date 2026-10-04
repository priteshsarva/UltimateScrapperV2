// Selloship fulfilment client — push a storefront order out as shipments and poll
// tracking back in. Per store: each vendor connects their own Selloship account
// (see selloship.sql for why), so COD lands with them, not with the platform.
//
// Auth chain, confirmed against a live account:
//   Vendor_login(email,password)            -> vendor_id              (ONCE, at connect)
//   Generate_vendor_token(vendor_id)         -> access_token          (Authorization: md5(vendor_id+email))
//   create_order(...)                        -> selloship_order_id, selloship_url
//   wordpress_track(order_id,vendor_id)      -> data[0].tracking_url
// The password is needed only for the first call and is never stored.
//
// Three things their own WooCommerce plugin gets wrong, fixed here:
//   1. it hand-concatenates the query string and replaces '&' with 'and' to cope —
//      we form-encode properly, so addresses survive intact;
//   2. it collapses a multi-item order into ONE parcel with every product name
//      glued into one string — we book one Selloship order per line item;
//   3. it sends the ORDER TOTAL as each item's price — we send the amount actually
//      collectable per item (see selloshipPrices), which is what COD cash depends on.
//
// Self-check: node portal/selloship.js
import crypto from "node:crypto";
import { query } from "./db.js";

const LOGIN_URL = "https://selloship.com/api/lock_actvs/Vendor_login";
const TOKEN_URL = "https://selloship.com/api/lock_actvs/Generate_vendor_token";
const ORDER_URL = "https://selloship.com/web_api/create_order";
const TRACK_URL = "https://selloship.com/web_api/wordpress_track";
const DEVICE_FROM = "3";                   // their code for "WooCommerce/web plugin"
const PAY_COD = "3", PAY_PREPAID = "4";    // their payment_method enum

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Their API answers 200 with a JSON body and sometimes a UTF-8 BOM.
async function call(url, params, auth = "") {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(auth ? { Authorization: auth } : {}) },
    body: new URLSearchParams(params),
  });
  const raw = (await r.text()).replace(/^﻿/, "");
  let body = null;
  try { body = JSON.parse(raw); } catch { /* keep raw for the error path */ }
  return { http: r.status, body, raw };
}

export const vendorAuth = (vendorId, email) =>
  crypto.createHash("md5").update(String(vendorId) + String(email)).digest("hex");

// One-time: exchange the vendor's Selloship login for their vendor_id.
export async function selloshipLogin(email, password, siteUrl) {
  const { http, body, raw } = await call(LOGIN_URL, {
    email, password, reg_form: DEVICE_FROM, device_id: "abcd",
    app_status: DEVICE_FROM, device_from: DEVICE_FROM, site_url: siteUrl || "",
  }, "1");
  const row = body?.data?.[0];
  if (String(body?.success) !== "1" || !row?.vendor_id) {
    throw new Error(body?.msg || `Selloship login failed (HTTP ${http}) ${raw.slice(0, 200)}`);
  }
  return {
    vendor_id: String(row.vendor_id),
    email: row.email || email,
    store_name: row.store_name || "",
    flags: {
      wholesaler_permission: row.wholesaler_permission ?? null,
      direct_transfer: row.direct_transfer ?? null,
      preship: row.preship ?? null,
      url: row.url || null,
    },
  };
}

// Short-lived token for the order/tracking calls. Cheap — fetch one per push.
export async function selloshipToken(vendorId, email) {
  const { http, body, raw } = await call(TOKEN_URL, { vendor_id: vendorId, device_from: DEVICE_FROM }, vendorAuth(vendorId, email));
  if (String(body?.success) !== "1" || !body?.access_token) {
    throw new Error(body?.msg || `Selloship token failed (HTTP ${http}) ${raw.slice(0, 200)}`);
  }
  return body.access_token;
}

// ---------------------------------------------------------------- pure payload

// What the courier must COLLECT for each line, which is not the same as what the
// line is worth: a COD order owes cod_due (the total PLUS the COD fee), and a
// semi-COD order owes only the part the buyer hasn't already paid online. Send
// the line value only when there is nothing to collect (prepaid).
// The last line absorbs the rounding remainder so the parcels sum to cod_due
// exactly — otherwise the courier collects a few paise too much or too little.
export function selloshipPrices(items, { cod_due = 0, subtotal = 0 } = {}) {
  const lines = items.map((it) => round2(it.line_total));
  const due = round2(cod_due);
  const base = round2(subtotal) || round2(lines.reduce((s, v) => s + v, 0));
  if (due <= 0 || base <= 0) return lines;              // prepaid: declared value
  const scaled = lines.map((v) => round2((v * due) / base));
  const drift = round2(due - scaled.reduce((s, v) => s + v, 0));
  if (drift !== 0 && scaled.length) scaled[scaled.length - 1] = round2(scaled[scaled.length - 1] + drift);
  return scaled;
}

const nameParts = (full = "") => {
  const p = String(full).trim().split(/\s+/);
  return { first: p[0] || "", last: p.slice(1).join(" ") || p[0] || "" };
};

// One form body per line item. Pure, so the self-check below can pin the money.
export function buildSelloshipOrders(order, items, vendorId) {
  const a = order.address || {};
  const { first, last } = nameParts(order.buyer_name || a.name);
  const cod = order.payment_method === "cod" || order.payment_method === "semicod";
  const prices = selloshipPrices(items, { cod_due: cod ? order.cod_due : 0, subtotal: order.subtotal });

  return items.map((it, i) => {
    const price = prices[i];
    const sku = (typeof it.snapshot === "string" ? safeJson(it.snapshot) : it.snapshot || {}).sku || "";
    return {
      vendor_id: vendorId,
      device_from: DEVICE_FROM,
      product_name: it.product_name + (it.size ? ` [${it.size}]` : ""),
      price: String(price),
      old_price: String(round2(it.line_total)),
      first_name: first,
      last_name: last,
      mobile_no: order.buyer_phone || a.phone || "",
      address: [a.line1, a.line2].filter(Boolean).join(", "),
      state: a.state || "",
      city: a.city || "",
      zip_code: a.pincode || "",
      landmark: a.line2 || a.city || "",
      payment_method: cod ? PAY_COD : PAY_PREPAID,
      qty: String(it.qty),
      email: order.buyer_email || "",
      // Their plugin sends one id per order because it never splits. We DO split,
      // so each parcel needs its own reference or Selloship may collapse them.
      custom_order_id: `${order.order_no}-${i + 1}`,
      sku,
    };
  });
}

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// ---------------------------------------------------------------- order push

const connectedStore = async (enrollmentId) =>
  (await query(
    `select selloship_vendor_id, selloship_email from enrollments where id=$1 and selloship_vendor_id is not null`,
    [enrollmentId]
  )).rows[0];

// Book every not-yet-booked line of an order with Selloship. One shipments row
// per parcel, carrying the Selloship order id in carrier_ref so the tracking poll
// can find it. Status stays 'submitted': an aggregator booking is proof the
// parcel left, NOT authorisation to release platform-held money — the admin still
// approves that, now with an AWB to look at instead of photos.
export async function pushOrderToSelloship(orderId) {
  const order = (await query(`select * from orders where id=$1`, [orderId])).rows[0];
  if (!order) throw new Error("Order not found");
  if (order.payment_status !== "verified") throw new Error("Verify the payment before booking the shipment.");

  const store = await connectedStore(order.enrollment_id);
  if (!store) throw new Error("This store isn't connected to Selloship yet.");

  const items = (await query(`select * from order_items where order_id=$1 order by id`, [orderId])).rows;
  if (!items.length) throw new Error("Order has no items.");

  const bookedParcels = new Set(
    (await query(`select carrier_parcel from shipments where order_id=$1 and carrier_parcel is not null`, [orderId]))
      .rows.map((r) => r.carrier_parcel)
  );

  const payloads = buildSelloshipOrders(order, items, store.selloship_vendor_id);
  const token = await selloshipToken(store.selloship_vendor_id, store.selloship_email);
  const leg = order.fulfilment_mode === "direct_to_customer" ? "wholesaler_to_customer" : "retailer_to_customer";
  const purgeAfter = new Date(Date.now() + 60 * 86400 * 1000);

  const booked = [], failed = [];
  for (const p of payloads) {
    // Idempotence: our custom_order_id is per-parcel, so a retry never re-books a
    // parcel we already have a shipments row for.
    if (bookedParcels.has(p.custom_order_id)) continue;

    const { http, body, raw } = await call(ORDER_URL, p, token);
    const ref = body?.selloship_order_id;
    if (!ref) {
      failed.push({ parcel: p.custom_order_id, error: body?.msg || `HTTP ${http} ${raw.slice(0, 160)}` });
      continue;
    }
    await query(
      `insert into shipments (order_id, leg, courier, tracking_url, carrier_ref, carrier_parcel, photos, status, purge_after)
       values ($1,$2,'Selloship',$3,$4,$5,'[]','submitted',$6)
       on conflict (carrier_ref) do nothing`,
      [orderId, leg, body.selloship_url || null, String(ref), p.custom_order_id, purgeAfter]
    );
    booked.push({ parcel: p.custom_order_id, selloship_order_id: String(ref) });
  }
  return { booked, failed, skipped: payloads.length - booked.length - failed.length };
}

// ---------------------------------------------------------------- tracking poll

// Fill in courier + tracking number for Selloship parcels that don't have one yet.
// Their tracking call answers success:0 until a courier is assigned, so a parcel
// stays in the queue until it is. Re-uses notifyBuyerShipped's one-shot email via
// the PATCH path, so pass the callback in rather than importing it (cycle).
export async function selloshipTrackTick({ onTracking = null, limit = 200 } = {}) {
  const rows = (await query(
    `select s.id, s.carrier_ref, o.enrollment_id
       from shipments s join orders o on o.id = s.order_id
      where s.carrier_ref is not null and s.courier = 'Selloship'
        and s.tracking_no is null and s.status <> 'rejected'
      order by s.created_at limit $1`, [limit]
  )).rows;

  let updated = 0, pending = 0;
  for (const r of rows) {
    const store = await connectedStore(r.enrollment_id);
    if (!store) continue;
    try {
      const { body } = await call(TRACK_URL, { order_id: r.carrier_ref, vendor_id: store.selloship_vendor_id });
      const d = Array.isArray(body?.data) ? body.data[0] : null;
      const url = d?.tracking_url || null;
      if (String(body?.success) !== "1" || !url) { pending++; continue; }
      await query(
        `update shipments set tracking_url=$1, tracking_no=coalesce(tracking_no,$2) where id=$3`,
        [url, r.carrier_ref, r.id]
      );
      updated++;
      if (onTracking) await onTracking(r.id);
    } catch (e) {
      console.error("[selloship track]", r.carrier_ref, e.message);
      pending++;
    }
  }
  return { checked: rows.length, updated, pending };
}

// ---------------------------------------------------------------- self-check
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("portal/selloship.js")) {
  const { default: assert } = await import("node:assert/strict");
  const items = [
    { product_name: "Seiko 5", size: "", qty: 1, line_total: 2350, snapshot: { sku: "SK5" } },
    { product_name: "Jordan 1", size: "9", qty: 2, line_total: 948, snapshot: "{\"sku\":\"AJ1\"}" },
  ];
  const sum = (a) => Math.round(a.reduce((s, v) => s + v, 0) * 100) / 100;

  // prepaid: nothing to collect -> declared line value
  assert.deepEqual(selloshipPrices(items, { cod_due: 0, subtotal: 3298 }), [2350, 948]);

  // COD with a ₹30 fee: the courier must collect the fee too, so the parcels sum
  // to cod_due, NOT to the subtotal.
  const cod = selloshipPrices(items, { cod_due: 3328, subtotal: 3298 });
  assert.equal(sum(cod), 3328, "COD parcels must sum to cod_due");

  // semi-COD: buyer paid ₹660 online, courier collects the rest
  const semi = selloshipPrices(items, { cod_due: 2668, subtotal: 3298 });
  assert.equal(sum(semi), 2668, "semi-COD parcels must sum to the cash still due");
  assert.ok(semi[0] < 2350, "semi-COD line must be scaled down, not sent at full value");

  // a remainder that doesn't divide cleanly still lands exactly
  const odd = selloshipPrices([{ line_total: 100 }, { line_total: 100 }, { line_total: 100 }], { cod_due: 100, subtotal: 300 });
  assert.equal(sum(odd), 100, "rounding drift must be absorbed");

  // payload: one body per line, unique parcel refs, COD flag, encoded address
  const order = {
    order_no: "ORD-000123", buyer_name: "Deepak Nandu", buyer_phone: "+919820524003",
    buyer_email: "b@example.com", payment_method: "cod", cod_due: 3328, subtotal: 3298,
    address: { line1: "Meghraj Apt & Co", line2: "Saraswati Rd", city: "Mumbai", state: "Maharashtra", pincode: "400060" },
  };
  const out = buildSelloshipOrders(order, items, "45528");
  assert.equal(out.length, 2, "one Selloship order per line item");
  assert.deepEqual(out.map((o) => o.custom_order_id), ["ORD-000123-1", "ORD-000123-2"]);
  assert.equal(out[0].payment_method, "3", "cod -> 3");
  assert.equal(out[1].product_name, "Jordan 1 [9]");
  assert.equal(out[1].sku, "AJ1", "sku read from a JSON-string snapshot");
  assert.equal(out[0].first_name, "Deepak");
  assert.equal(out[0].last_name, "Nandu");
  assert.ok(out[0].address.includes("&"), "'&' survives as itself — form encoding, not their str_replace");
  assert.equal(new URLSearchParams(out[0]).get("address"), "Meghraj Apt & Co, Saraswati Rd");
  assert.equal(buildSelloshipOrders({ ...order, payment_method: "prepaid", cod_due: 0 }, items, "1")[0].payment_method, "4");

  assert.equal(vendorAuth("45528", "a@b.com"), crypto.createHash("md5").update("45528a@b.com").digest("hex"));
  console.log("selloship.check: all assertions passed");
}
