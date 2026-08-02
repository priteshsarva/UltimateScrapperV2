// Pay0.shop UPI gateway.
// Config (base URL + merchant token) now comes from the admin Payment settings
// page (app_settings via portal/settings.js), falling back to PAY0_BASE_URL /
// PAY0_USER_TOKEN env vars. Read at call-time so an admin edit takes effect
// without a restart.
//
// IMPORTANT — the endpoint paths / field names below are Pay0.shop's; change
// only those if your Pay0 docs differ. Nothing else in the app depends on them.
import { getPaymentConfig } from "./settings.js";

async function post(path, params, baseUrl) {
  const BASE = (baseUrl || "https://pay0.shop/api").replace(/\/+$/, "");
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { status: false, message: text }; }
}

function truthy(v) { return v === true || String(v).toLowerCase() === "true" || String(v) === "1"; }

// create an order -> { ok, order_id, payment_url, message, raw }
export async function createOrder({ amount, orderId, customerMobile, redirectUrl, remark }) {
  const cfg = await getPaymentConfig();
  const res = await post("/create-order", {
    customer_mobile: customerMobile || "",
    user_token: cfg.user_token,
    amount: String(amount),
    order_id: orderId,
    redirect_url: redirectUrl || "",
    remark1: remark || "",
    remark2: "",
  }, cfg.base_url);
  const result = res.result || res.data || {};
  const payment_url = result.payment_url || result.paymentUrl || null;
  return {
    ok: truthy(res.status) || !!payment_url,
    order_id: result.orderId || result.order_id || orderId,
    payment_url,
    message: res.message || "",
    raw: res,
  };
}

// check an order's status -> { paid, status, utr, amount, raw }
export async function checkStatus(orderId) {
  const cfg = await getPaymentConfig();
  const res = await post("/check-order-status", { user_token: cfg.user_token, order_id: orderId }, cfg.base_url);
  const result = res.result || res.data || {};
  const st = String(result.txnStatus || result.status || result.order_status || "").toUpperCase();
  return {
    paid: ["SUCCESS", "COMPLETED", "PAID", "SUCCESSFUL"].includes(st),
    status: st || "UNKNOWN",
    utr: result.utr || result.bank_ref || result.rrn || null,
    amount: result.amount || null,
    raw: res,
  };
}
