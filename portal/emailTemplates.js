// WooCommerce-style transactional email renderer. Produces email-safe HTML with
// INLINE styles (mail clients strip <style>), mirroring WooCommerce's classic
// layout: coloured header band, white rounded content card on a light ground,
// bordered order-items table, address columns, muted footer.
//
// Keep it dependency-free and defensive — every field is optional.

const ACCENT = "#3d2f6b";       // header band (WooCommerce-ish deep violet)
const ACCENT_TEXT = "#ffffff";
const INK = "#2b2b2b";
const MUTED = "#6b6b6b";
const LINE = "#e4e4e7";
const BG = "#f4f4f6";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inr = (n) => "₹" + Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// Footer contact block — the STOREFRONT's own details (so the customer contacts
// the store, not the platform). `contact` = { name, email, phone, whatsapp, address }.
function footer(brand, contact) {
  const c = contact || {};
  const bits = [
    c.email ? `✉ ${esc(c.email)}` : "",
    c.phone ? `📞 ${esc(c.phone)}` : "",
    c.whatsapp ? `WhatsApp ${esc(c.whatsapp)}` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const addr = c.address && typeof c.address === "object"
    ? [c.address.line1, c.address.city, c.address.state, c.address.pincode].filter(Boolean).join(", ") : "";
  return `<p style="margin:0 0 4px;font-size:12px;font-weight:700;color:${INK};">${esc(c.name || brand)}</p>
    ${bits ? `<p style="margin:0 0 2px;font-size:12px;color:${MUTED};">${bits}</p>` : ""}
    ${addr ? `<p style="margin:0 0 2px;font-size:12px;color:${MUTED};">${esc(addr)}</p>` : ""}
    <p style="margin:8px 0 0;font-size:11px;color:${MUTED};">This is an automated message about your order.</p>`;
}

// Full HTML document wrapping the body content. `contact` populates the footer
// with the storefront's own details.
export function wrap({ title, brand = "Kartify", intro = "", bodyHtml = "", accent = ACCENT, contact = null }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${BG};-webkit-text-size-adjust:none;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:${INK};">
        <tr><td style="background:${accent};padding:28px 40px;">
          <span style="color:${ACCENT_TEXT};font-size:20px;font-weight:700;letter-spacing:.2px;">${esc(brand)}</span>
        </td></tr>
        <tr><td style="padding:32px 40px 8px;">
          ${title ? `<h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:${INK};">${esc(title)}</h1>` : ""}
          ${intro ? `<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${INK};">${intro}</p>` : ""}
        </td></tr>
        <tr><td style="padding:0 40px 32px;">${bodyHtml}</td></tr>
        <tr><td style="padding:22px 40px;background:#fafafa;border-top:1px solid ${LINE};">
          ${footer(brand, contact)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Order-items table + totals. items: [{product_name,size,qty,unit_price,line_total}].
export function orderTable(items = [], totals = []) {
  const rows = items.map((it) => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};">
        ${esc(it.product_name)}${it.size ? `<span style="color:${MUTED};"> — Size ${esc(it.size)}</span>` : ""}
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};text-align:center;">${esc(it.qty)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid ${LINE};font-size:13px;color:${INK};text-align:right;white-space:nowrap;">${inr(it.line_total ?? (Number(it.unit_price) * Number(it.qty)))}</td>
    </tr>`).join("");
  const totalRows = totals.map(([k, v, strong]) => `
    <tr>
      <td colspan="2" style="padding:8px;font-size:13px;color:${strong ? INK : MUTED};text-align:right;${strong ? "font-weight:700;" : ""}">${esc(k)}</td>
      <td style="padding:8px;font-size:13px;color:${INK};text-align:right;white-space:nowrap;${strong ? "font-weight:700;" : ""}">${esc(v)}</td>
    </tr>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:6px;border-collapse:separate;overflow:hidden;">
    <tr style="background:#fafafa;">
      <th align="left" style="padding:10px 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Product</th>
      <th style="padding:10px 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Qty</th>
      <th align="right" style="padding:10px 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};">Total</th>
    </tr>
    ${rows}
    ${totalRows}
  </table>`;
}

export function addressBlock(label, address = {}) {
  const a = address || {};
  const lines = [a.name, a.line1, a.line2, [a.city, a.state, a.pincode].filter(Boolean).join(", "), a.phone ? `📞 ${a.phone}` : ""].filter(Boolean);
  return `<div style="font-size:13px;line-height:1.6;color:${INK};">
    <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin-bottom:6px;">${esc(label)}</div>
    ${lines.map((l) => esc(l)).join("<br>")}
  </div>`;
}

export function button(label, url, accent = ACCENT) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0;"><tr>
    <td style="background:${accent};border-radius:6px;">
      <a href="${esc(url)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#fff;text-decoration:none;">${esc(label)}</a>
    </td></tr></table>`;
}

export const money = inr;
