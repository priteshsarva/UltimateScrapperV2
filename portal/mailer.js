// Email via SMTP (nodemailer). Requires: npm install nodemailer
// Env: SMTP_HOST, SMTP_PORT, SMTP_SECURE ('true' for 465), SMTP_USER, SMTP_PASS,
//      MAIL_FROM (defaults to SMTP_USER), APP_URL (portal base for pay links).
import nodemailer from "nodemailer";

const APP_URL = process.env.APP_URL || "http://localhost:5174";
const FROM = process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@localhost";

let transport = null;
function tx() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true", // true => port 465
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

export async function sendMail({ to, subject, html, text }) {
  if (!to) return { ok: false, error: "no recipient" };
  try {
    await tx().sendMail({ from: FROM, to, subject, html, text: text || undefined });
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
