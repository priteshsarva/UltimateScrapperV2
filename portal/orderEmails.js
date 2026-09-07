// Order lifecycle emails (WooCommerce-style). Fire-and-forget: never let a mail
// failure break the request. Each builds HTML via emailTemplates + sends it.
import { sendMail } from "./mailer.js";
import { wrap, orderTable, addressBlock, button, money } from "./emailTemplates.js";

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
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;"><tr>
      <td valign="top" style="padding-right:12px;">${addressBlock("Shipping to", order.address)}</td>
    </tr></table>
    ${extra}`;
}

// Customer subject/title per WooCommerce vocabulary.
const CUSTOMER_COPY = {
  placed: (no) => ["Order received", `Order ${no} received`, "Thanks for your order! We've received it and will confirm your payment shortly."],
  processing: (no) => ["Your order is being processed", `Order ${no} is being processed`, "Your payment is confirmed and your order is now being prepared."],
  completed: (no) => ["Your order is complete", `Order ${no} is complete`, "Your order is complete. Thanks for shopping with us!"],
  "on-hold": (no) => ["Your order is on hold", `Order ${no} is on hold`, "Your order is on hold. We'll be in touch shortly."],
  cancelled: (no) => ["Your order was cancelled", `Order ${no} was cancelled`, "Your order has been cancelled. If this is unexpected, please reach out."],
  refunded: (no) => ["Your order was refunded", `Order ${no} was refunded`, "Your order has been refunded."],
};

export function sendCustomerOrderEmail({ to, brand, order, items, kind }) {
  if (!to) return;
  const [subjectBase, title, intro] = (CUSTOMER_COPY[kind] || CUSTOMER_COPY.placed)(order.order_no);
  const html = wrap({ title, brand, intro, bodyHtml: orderBody(order, items) });
  sendMail({ to, subject: `${subjectBase} — ${order.order_no}`, html }).catch((e) => console.error("[orderEmail]", e.message));
}

// New-order alert to the vendor/admin.
export function sendVendorOrderEmail({ to, brand, order, items, storeName }) {
  if (!to) return;
  const html = wrap({
    title: `New order ${order.order_no}`, brand,
    intro: `A new order was placed on ${storeName || "your store"}.`,
    bodyHtml: orderBody(order, items, { extra: `<p style="font-size:13px;color:#6b6b6b;margin-top:16px;">Buyer: ${order.buyer_name || ""} · ${order.buyer_phone || ""}${order.buyer_email ? " · " + order.buyer_email : ""}</p>` }),
  });
  sendMail({ to, subject: `New order ${order.order_no}${storeName ? " — " + storeName : ""}`, html }).catch((e) => console.error("[orderEmail]", e.message));
}
