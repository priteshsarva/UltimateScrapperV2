// Order + payout lifecycle emails (WooCommerce-style). Each email has a pure
// build*() returning { subject, html } so the SAME source powers both sending and
// the admin preview. Senders are fire-and-forget — a mail failure never breaks a
// request.
import { sendMail } from "./mailer.js";
import { wrap, orderTable, addressBlock, money } from "./emailTemplates.js";

const itemsFor = (items = []) => items.map((it) => ({
  product_name: it.product_name, size: it.size, qty: it.qty,
  unit_price: it.unit_price, line_total: it.line_total,
}));

function orderBody(order, items, { extra = "" } = {}) {
  const totals = [
    ["Subtotal", money(order.subtotal ?? order.total)],
    ["Total", money(order.total), true],
    [order.payment_status === "verified" ? "Paid" : "Payment", order.payment_status === "verified" ? money(order.total) : "Pending"],
  ];
  return `${orderTable(itemsFor(items), totals)}
    <div style="margin-top:20px;">${addressBlock("Shipping to", order.address)}</div>
    ${extra}`;
}

// kind -> [subjectBase, title, intro]
const CUSTOMER_COPY = {
  placed: (no) => ["Order received", `Order ${no} received`, "Thanks for your order! We've received it and will confirm your payment shortly."],
  processing: (no) => ["Your order is being processed", `Order ${no} is being processed`, "Your payment is confirmed and your order is now being prepared."],
  completed: (no) => ["Your order is complete", `Order ${no} is complete`, "Your order is complete. Thanks for shopping with us!"],
  "on-hold": (no) => ["Your order is on hold", `Order ${no} is on hold`, "Your order is on hold. We'll be in touch shortly."],
  cancelled: (no) => ["Your order was cancelled", `Order ${no} was cancelled`, "Your order has been cancelled. If this is unexpected, please reach out."],
  refunded: (no) => ["Your order was refunded", `Order ${no} was refunded`, "Your order has been refunded."],
};

export function buildCustomerOrderEmail(kind, { brand, order, items, contact = null }) {
  const [subjectBase, title, intro] = (CUSTOMER_COPY[kind] || CUSTOMER_COPY.placed)(order.order_no);
  return { subject: `${subjectBase} — ${order.order_no}`, html: wrap({ title, brand, intro, bodyHtml: orderBody(order, items), contact }) };
}

export function buildVendorOrderEmail({ brand, order, items, storeName, contact = null }) {
  return {
    subject: `New order ${order.order_no}${storeName ? " — " + storeName : ""}`,
    html: wrap({
      title: `New order ${order.order_no}`, brand,
      intro: `A new order was placed on ${storeName || "your store"}.`,
      bodyHtml: orderBody(order, items, { extra: `<p style="font-size:13px;color:#6b6b6b;margin-top:16px;">Buyer: ${order.buyer_name || ""} · ${order.buyer_phone || ""}${order.buyer_email ? " · " + order.buyer_email : ""}</p>` }),
      contact,
    }),
  };
}

const PAYOUT_COPY = {
  processing: (amt) => ["Payout processing", "Your payout is being processed", `Your payout of ${money(amt)} is being processed and will reach your account shortly.`],
  paid: (amt) => ["Payout sent", "Your payout has been sent", `We've sent your payout of ${money(amt)}.`],
  cancelled: (amt) => ["Payout cancelled", "Your payout was cancelled", `Your payout request of ${money(amt)} was cancelled.`],
};

export function buildPayoutEmail(kind, { brand, amount, utr, note }) {
  const [subjectBase, title, intro] = (PAYOUT_COPY[kind] || PAYOUT_COPY.processing)(amount);
  const rows = [
    ["Amount", money(amount)],
    kind === "paid" && utr ? ["Reference (UTR)", utr] : null,
    kind === "cancelled" && note ? ["Reason", note] : null,
  ].filter(Boolean).map(([k, v]) => `<tr><td style="padding:6px 0;font-size:13px;color:#6b6b6b;">${k}</td><td style="padding:6px 0;font-size:13px;color:#2b2b2b;text-align:right;font-weight:600;">${v}</td></tr>`).join("");
  return { subject: subjectBase, html: wrap({ title, brand, intro, bodyHtml: `<table role="presentation" width="100%" style="border:1px solid #e4e4e7;border-radius:6px;"><tbody style="padding:8px;">${rows}</tbody></table>` }) };
}

// ---- senders (fire-and-forget) ----
export function sendCustomerOrderEmail({ to, brand, order, items, kind, contact }) {
  if (!to) return;
  const { subject, html } = buildCustomerOrderEmail(kind, { brand, order, items, contact });
  sendMail({ to, subject, html }).catch((e) => console.error("[orderEmail]", e.message));
}
export function sendVendorOrderEmail({ to, brand, order, items, storeName, contact }) {
  if (!to) return;
  const { subject, html } = buildVendorOrderEmail({ brand, order, items, storeName, contact });
  sendMail({ to, subject, html }).catch((e) => console.error("[orderEmail]", e.message));
}
export function sendPayoutEmail({ to, brand, kind, amount, utr, note }) {
  if (!to) return;
  const { subject, html } = buildPayoutEmail(kind, { brand, amount, utr, note });
  sendMail({ to, subject, html }).catch((e) => console.error("[payoutEmail]", e.message));
}
