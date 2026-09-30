// Outreach campaign driven by a spreadsheet.
//
// Upload an .xlsx/.csv whose FIRST column is the mobile number; every other column is kept
// and comes back in the export. The bot then sends the two opening messages (Hinglish, then
// English, as separate messages) and the normal assistant handles whatever comes back.
//
// Deliberately slow. Blasting a few hundred WhatsApp messages from one number is the fastest
// way to get it banned, so the bot takes a few per tick with gaps, inside working hours only,
// and stops for good on anyone who hasn't replied in CAMPAIGN_STOP_DAYS.
import XLSX from "xlsx";
import { query } from "./db.js";

export const OPENERS = [
  "Hello! Main thekartify.com se bol raha hoon. Raw supplier links bhejkar sales lose mat karo — SelloShip aur JD products dete hain, par Kartify aapko wo checkout deta hai jo actually paise collect karta hai. Minutes me apna branded store launch karo automated UPI aur WhatsApp checkout ke saath.",
  "Hello! I'm reaching out from thekartify.com. Stop losing customers to raw supplier links — SelloShip & JD give you products, but Kartify gives you the checkout that actually collects the money. Launch your branded store in minutes with automated UPI & WhatsApp checkout.",
];

// How many new numbers get opened per bot tick, and how many in one day. Low on purpose.
export const PER_TICK = Number(process.env.CAMPAIGN_PER_TICK || 4);
export const PER_DAY = Number(process.env.CAMPAIGN_PER_DAY || 60);
export const STOP_DAYS = Number(process.env.CAMPAIGN_STOP_DAYS || 2);

// When cold outreach may go out (IST hours). Editable from the portal — kept in the DB, not in
// the bot's .env, so changing it doesn't need a deploy. Defaults: 8am to 7pm.
const DEFAULTS = { from: Number(process.env.CAMPAIGN_FROM || 8), to: Number(process.env.CAMPAIGN_TO || 19), per_day: PER_DAY };
const hour = () => Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false })) % 24;

export async function campaignSettings() {
  let saved = {};
  try { saved = (await query(`select value from app_settings where key='wa_campaign'`)).rows[0]?.value || {}; } catch { /* pre-migration */ }
  const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? Math.floor(x) : d; };
  return {
    from: n(saved.from, DEFAULTS.from, 0, 23),
    to: n(saved.to, DEFAULTS.to, 1, 24),
    per_day: n(saved.per_day, DEFAULTS.per_day, 1, 500),
  };
}

export const openingHoursNow = async () => {
  const s = await campaignSettings();
  const h = hour();
  return { open: h >= s.from && h < s.to, ...s };
};

const digits = (p) => String(p ?? "").replace(/\D/g, "");
// The country code is optional in the sheet — 9408386083, +91 94083 86083 and 919408386083 all
// land on the same number. Leading zeros are dialling prefixes, not part of the number
// (0 9408386083, 0091 9408386083), and an Indian mobile never starts with 0 anyway, so they go.
const bare = (p) => digits(p).replace(/^0+/, "");
// 10 digits -> 91XXXXXXXXXX, which is how every other table here stores a number.
const canon = (p) => { const d = bare(p); return d.length === 10 ? "91" + d : d; };
const valid = (p) => { const d = bare(p); return d.length === 10 || (d.length === 12 && d.startsWith("91")); };

// Parse an uploaded sheet. First column = phone; a header row is detected and kept as labels.
export function parseSheet(base64) {
  const wb = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { rows: [], headers: [] };
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
  if (!grid.length) return { rows: [], headers: [] };

  // If the first row's first cell isn't a number, treat that row as headers.
  const headerRow = valid(grid[0][0]) ? null : grid[0].map((h) => String(h || "").trim());
  const body = headerRow ? grid.slice(1) : grid;
  const headers = headerRow || [];

  const rows = [];
  body.forEach((r, i) => {
    const phone = canon(r[0]);
    const extra = {};
    for (let c = 1; c < r.length; c++) {
      const key = (headers[c] || `col${c + 1}`).trim() || `col${c + 1}`;
      if (String(r[c] ?? "").trim()) extra[key] = String(r[c]).trim();
    }
    // a "name" column, whatever it's called, is worth having separately
    const nameKey = Object.keys(extra).find((k) => /name|shop|store|business/i.test(k));
    rows.push({ phone, name: nameKey ? extra[nameKey] : null, extra, row_no: i + 1, ok: valid(r[0]) });
  });
  return { rows, headers };
}

// Load a parsed sheet into the campaign. Numbers already in the campaign are left alone.
export async function importRows(rows, file) {
  let added = 0, skipped = 0, bad = 0;
  for (const r of rows) {
    if (!r.ok) { bad++; continue; }
    const res = await query(
      `insert into wa_campaign (phone, name, extra, file, row_no)
       values ($1,$2,$3,$4,$5) on conflict (phone) do nothing returning id`,
      [r.phone, r.name, JSON.stringify(r.extra), file || null, r.row_no]);
    if (res.rowCount) added++; else skipped++;
  }
  return { added, skipped, bad, total: rows.length };
}

// The next few numbers to open — only inside the outreach window, and within the daily cap.
export async function nextBatch() {
  const win = await openingHoursNow();
  if (!win.open) return [];
  const [{ today }] = (await query(
    `select count(*)::int as today from wa_campaign
      where sent_at > (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`)).rows;
  const room = Math.max(0, win.per_day - today);
  if (!room) return [];
  return (await query(
    `select id, phone, name from wa_campaign where status='pending' order by id limit $1`,
    [Math.min(PER_TICK, room)])).rows;
}

export async function markSent(id, ok, error) {
  await query(
    `update wa_campaign set status=$2, sent_at=now(), error=$3 where id=$1`,
    [id, ok ? "sent" : "failed", ok ? null : String(error || "").slice(0, 200)]);
}

// They answered: stop the campaign clock for them, the assistant has the conversation now.
export async function markReplied(phone) {
  await query(
    `update wa_campaign set status='replied', replied_at=now()
      where right(phone,10)=$1 and status in ('sent','pending')`, [digits(phone).slice(-10)]);
}

// Silence for STOP_DAYS after the opener -> stop. We don't chase people who never answered.
export async function stopSilent() {
  const { rows } = await query(
    `update wa_campaign set status='stopped'
      where status='sent' and replied_at is null
        and sent_at < now() - make_interval(days => $1) returning phone`, [STOP_DAYS]);
  return rows;
}

// Anyone worth the owner's own time — judged on what they DID, not on how keen they sounded.
//
// The old rule was `score='hot' or stage in (...)`, and the reference chats show both halves
// failing. score is the model's mood: across nine live chats it produced no hot lead at all,
// while "Great, I'll let you know" and "Ok" read as progress. What the chats that were really
// alive had instead was one concrete ask the bot cannot finish on its own:
//   "How can i trust you / I would require refrence / who are you working with" -> reference
//   "Use my website and update all products with some new features I want. Is it possible?" -> migrate
//   "If you provide direct wholesaler base Website I'd like to Start with you" / a seller's
//   number pasted into the chat -> supplier
//   a watch photo + "Send me nam wholesale" -> sourcing (they want stock, not a store)
//   picking up the phone -> call
// Those are the hand-over line. Asking the price is not on it: the bot answers that itself.
export const QUALIFY = ["call", "reference", "migrate", "supplier", "sourcing", "numbers", "paying"];
export async function newlyQualified() {
  const { rows } = await query(
    `update wa_campaign c set status='qualified', qualified_at=now()
       from wa_leads l
      where right(l.phone,10) = right(c.phone,10)
        and c.status in ('sent','replied')
        and l.stage <> 'not_interested'
        -- a WhatsApp Business greeting is not a conversation
        and exists (select 1 from wa_messages m where m.jid = l.jid and m.role = 'client')
        and (l.signals ?| $1::text[] or l.stage in ('demo_yes','details','ready'))
      returning c.phone, l.name, l.business, l.sells, l.city, l.stage, l.score, l.score_reason,
                l.store_name, l.demo_slug, l.signals`, [QUALIFY]);
  return rows;
}

export async function campaignStats() {
  const rows = (await query(`select status, count(*)::int as n from wa_campaign group by status`)).rows;
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  const [{ today }] = (await query(
    `select count(*)::int as today from wa_campaign
      where sent_at > (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`)).rows;
  return { ...by, total: rows.reduce((s, r) => s + r.n, 0), sent_today: today, ...(await campaignSettings()) };
}

// The same sheet back, with what happened to every number. Returns base64 .xlsx.
export async function exportSheet() {
  const rows = (await query(
    `select c.phone, c.name, c.extra, c.status, c.sent_at, c.replied_at, c.qualified_at, c.error,
            l.score, l.stage, l.business, l.city, l.sells, l.shops, l.store_name, l.supplier_links,
            l.demo_slug, l.outcome, l.score_reason, l.signals,
            (select count(*) from wa_messages m where m.jid = l.jid)::int as messages
       from wa_campaign c left join wa_leads l on right(l.phone,10) = right(c.phone,10)
      order by c.id`)).rows;

  const fmt = (d) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "");
  const extraKeys = [...new Set(rows.flatMap((r) => Object.keys(r.extra || {})))];
  const out = rows.map((r) => ({
    Mobile: r.phone,
    Name: r.name || r.business || "",
    Status: r.status,
    "Opening sent": fmt(r.sent_at),
    Replied: fmt(r.replied_at),
    Qualified: fmt(r.qualified_at),
    Messages: r.messages || 0,
    Interest: r.score || "",
    Stage: r.stage || "",
    "Shop / business": r.business || "",
    City: r.city || "",
    Sells: r.sells || "",
    Shops: r.shops || "",
    "Store name given": r.store_name || "",
    "Their supplier": r.supplier_links || "",
    "Demo store": r.demo_slug ? `https://${r.demo_slug}.thekartify.com` : "",
    Result: r.outcome || "",
    Signals: (r.signals || []).join(", "),
    Why: r.score_reason || "",
    Error: r.error || "",
    ...Object.fromEntries(extraKeys.map((k) => [k, (r.extra || {})[k] || ""])),
  }));

  const ws = XLSX.utils.json_to_sheet(out.length ? out : [{ Mobile: "", Status: "no rows yet" }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Campaign");
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

// One number typed six different ways must reach one chat — a duplicate here means a second
// opener to someone already talking to us. Run `node portal/waCampaign.js` after touching canon.
if (import.meta.url === (await import("url")).pathToFileURL(process.argv[1] || "").href) {
  const assert = (await import("assert")).strict;
  for (const p of [9408386083, "9408386083", "94083 86083", "+919408386083", "+91 94083 86083",
                   "919408386083", 919408386083, "91-9408386083", "09408386083", "0091 9408386083"]) {
    assert.equal(valid(p), true, String(p));
    assert.equal(canon(p), "919408386083", String(p));
  }
  for (const p of ["", "abc", "94083", "9408386083123", "1234567890123"]) assert.equal(valid(p), false, String(p));
  console.log("waCampaign ok");
}
