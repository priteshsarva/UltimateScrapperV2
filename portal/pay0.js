// Pay0.shop UPI gateway.
// Env: PAY0_USER_TOKEN (your merchant API token), PAY0_BASE_URL (default https://pay0.shop/api).
//
// IMPORTANT — verify against your Pay0 dashboard Documentation page (it blocks bots,
// so these are the standard Pay0.shop field names). If your docs differ, change ONLY
// the endpoint paths / field names below — nothing else in the app depends on them.
const BASE = (process.env.PAY0_BASE_URL || "https://pay0.shop/api").replace(/\/+$/, "");
const TOKEN = process.env.PAY0_USER_TOKEN || "";

async function post(path, params) {
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
  const res = await post("/create-order", {
    customer_mobile: customerMobile || "",
    user_token: TOKEN,
    amount: String(amount),
    order_id: orderId,
    redirect_url: redirectUrl || "",
    remark1: remark || "",
    remark2: "",
  });
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
  const res = await post("/check-order-status", { user_token: TOKEN, order_id: orderId });
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
