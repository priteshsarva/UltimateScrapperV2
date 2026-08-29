// Email via SMTP (nodemailer). Requires: npm install nodemailer
// Config now comes from the admin Email settings page (app_settings via
// portal/settings.js), falling back to SMTP_* / MAIL_FROM env vars. The
// transport is rebuilt automatically when the config changes, so an admin
// edit takes effect without a restart.
import nodemailer from "nodemailer";
import { getSmtpConfig } from "./settings.js";

const APP_URL = process.env.APP_URL || "http://localhost:5174";

let transport = null;
let transportKey = ""; // signature of the config the cached transport was built from

async function tx() {
  const c = await getSmtpConfig();
  const key = `${c.host}|${c.port}|${c.secure}|${c.user}|${c.pass}`;
  if (transport && key === transportKey) return { transport, from: c.from };
  transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure, // true => port 465
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  transportKey = key;
  return { transport, from: c.from };
}

export async function sendMail({ to, subject, html, text, from }) {
  if (!to) return { ok: false, error: "no recipient" };
  try {
    const t = await tx();
    await t.transport.sendMail({ from: from || t.from, to, subject, html, text: text || undefined });
    return { ok: true };
  } catch (e) {
    console.error("[mail] send failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ---- shared layout ----
function layout(title, bodyHtml) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1b2430">
    <h2 style="color:#0E1726;margin:0 0 12px">${title}</h2>
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
    <p style="color:#8a94a6;font-size:12px;margin:0">Server Products</p>
  </div>`;
}
function payButton() {
  return `<p style="margin:18px 0"><a href="${APP_URL}/billing"
    style="background:#0E1726;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;display:inline-block">Pay now</a></p>`;
}
function money(inv) { return `${inv.currency} ${Number(inv.amount).toLocaleString("en-IN")}`; }
function dateStr(d) { return d ? new Date(d).toDateString() : ""; }

// ---- templates ----
export function sendWelcomeEmail(user, shop) {
  return sendMail({
    to: user.email,
    subject: "Welcome — your shop has been submitted",
    html: layout("Welcome to Server Products", `
      <p>Hi ${user.name || "there"},</p>
      <p>Your account is set up and your shop <b>${shop.domain}</b> has been submitted for approval.</p>
      <p>Once it's approved, we'll email you an invoice to activate your subscription.</p>`),
  });
}

export function sendShopApprovedEmail(user, shop, invoice) {
  return sendMail({
    to: user.email,
    subject: `Your shop ${shop.domain} is approved — payment due`,
    html: layout("Shop approved — please pay to activate", `
      <p>Hi ${user.name || "there"},</p>
      <p>Your shop <b>${shop.domain}</b> has been approved.</p>
      <p>Invoice <b>${invoice.invoice_no}</b> for <b>${money(invoice)}</b> is due by <b>${dateStr(invoice.due_date)}</b>.</p>
      ${payButton()}`),
  });
}

export function sendReminderEmail(user, shop, invoice) {
  return sendMail({
    to: user.email,
    subject: `Reminder: invoice ${invoice.invoice_no} due for ${shop.domain}`,
    html: layout("Payment reminder", `
      <p>Hi ${user.name || "there"},</p>
      <p>Invoice <b>${invoice.invoice_no}</b> for <b>${money(invoice)}</b> is still unpaid, due by <b>${dateStr(invoice.due_date)}</b>.</p>
      <p>If it isn't paid by then, your shop <b>${shop.domain}</b> will be suspended.</p>
      ${payButton()}`),
  });
}

export function sendPaymentReceivedEmail(user, shop, invoice) {
  return sendMail({
    to: user.email,
    subject: `Payment received — ${shop.domain} is live`,
    html: layout("Payment received", `
      <p>Hi ${user.name || "there"},</p>
      <p>We've received your payment for invoice <b>${invoice.invoice_no}</b>. Your shop <b>${shop.domain}</b> is now active.</p>`),
  });
}

// ---- storefront order templates (Phase 2) ----
function itemsTable(items) {
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0">
    <tr><th style="text-align:left;padding:8px 0;border-bottom:1px solid #eee;font-size:12px;color:#8a94a6">ITEM</th><th style="text-align:right;padding:8px 0;border-bottom:1px solid #eee;font-size:12px;color:#8a94a6">TOTAL</th></tr>
    ${items.map(it => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #f4f5f7">${it.product_name}${it.size ? ` <span style="color:#6b7688">(Size ${it.size})</span>` : ""} × ${it.qty}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f4f5f7;text-align:right">₹${Number(it.line_total).toLocaleString("en-IN")}</td>
    </tr>`).join("")}
  </table>`;
}
function addressBlock(a) {
  if (!a) return "";
  return `<p style="margin:8px 0;color:#42505f;font-size:13px">
    ${a.name || ""}<br>${a.line1 || ""}${a.line2 ? ", " + a.line2 : ""}<br>
    ${[a.city, a.state, a.pincode].filter(Boolean).join(", ")}<br>
    ${a.phone ? "📞 " + a.phone : ""}
  </p>`;
}

// buyer receipt — sent to the shopper's email if given
export function sendOrderConfirmationEmail({ storeName, buyerName, buyerEmail, orderNo, total, items, address, whatsappUrl }) {
  if (!buyerEmail) return Promise.resolve({ ok: false, error: "no buyer email" });
  return sendMail({
    to: buyerEmail,
    subject: `Order ${orderNo} received — ${storeName}`,
    html: layout(`Thanks for your order, ${buyerName || "there"}!`, `
      <p>We've received your order <b>${orderNo}</b> from <b>${storeName}</b>.</p>
      ${itemsTable(items)}
      <p style="margin:8px 0;font-size:16px"><b>Total: ₹${Number(total).toLocaleString("en-IN")}</b></p>
      <h4 style="margin:18px 0 6px;color:#0E1726">Deliver to</h4>
      ${addressBlock(address)}
      ${whatsappUrl ? `<p style="margin:18px 0"><a href="${whatsappUrl}" style="background:#25D366;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;display:inline-block">Send order on WhatsApp</a></p>` : ""}
      <p style="color:#8a94a6;font-size:12px">The vendor will confirm your order on WhatsApp shortly.</p>`),
  });
}

// vendor notification — sent to the vendor's account email
export function sendOrderNotificationEmail({ vendorEmail, storeName, orderNo, buyerName, buyerPhone, total, items, address }) {
  if (!vendorEmail) return Promise.resolve({ ok: false, error: "no vendor email" });
  return sendMail({
    to: vendorEmail,
    subject: `🔔 New order ${orderNo} on ${storeName} — ₹${Number(total).toLocaleString("en-IN")}`,
    html: layout(`New order on ${storeName}`, `
      <p>You've got a new order <b>${orderNo}</b>.</p>
      <p><b>${buyerName}</b> · ${buyerPhone}</p>
      ${itemsTable(items)}
      <p style="margin:8px 0;font-size:16px"><b>Total: ₹${Number(total).toLocaleString("en-IN")}</b></p>
      <h4 style="margin:18px 0 6px;color:#0E1726">Deliver to</h4>
      ${addressBlock(address)}
      <p style="color:#8a94a6;font-size:12px">Confirm and fulfil this order in your portal Orders tab.</p>`),
  });
}
