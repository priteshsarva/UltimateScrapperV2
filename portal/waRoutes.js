// WhatsApp support bot — backend side. The bot itself (whatsapp-bot/, separate
// server) owns the WhatsApp connection and menus; everything it knows comes from here.
//   app.use("/internal/wa", waInternalRoutes)   bot -> backend, x-internal-key = WA_INTERNAL_KEY
//   app.use("/portal/admin/wa", waAdminRoutes)  admin screen: FAQs, pending questions, bot status
// Schema: portal/whatsapp.sql
import { Router } from "express";
import crypto from "crypto";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { bestMatch } from "./waMatch.js";
import { startInvoicePayment } from "./paymentRoutes.js";
import { converse, extraNotes, aiUsage } from "./waGemini.js";
import { searchCatalogue } from "./catalogueSearch.js";
import { saveSettings } from "./settings.js";

const APP_URL = process.env.APP_URL || "http://localhost:5174";
const LANGS = ["en", "hinglish", "hi"];
// The funnel line that goes with product photos — prices live on the portal, not in chat.
const PORTAL_LINE = {
  en: "Full range and prices here",
  hinglish: "Poora collection aur prices yahan dekhiye",
  hi: "पूरा कलेक्शन और प्राइस यहाँ देखिए",
};
const digits = (p) => String(p || "").replace(/\D/g, "");

// ---- phrase cache (every FAQ phrase; reloaded after any write) ----
let phraseCache = null;
async function phrases() {
  if (!phraseCache) phraseCache = (await query(`select faq_id, phrase from wa_faq_phrases`)).rows;
  return phraseCache;
}
const dropCache = () => { phraseCache = null; };

// Bot status is pushed by the bot; in memory is enough (it re-pushes on every change).
let botStatus = { state: "unknown", qr: null, at: null };

// Only a VERIFIED mobile unlocks account data — WhatsApp proves the sender owns
// the number, but an unverified users.mobile could be someone else's typo.
async function userByPhone(phone) {
  const last10 = digits(phone).slice(-10);
  if (last10.length < 10) return null;
  return (await query(
    `select id, name, email, status from users
      where role='client' and mobile_verified
        and regexp_replace(coalesce(mobile,''), '[^0-9]', '', 'g') like $1
      order by created_at limit 1`, ["%" + last10]
  )).rows[0] || null;
}

// Fallback when Gemini is off/failed: keep the owner's text as typed, in the one
// language it was written in (Devanagari -> Hindi, else the asker's Latin-script language).
function langColumns(text, lang) {
  const col = /[ऀ-ॿ]/.test(text) ? "hi" : (lang === "hi" ? "hinglish" : lang);
  const out = { answer_en: "", answer_hinglish: "", answer_hi: "" };
  out[`answer_${LANGS.includes(col) ? col : "hinglish"}`] = String(text).trim();
  return out;
}

// answer text in the asker's language, falling back to whichever version exists
export function pickAnswer(faq, lang) {
  const order = [lang, ...LANGS.filter((l) => l !== lang)];
  for (const l of order) if (faq[`answer_${l}`]) return faq[`answer_${l}`];
  return "";
}

// ============================================================ internal (bot)
export const waInternalRoutes = Router();

waInternalRoutes.use((req, res, next) => {
  const key = process.env.WA_INTERNAL_KEY || "";
  const got = String(req.get("x-internal-key") || "");
  const ok = key.length >= 16 && got.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
});

// Everything the menus need about one number, in one call. Also feeds the AI layer.
export async function contactFor(rawPhone) {
  {
    const phone = digits(rawPhone);
    const lang = (await query(`select lang from wa_contacts where phone=$1`, [phone])).rows[0]?.lang || null;
    const user = await userByPhone(phone);
    if (!user) return { phone, lang, user: null, sites: [], invoices: [], orders: [], app_url: APP_URL };

    const [sites, invoices, orders] = await Promise.all([
      query(
        `select e.id, e.type, e.domain, e.slug, e.status, e.expiry_date, p.name as plan
           from enrollments e left join plans p on p.id = e.plan_id
          where e.user_id=$1 and e.status <> 'rejected'
          order by e.created_at`, [user.id]),
      query(
        `select id, invoice_no, item, amount, status, created_at from invoices
          where user_id=$1 and status <> 'paid'
          order by created_at desc limit 5`, [user.id]),
      query(
        `select o.order_no, o.status, o.total, o.buyer_name, o.created_at, e.slug
           from orders o join enrollments e on e.id = o.enrollment_id
          where e.user_id=$1
          order by o.created_at desc limit 5`, [user.id]),
    ]);
    return { phone, lang, user, sites: sites.rows, invoices: invoices.rows, orders: orders.rows, app_url: APP_URL };
  }
}

waInternalRoutes.get("/contact/:phone", async (req, res) => {
  try { res.json(await contactFor(req.params.phone)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

waInternalRoutes.put("/contact/:phone/lang", async (req, res) => {
  const lang = req.body?.lang;
  if (!LANGS.includes(lang)) return res.status(400).json({ error: "bad lang" });
  await query(
    `insert into wa_contacts (phone, lang) values ($1,$2)
     on conflict (phone) do update set lang=excluded.lang, updated_at=now()`, [digits(req.params.phone), lang]);
  res.json({ ok: true });
});

// Pay0 link for one of the sender's own unpaid invoices; billing page if the gateway fails.
waInternalRoutes.post("/invoices/:id/pay-link", async (req, res) => {
  try {
    const user = await userByPhone(req.body?.phone);
    if (!user) return res.status(404).json({ error: "unknown number" });
    const inv = (await query(`select * from invoices where id=$1 and user_id=$2`, [req.params.id, user.id])).rows[0];
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "paid") return res.json({ paid: true });
    const r = await startInvoicePayment(inv).catch((e) => ({ error: e.message }));
    res.json({ url: r.payment_url || `${APP_URL}/billing` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ponytail: rows are kept, not trimmed — a few thousand short texts is nothing.
async function remember(jid, role, text) {
  if (!jid || !String(text || "").trim()) return;
  await query(`insert into wa_messages (jid, role, text) values ($1,$2,$3)`, [jid, role, String(text).slice(0, 2000)]);
}

const faqAnswer = async (id, lang) => {
  const faq = (await query(`update wa_faqs set hits = hits + 1 where id=$1 returning *`, [id])).rows[0];
  return faq ? pickAnswer(faq, lang) : null;
};

// The whole conversation. The bot posts what the client said and gets back what to
// say — or escalate:true, meaning the owner must answer this one.
// Falls back to keyword matching, then to the owner, whenever Gemini is unavailable.
waInternalRoutes.post("/reply", async (req, res) => {
  try {
    const { text, phone, jid, name } = req.body || {};
    if (!jid || !text) return res.status(400).json({ error: "jid and text required" });
    await remember(jid, "client", text);

    const [history, faqs, contact] = await Promise.all([
      query(`select role, text from (select id, role, text from wa_messages where jid=$1 order by id desc limit 13) h order by id`, [jid]),
      query(`select f.id, f.answer_en, f.answer_hinglish, f.answer_hi,
                    coalesce(array_agg(p.phrase) filter (where p.id is not null), '{}') as phrases
               from wa_faqs f left join wa_faq_phrases p on p.faq_id = f.id
              group by f.id order by f.hits desc limit 60`),
      contactFor(phone),
    ]);

    const ai = await converse({
      question: text, name,
      history: history.rows.slice(0, -1),   // the newest row is this same message
      faqs: faqs.rows, contact,
    });

    if (ai?.reply) {
      const lang = LANGS.includes(ai.lang) ? ai.lang : "hinglish";
      if (contact.phone) await query(
        `insert into wa_contacts (phone, lang) values ($1,$2)
         on conflict (phone) do update set lang=excluded.lang, updated_at=now()`, [contact.phone, lang]);

      let reply = ai.reply.trim();
      let products = [];
      // Product photos + a portal link: the funnel. No prices here — prices are on the portal.
      if (ai.action === "show_products") {
        const q = String(ai.product_query || text).slice(0, 60);
        const found = await searchCatalogue({ q, stock: "in", limit: 3 }).catch(() => ({ results: [] }));
        products = (found.results || []).filter((p) => p.image).slice(0, 3).map((p) => ({
          image: p.image,
          // Each photo links to that exact product on the portal (search prefilled with its name).
          caption: [p.name, p.brand && `Brand: ${p.brand}`, p.sizes?.length && `Sizes: ${p.sizes.slice(0, 8).join(", ")}`,
                    p.catName && `Category: ${p.catName}`,
                    `👉 ${APP_URL}/?q=${encodeURIComponent(p.name || q)}`].filter(Boolean).join("\n"),
        }));
        reply += `\n\n${PORTAL_LINE[lang] || PORTAL_LINE.hinglish} 👉 ${APP_URL}/?q=${encodeURIComponent(q)}`;
      }
      if (ai.action === "pay_link" && contact.invoices?.length) {
        const inv = (await query(`select * from invoices where id=$1`, [contact.invoices[0].id])).rows[0];
        const r = inv ? await startInvoicePayment(inv).catch(() => ({})) : {};
        reply += `\n${r.payment_url || `${APP_URL}/billing`}`;
      }
      if (!ai.escalate) {
        await remember(jid, "us", reply);
        // Logged so the owner can see in the portal what the assistant said on its own.
        await query(
          `insert into wa_questions (phone, jid, user_id, name, text, lang, status, answer, source, answered_at)
           values ($1,$2,$3,$4,$5,$6,'answered',$7,'ai', now())`,
          [digits(phone), jid, contact.user?.id || null, name || null, text, lang, reply]);
        return res.json({ reply, lang, products, source: "ai" });
      }
      return res.json({ reply, lang, escalate: true, source: "ai" });
    }

    // Gemini unavailable: fall back to the owner's saved wording, else ask the owner.
    const m = bestMatch(text, await phrases());
    if (m) {
      const answer = await faqAnswer(m.faq_id, contact.lang);
      if (answer) { await remember(jid, "us", answer); return res.json({ reply: answer, faq_id: m.faq_id, source: "faq" }); }
    }
    res.json({ reply: null, escalate: true, source: "none" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the bot actually sent (owner answers, follow-ups) — keeps the memory honest.
waInternalRoutes.post("/sent", async (req, res) => {
  await remember(req.body?.jid, "us", req.body?.text);
  res.json({ ok: true });
});

waInternalRoutes.post("/questions", async (req, res) => {
  try {
    const { phone, jid, name, text, lang } = req.body || {};
    if (!jid || !text) return res.status(400).json({ error: "jid and text required" });
    const user = await userByPhone(phone);
    const q = (await query(
      `insert into wa_questions (phone, jid, user_id, name, text, lang)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [digits(phone), jid, user?.id || null, name || null, text, LANGS.includes(lang) ? lang : "hinglish"]
    )).rows[0];
    res.json({ id: q.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

waInternalRoutes.patch("/questions/:id", async (req, res) => {
  await query(`update wa_questions set owner_msg_id=$1 where id=$2`, [req.body?.owner_msg_id || null, req.params.id]);
  res.json({ ok: true });
});

// Owner answered. Body: { id | owner_msg_id } + one of { text } | { faq_id } | { skip } | { text, fix }.
// text -> Gemini tidies it and writes all three languages -> new FAQ (its phrase =
// the asker's words). faq_id -> the asker's words become a new phrase of that FAQ.
// fix -> rewrite the answer of an already-answered question (no message to the client).
waInternalRoutes.post("/answer", async (req, res) => {
  try {
    const { id, owner_msg_id, text, faq_id, skip, fix } = req.body || {};
    const q = (await query(
      id ? `select * from wa_questions where id=$1` : `select * from wa_questions where owner_msg_id=$1`,
      [id || owner_msg_id || ""]
    )).rows[0];
    if (!q) return res.status(404).json({ error: "question not found" });

    if (fix) {
      if (!String(text || "").trim()) return res.status(400).json({ error: "empty correction" });
      const versions = langColumns(text, q.lang);   // sent exactly as the owner typed it
      const faq = q.faq_id
        ? (await query(`update wa_faqs set answer_en=$1, answer_hinglish=$2, answer_hi=$3, updated_at=now() where id=$4 returning *`,
            [versions.answer_en, versions.answer_hinglish, versions.answer_hi, q.faq_id])).rows[0]
        : (await query(`insert into wa_faqs (answer_en, answer_hinglish, answer_hi) values ($1,$2,$3) returning *`,
            [versions.answer_en, versions.answer_hinglish, versions.answer_hi])).rows[0];
      if (!q.faq_id) await query(`insert into wa_faq_phrases (faq_id, phrase) values ($1,$2)`, [faq.id, q.text]);
      const answer = pickAnswer(faq, q.lang);
      await query(`update wa_questions set faq_id=$1, answer=$2, source='owner' where id=$3`, [faq.id, answer, q.id]);
      dropCache();
      return res.json({ question: q, answer, faq_id: faq.id, versions, fixed: true });
    }

    if (q.status !== "pending") return res.status(409).json({ error: `#${q.id} already ${q.status} — use "#${q.id} fix <text>" to correct it` });

    if (skip) {
      await query(`update wa_questions set status='skipped', answered_at=now() where id=$1`, [q.id]);
      return res.json({ question: q, answer: null });
    }

    let faq, versions = null;
    if (faq_id) {
      faq = (await query(`select * from wa_faqs where id=$1`, [faq_id])).rows[0];
      if (!faq) return res.status(404).json({ error: `FAQ ${faq_id} not found` });
    } else {
      if (!String(text || "").trim()) return res.status(400).json({ error: "empty answer" });
      versions = langColumns(text, q.lang);          // owner's words, never rewritten
      faq = (await query(`insert into wa_faqs (answer_en, answer_hinglish, answer_hi) values ($1,$2,$3) returning *`,
        [versions.answer_en, versions.answer_hinglish, versions.answer_hi])).rows[0];
    }
    await query(`insert into wa_faq_phrases (faq_id, phrase) values ($1,$2)`, [faq.id, q.text]);
    const answer = pickAnswer(faq, q.lang);
    await query(
      `update wa_questions set status='answered', faq_id=$1, answer=$2, source='owner', answered_at=now() where id=$3`,
      [faq.id, answer, q.id]);
    dropCache();
    res.json({ question: q, answer, faq_id: faq.id, versions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- chats: which conversations the bot may take part in, and follow-up timing ----

// One message in or out. Creates the chat on first contact (client- or owner-started).
// Returns the chat as it was BEFORE this event, so the bot can tell a starter
// message (no client reply yet) from the owner stepping into a live conversation.
waInternalRoutes.post("/chats/event", async (req, res) => {
  try {
    const { jid, dir } = req.body || {};
    const phone = digits(req.body?.phone);
    if (!jid || !["in", "out"].includes(dir)) return res.status(400).json({ error: "jid and dir required" });
    let chat = (await query(
      `select c.*, ct.lang from wa_chats c left join wa_contacts ct on ct.phone = c.phone
        where c.jid=$1 or ($2 <> '' and c.phone=$2)
        order by (c.status='legacy') desc, (c.jid=$1) desc limit 1`, [jid, phone])).rows[0];
    const created = !chat;
    if (!chat) {
      chat = (await query(
        `insert into wa_chats (jid, phone, started_by) values ($1,$2,$3)
         on conflict (jid) do update set phone=excluded.phone returning *`,
        [jid, phone, dir === "out" ? "owner" : "client"])).rows[0];
    }
    if (chat.status === "active") {
      await query(
        dir === "in"
          ? `update wa_chats set last_in_at=now(), followups=0, phone=coalesce(nullif($2,''), phone) where jid=$1`
          : `update wa_chats set last_out_at=now(), phone=coalesce(nullif($2,''), phone) where jid=$1`,
        [chat.jid, phone]);
    }
    res.json({ chat, created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// History sync at link time: every chat that existed before GO_LIVE. Never messaged.
waInternalRoutes.post("/chats/legacy", async (req, res) => {
  try {
    const chats = (Array.isArray(req.body?.chats) ? req.body.chats : []).filter((c) => c?.jid);
    for (const c of chats) {
      await query(
        // do nothing on conflict: never flip a chat the bot already knows (or you turned "on") back to legacy
        `insert into wa_chats (jid, phone, status) values ($1,$2,'legacy')
         on conflict (jid) do nothing`, [c.jid, digits(c.phone)]);
    }
    res.json({ ok: true, count: chats.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Owner "on/off <number>" and client opt-out. Body: { jid? | phone? , status?, opted_out? }
waInternalRoutes.post("/chats/set", async (req, res) => {
  try {
    const { jid, status, opted_out } = req.body || {};
    const last10 = digits(req.body?.phone).slice(-10);
    const where = jid ? `jid=$1` : `right(phone, 10)=$1`;
    const key = jid || last10;
    if (!key) return res.status(400).json({ error: "jid or phone required" });
    const sets = [];
    const vals = [key];
    if (["active", "off"].includes(status)) { vals.push(status); sets.push(`status=$${vals.length}`, "followups=0"); }
    if (typeof opted_out === "boolean") { vals.push(opted_out); sets.push(`opted_out=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: "nothing to set" });
    let rows = (await query(`update wa_chats set ${sets.join(", ")} where ${where} returning jid`, vals)).rows;
    // "on <number>" for someone the bot has never seen: create it so their next message is answered.
    if (!rows.length && status === "active" && !jid && last10.length === 10) {
      rows = (await query(`insert into wa_chats (jid, phone, started_by) values ($1,$2,'owner') returning jid`,
        [`91${last10}@s.whatsapp.net`, `91${last10}`])).rows;
    }
    res.json({ updated: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chats where WE spoke last and the client has been quiet for `days`. Skips chats
// that are waiting on the owner (a pending question) — nudging those would be rude.
waInternalRoutes.get("/chats/due", async (req, res) => {
  try {
    const days = Math.max(1, Number(req.query.days) || 2);
    const max = Math.max(1, Number(req.query.max) || 2);
    const rows = (await query(
      `select c.jid, c.phone, c.followups, coalesce(ct.lang, 'hinglish') as lang
         from wa_chats c left join wa_contacts ct on ct.phone = c.phone
        where c.status='active' and not c.opted_out and c.followups < $2
          and c.last_out_at is not null
          and (c.last_in_at is null or c.last_out_at > c.last_in_at)
          and c.last_out_at < now() - make_interval(days => $1)
          and not exists (select 1 from wa_questions q where q.jid=c.jid and q.status='pending')
        order by c.last_out_at limit 30`, [days, max])).rows;
    res.json({ chats: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

waInternalRoutes.post("/chats/followed-up", async (req, res) => {
  await query(`update wa_chats set followups=followups+1, last_out_at=now() where jid=$1`, [req.body?.jid || ""]);
  res.json({ ok: true });
});

// Escalations the owner hasn't answered for `hours` — for the daily reminder.
waInternalRoutes.get("/questions/stale", async (req, res) => {
  const hours = Math.max(1, Number(req.query.hours) || 24);
  const rows = (await query(
    `select id, name, phone, text, created_at from wa_questions
      where status='pending' and created_at < now() - make_interval(hours => $1)
      order by created_at limit 20`, [hours])).rows;
  res.json({ questions: rows });
});

waInternalRoutes.post("/bot-status", (req, res) => {
  botStatus = { state: String(req.body?.state || "unknown"), qr: req.body?.qr || null, at: new Date().toISOString() };
  res.json({ ok: true });
});

// ============================================================ admin (portal)
export const waAdminRoutes = Router();
waAdminRoutes.use(requireAuth, requireAdmin);

waAdminRoutes.get("/status", (req, res) => res.json({ ...botStatus, ai: aiUsage() }));

// Extra notes added on top of portal/kartify-guide.md (the assistant's main knowledge).
waAdminRoutes.get("/business", async (req, res) => {
  res.json({ notes: await extraNotes() });
});

waAdminRoutes.put("/business", async (req, res) => {
  try {
    await saveSettings("wa_business", { profile: String(req.body?.notes ?? req.body?.profile ?? "").trim() });
    res.json({ notes: await extraNotes() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

waAdminRoutes.get("/faqs", async (req, res) => {
  try {
    const rows = (await query(
      `select f.*, coalesce(array_agg(p.phrase order by p.id) filter (where p.id is not null), '{}') as phrases
         from wa_faqs f left join wa_faq_phrases p on p.faq_id = f.id
        group by f.id order by f.id desc`)).rows;
    res.json({ faqs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function saveFaq(id, body) {
  const phrasesIn = (Array.isArray(body.phrases) ? body.phrases : []).map((p) => String(p).trim()).filter(Boolean);
  const vals = LANGS.map((l) => String(body[`answer_${l}`] || "").trim());
  if (!vals.some(Boolean)) throw Object.assign(new Error("Write the answer in at least one language"), { status: 400 });
  if (!phrasesIn.length) throw Object.assign(new Error("Add at least one question phrase"), { status: 400 });
  const faq = id
    ? (await query(`update wa_faqs set answer_en=$1, answer_hinglish=$2, answer_hi=$3, updated_at=now() where id=$4 returning *`, [...vals, id])).rows[0]
    : (await query(`insert into wa_faqs (answer_en, answer_hinglish, answer_hi) values ($1,$2,$3) returning *`, vals)).rows[0];
  if (!faq) throw Object.assign(new Error("FAQ not found"), { status: 404 });
  await query(`delete from wa_faq_phrases where faq_id=$1`, [faq.id]);
  await query(`insert into wa_faq_phrases (faq_id, phrase) select $1, unnest($2::text[])`, [faq.id, phrasesIn]);
  dropCache();
  return faq;
}

waAdminRoutes.post("/faqs", async (req, res) => {
  try { res.json({ faq: await saveFaq(null, req.body || {}) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

waAdminRoutes.put("/faqs/:id", async (req, res) => {
  try { res.json({ faq: await saveFaq(req.params.id, req.body || {}) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

waAdminRoutes.delete("/faqs/:id", async (req, res) => {
  await query(`delete from wa_faqs where id=$1`, [req.params.id]);
  dropCache();
  res.json({ ok: true });
});

waAdminRoutes.get("/questions", async (req, res) => {
  const status = ["pending", "answered", "skipped"].includes(req.query.status) ? req.query.status : "pending";
  const rows = (await query(
    `select q.*, u.email from wa_questions q left join users u on u.id = q.user_id
      where q.status=$1 order by q.created_at desc limit 200`, [status])).rows;
  res.json({ questions: rows });
});

// "Test the matcher" box in the admin screen.
waAdminRoutes.post("/test-match", async (req, res) => {
  const m = bestMatch(req.body?.text, await phrases());
  res.json(m || { faq_id: null });
});
