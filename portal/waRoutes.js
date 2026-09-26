// WhatsApp support bot — backend side. The bot itself (whatsapp-bot/, separate
// server) owns the WhatsApp connection and menus; everything it knows comes from here.
//   app.use("/internal/wa", waInternalRoutes)   bot -> backend, x-internal-key = WA_INTERNAL_KEY
//   app.use("/portal/admin/wa", waAdminRoutes)  admin screen: FAQs, pending questions, bot status
// Schema: portal/whatsapp.sql
import { Router } from "express";
import crypto from "crypto";
import { query } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { bestMatch, worthLearning, isStalling, isOneOff } from "./waMatch.js";
import { startInvoicePayment } from "./paymentRoutes.js";
import { converse, draftReply, reengage, openerFor, extraNotes, aiUsage } from "./waGemini.js";
import { searchCatalogue } from "./catalogueSearch.js";
import { createDemoStore, expireDemos, liveDemos, DEMO_DAYS } from "./waDemo.js";
import { saveSettings } from "./settings.js";

const APP_URL = process.env.APP_URL || "http://localhost:5174";
const LANGS = ["en", "hinglish", "hi"];
// The funnel line that goes with product photos — prices live on the portal, not in chat.
const PORTAL_LINE = {
  en: "Full range and prices here",
  hinglish: "Poora collection aur prices yahan dekhiye",
  hi: "पूरा कलेक्शन और प्राइस यहाँ देखिए",
};
// Asked for a product and nothing in stock came back: say so, never "haan ji, yeh dekhiye".
const NOT_FOUND_LINE = {
  en: "Can't see that in stock right now — have a look at the full range here",
  hinglish: "Yeh abhi stock me nahi dikh raha — poora collection yahan dekh lijiye",
  hi: "यह अभी स्टॉक में नहीं दिख रहा — पूरा कलेक्शन यहाँ देखिए",
};
const digits = (p) => String(p || "").replace(/\D/g, "");
// What the bot escalates for a voice note / image with no caption: "[voice note]".
const isMediaPlaceholder = (t) => /^\[[^\]]*\]$/.test(String(t || "").trim());
// waGemini results come back as a plain string or as { reply | message, partial }.
const textOf = (x) => String(typeof x === "string" || x instanceof String ? x : x?.reply ?? x?.message ?? "").trim();

// Express 4 doesn't catch a rejected async handler, and Node exits on an unhandled
// rejection — one Supabase blip in any route would take the whole backend (scraper,
// sync-feed) down with it. Routes without their own try/catch go through this.
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(`[wa] ${req.method} ${req.originalUrl}`, e.message);
  if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
});

// ---- phrase cache (every FAQ phrase; reloaded after any write) ----
let phraseCache = null;
async function phrases() {
  // weight 1.1 for the owner's own answers: on a close match, their wording wins.
  if (!phraseCache) phraseCache = (await query(
    `select p.faq_id, p.phrase, case when f.source='owner' then 1.1 else 1 end as weight
       from wa_faq_phrases p join wa_faqs f on f.id = p.faq_id`)).rows;
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

waInternalRoutes.put("/contact/:phone/lang", wrap(async (req, res) => {
  const lang = req.body?.lang;
  if (!LANGS.includes(lang)) return res.status(400).json({ error: "bad lang" });
  await query(
    `insert into wa_contacts (phone, lang) values ($1,$2)
     on conflict (phone) do update set lang=excluded.lang, updated_at=now()`, [digits(req.params.phone), lang]);
  res.json({ ok: true });
}));

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

// What the assistant picked up about this person. Only ever fills blanks in or
// updates with something new — a later message must not wipe what we already knew.
const LEAD_FIELDS = ["name", "business", "city", "sells", "shops", "online_already", "email", "socials", "suppliers", "budget_hint", "intent",
  "store_name", "supplier_links", "whatsapp_for_orders", "own_domain", "upi_id", "plan_interest"];
// The model sees only the last few messages, so a lead who asked the price yesterday and
// says "hi" today could be scored cold — and drop out of the owner's digest. A score set in
// the last 72 hours only ever goes up (hot stays hot). score_at, not updated_at: updated_at
// moves on every message, which would hold an old score for as long as they keep chatting.
const RANK = (s) => `array_position(array['cold','warm','hot'], ${s})`;
const KEEP_SCORE = `(wa_leads.score_at > now() - interval '72 hours'
                     and ${RANK("wa_leads.score")} > ${RANK("excluded.score")})`;
async function saveLead(phone, jid, ai) {
  const p = digits(phone);
  if (!p || !ai?.lead) return;
  const vals = LEAD_FIELDS.map((f) => String(ai.lead[f] || "").trim().slice(0, 300) || null);
  const score = ["hot", "warm", "cold"].includes(ai.score) ? ai.score : "cold";
  const STAGES = ["new", "talking", "demo_offered", "demo_yes", "details", "ready", "not_interested"];
  const stage = STAGES.includes(ai.stage) ? ai.stage : null;
  // The funnel only moves forward (except a clear "not interested"), so one vague message
  // can't drag someone who already gave their details back to "talking".
  const RANK = `array_position($${LEAD_FIELDS.length + 5}::text[], excluded.stage) >= array_position($${LEAD_FIELDS.length + 5}::text[], wa_leads.stage)`;
  await query(
    `insert into wa_leads (phone, jid, ${LEAD_FIELDS.join(", ")}, score, score_reason, score_at, stage)
     values ($1,$2,${LEAD_FIELDS.map((_, i) => `$${i + 3}`).join(",")},$${LEAD_FIELDS.length + 3},$${LEAD_FIELDS.length + 4}, now(), coalesce($${LEAD_FIELDS.length + 6},'new'))
     on conflict (phone) do update set
       ${LEAD_FIELDS.map((f) => `${f} = coalesce(excluded.${f}, wa_leads.${f})`).join(", ")},
       score = case when ${KEEP_SCORE} then wa_leads.score else excluded.score end,
       score_reason = case when ${KEEP_SCORE} then wa_leads.score_reason else excluded.score_reason end,
       score_at = case when ${KEEP_SCORE} then wa_leads.score_at else now() end,
       stage = case when excluded.stage is null then wa_leads.stage
                    when excluded.stage = 'not_interested' or ${RANK} then excluded.stage
                    else wa_leads.stage end,
       jid = coalesce(excluded.jid, wa_leads.jid), updated_at = now()`,
    [p, jid || null, ...vals, score, String(ai.score_reason || "").slice(0, 300) || null, STAGES, stage]);
}

// Remember a good AI answer so the bot can still reply when Gemini is down.
// Only general questions are kept — anything tied to one person (their account, their
// numbers, their name) would be wrong for the next person who asks. An answer we already
// have just gains a new phrasing.
async function learnFromAi({ question, answer, lang, action, names }) {
  const q = String(question || "").trim();
  if (!worthLearning({ question: q, answer: String(answer || ""), action, names })) return;

  const m = bestMatch(q, await phrases());
  if (m) {                                                 // known question, new wording
    const dup = (await query(`select 1 from wa_faq_phrases where faq_id=$1 and lower(phrase)=lower($2)`, [m.faq_id, q])).rows[0];
    if (!dup) { await query(`insert into wa_faq_phrases (faq_id, phrase) values ($1,$2)`, [m.faq_id, q]); dropCache(); }
    return;
  }
  const col = LANGS.includes(lang) ? lang : "hinglish";
  const faq = (await query(`insert into wa_faqs (answer_${col}, source) values ($1,'ai') returning id`, [answer])).rows[0];
  await query(`insert into wa_faq_phrases (faq_id, phrase) values ($1,$2)`, [faq.id, q]);
  dropCache();
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

    const [history, faqs, contact, lead] = await Promise.all([
      // Only today's thread: a conversation from days ago is a different conversation,
      // and dragging its tone (or the old menu bot's) into a fresh chat reads badly.
      query(`select role, text from (
               select id, role, text from wa_messages
                where jid=$1 and created_at > now() - interval '20 hours'
                order by id desc limit 9) h order by id`, [jid]),
      // The prompt calls these "the owner's own saved answers": the owner's rows go first and
      // always fit; answers the bot learned from its own chats are capped at 10 and marked.
      query(`select * from (
               select f.id, f.source, f.hits, f.answer_en, f.answer_hinglish, f.answer_hi,
                      coalesce(array_agg(p.phrase) filter (where p.id is not null), '{}') as phrases,
                      row_number() over (partition by f.source order by f.hits desc, f.id desc) as n
                 from wa_faqs f left join wa_faq_phrases p on p.faq_id = f.id
                group by f.id) x
              where source = 'owner' or n <= 10
              order by (source = 'owner') desc, hits desc, id desc limit 60`),
      contactFor(phone),
      // What we already learned about them, from earlier days too: the history above is only
      // today's few messages, so without this the model re-asks and re-scores from scratch.
      query(`select ${LEAD_FIELDS.join(", ")}, score from wa_leads where phone=$1`, [digits(phone)]),
    ]);
    const LEARNED = "[learned from an earlier chat, NOT the owner's words — the guide wins] ";
    const savedFaqs = faqs.rows.map((f) => f.source === "owner" ? f : {
      ...f, ...Object.fromEntries(LANGS.map((l) => [`answer_${l}`, f[`answer_${l}`] && LEARNED + f[`answer_${l}`]])),
    });

    const ai = await converse({
      question: text, name,
      history: history.rows.slice(0, -1),   // the newest row is this same message
      faqs: savedFaqs, contact,
      lead: lead.rows[0],                     // undefined for someone new
    });

    // Gemini answered. An escalation now comes back with an EMPTY reply on purpose (the
    // assistant stays silent instead of saying "let me check"), so test for the object,
    // not the text — otherwise escalations fall into the Gemini-is-down branch below.
    if (ai && (String(ai.reply || "").trim() || ai.escalate)) {
      // ai.partial: the answer was cut off and only the reply was salvaged — its lang,
      // lead and score are missing, so what we already know about them is kept as is.
      const lang = LANGS.includes(ai.lang) ? ai.lang : (contact.lang || "hinglish");
      const score = ["hot", "warm", "cold"].includes(ai.score) ? ai.score : null;
      if (contact.phone && !ai.partial && LANGS.includes(ai.lang)) await query(
        `insert into wa_contacts (phone, lang) values ($1,$2)
         on conflict (phone) do update set lang=excluded.lang, updated_at=now()`, [contact.phone, lang]);

      if (!ai.partial) saveLead(phone, jid, ai).catch((e) => console.error("lead", e.message));
      // The model sometimes answers with "team se confirm karke batata hoon" instead of
      // escalating. That line is never sent: it becomes a silent hand-off to the owner.
      if (!ai.escalate && isStalling(ai.reply)) {
        console.log(`[wa] dropped a stalling reply, handing to owner: "${String(ai.reply).slice(0, 80)}"`);
        ai.escalate = true;
      }
      if (ai.escalate) return res.json({ reply: "", lang, escalate: true, score, source: "ai" });
      let reply = String(ai.reply).trim();
      let products = [];
      const linkedRecently = history.rows.slice(-4).some((h) => h.role === "us" && h.text.includes("://"));
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
        // The model wrote its line before the search ran. Nothing found: that "haan ji, yeh
        // dekhiye" would promise something we don't have, so it's replaced outright.
        if (!products.length)
          reply = `${NOT_FOUND_LINE[lang] || NOT_FOUND_LINE.hinglish} 👉 ${APP_URL}/?q=${encodeURIComponent(q)}`;
        // The photos already carry a link each — only add the "whole range" line if we
        // haven't just sent a link, so the chat doesn't turn into link spam.
        else if (!linkedRecently && !reply.includes("://"))
          reply += `\n\n${PORTAL_LINE[lang] || PORTAL_LINE.hinglish} 👉 ${APP_URL}/?q=${encodeURIComponent(q)}`;
      }
      // They said yes and we have enough to build it: make the real store now and put the
      // link in this same message. A demo promised is worth nothing; a demo they can open is.
      if (ai.action === "create_demo") {
        const d = await createDemoStore({
          phone, name: ai.lead?.name || name, store_name: ai.lead?.store_name,
          sells: ai.lead?.sells, whatsapp: ai.lead?.whatsapp_for_orders, city: ai.lead?.city,
        }).catch((e) => { console.error("[wa-demo]", e.message); return null; });
        if (d) reply += `\n${d.url}`;
        else reply += `\n${APP_URL}`;   // couldn't build it — never leave them with nothing
      }
      if (ai.action === "pay_link" && contact.invoices?.length) {
        const inv = (await query(`select * from invoices where id=$1`, [contact.invoices[0].id])).rows[0];
        const r = inv ? await startInvoicePayment(inv).catch(() => ({})) : {};
        reply += `\n${r.payment_url || `${APP_URL}/billing`}`;
      }
      // Not written to the chat memory here: the bot posts /sent once it has actually
      // delivered it — the owner may step in first and the reply is then dropped.
      // Logged so the owner can see in the portal what the assistant said on its own.
      await query(
        `insert into wa_questions (phone, jid, user_id, name, text, lang, status, answer, source, answered_at)
         values ($1,$2,$3,$4,$5,$6,'answered',$7,'ai', now())`,
        [digits(phone), jid, contact.user?.id || null, name || null, text, lang, reply]);
      // Keep it as a saved answer, so this question survives the next Gemini outage.
      if (!ai.partial) learnFromAi({ question: text, answer: reply, lang, action: ai.action,
        names: [name, ai.lead?.name, contact.user?.name] }).catch((e) => console.error("learn", e.message));
      return res.json({ reply, lang, products, score, source: "ai" });
    }

    // Gemini unavailable: fall back to the owner's saved wording, else ask the owner.
    const m = bestMatch(text, await phrases());
    if (m) {
      const answer = await faqAnswer(m.faq_id, contact.lang);
      // an old saved answer that just stalls is worse than the silent hand-off below
      if (answer && !isStalling(answer)) return res.json({ reply: answer, faq_id: m.faq_id, source: "faq" });   // memory via /sent
    }
    res.json({ reply: null, escalate: true, source: "none" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Forget a chat's conversation so the next message starts clean (owner: "reset <number>").
waInternalRoutes.post("/forget", async (req, res) => {
  try {
    const last10 = digits(req.body?.phone).slice(-10);
    const jids = req.body?.jid ? [req.body.jid]
      : (await query(`select jid from wa_chats where right(phone,10)=$1`, [last10])).rows.map((r) => r.jid);
    if (!jids.length) return res.json({ cleared: 0 });
    const r = await query(`delete from wa_messages where jid = any($1)`, [jids]);
    res.json({ cleared: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// What the bot actually delivered (AI and saved-answer replies, owner answers, follow-ups) —
// the only way a "us" line enters the memory, so it never holds a line the client didn't get.
waInternalRoutes.post("/sent", wrap(async (req, res) => {
  await remember(req.body?.jid, "us", req.body?.text);
  res.json({ ok: true });
}));

waInternalRoutes.post("/questions", async (req, res) => {
  try {
    const { phone, jid, name, text, lang } = req.body || {};
    if (!jid || !text) return res.status(400).json({ error: "jid and text required" });
    // Don't ask the owner the same thing twice from the SAME chat: point at the pending
    // copy and restart its clock, so the 15-minute pick-up can fire again. Never across
    // chats (the owner's answer only reaches the first asker) and never for a media
    // placeholder like "[voice note]" — two voice notes share that text, not their content.
    const norm = String(text).toLowerCase().replace(/\s+/g, " ").trim();
    const dup = isMediaPlaceholder(norm) ? null : (await query(
      `update wa_questions set created_at=now()
        where id = (select id from wa_questions
                     where jid=$2 and status='pending' and btrim(regexp_replace(lower(text), '\\s+', ' ', 'g')) = $1
                     order by id desc limit 1)
        returning id`, [norm, jid]
    )).rows[0];
    if (dup) return res.json({ id: dup.id, duplicate: true });
    const user = await userByPhone(phone);
    const q = (await query(
      `insert into wa_questions (phone, jid, user_id, name, text, lang)
       values ($1,$2,$3,$4,$5,$6) returning id`,
      [digits(phone), jid, user?.id || null, name || null, text, LANGS.includes(lang) ? lang : "hinglish"]
    )).rows[0];
    res.json({ id: q.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

waInternalRoutes.patch("/questions/:id", wrap(async (req, res) => {
  const { owner_msg_id, draft_msg_id } = req.body || {};
  if (draft_msg_id) await query(`update wa_questions set draft_msg_id=$1 where id=$2`, [draft_msg_id, req.params.id]);
  if (owner_msg_id) await query(`update wa_questions set owner_msg_id=$1 where id=$2`, [owner_msg_id, req.params.id]);
  res.json({ ok: true });
}));

// Owner answered. Body: { id | owner_msg_id } + one of { text } | { faq_id } | { skip } | { text, fix }.
// text -> Gemini tidies it and writes all three languages -> new FAQ (its phrase =
// the asker's words). faq_id -> the asker's words become a new phrase of that FAQ.
// fix -> rewrite the answer of an already-answered question (no message to the client).
// once -> confirm and send, but never save it as an answer for everyone (a one-person reply).
waInternalRoutes.post("/answer", async (req, res) => {
  try {
    const { id, owner_msg_id, text, faq_id, skip, fix, raw, once } = req.body || {};
    const confirm = req.body?.confirm || once;
    // A plain "ok" with nothing quoted means the draft we showed them most recently
    // (draft_at), not whichever pending question happens to have the highest id.
    const q = (await query(
      id ? `select * from wa_questions where id=$1`
        : owner_msg_id ? `select * from wa_questions where owner_msg_id=$1 or draft_msg_id=$1 order by id desc limit 1`
        : `select * from wa_questions where status='pending' and draft is not null order by draft_at desc nulls last, id desc limit 1`,
      id || owner_msg_id ? [id || owner_msg_id] : []
    )).rows[0];
    if (!q) return res.status(404).json({ error: "question not found" });

    if (fix) {
      if (!String(text || "").trim()) return res.status(400).json({ error: "empty correction" });
      const versions = langColumns(text, q.lang);   // sent exactly as the owner typed it
      // A one-off (a price, a deal, "master copy") corrects this question only — it never
      // becomes, or rewrites, an answer the bot gives everyone.
      if (isOneOff({ question: q.text, answer: text }) || (!q.faq_id && isMediaPlaceholder(q.text))) {
        const answer = String(text).trim();
        await query(`update wa_questions set answer=$1, source='owner' where id=$2`, [answer, q.id]);
        return res.json({ question: q, answer, faq_id: null, versions, fixed: true, one_off: true });
      }
      // source='owner': correcting a learned answer makes it the owner's words from now on.
      const faq = q.faq_id
        ? (await query(`update wa_faqs set answer_en=$1, answer_hinglish=$2, answer_hi=$3, source='owner', updated_at=now() where id=$4 returning *`,
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

    // Every status change below claims the row with "where status='pending'": two "ok"s
    // landing together must not both send the answer (and both save a FAQ).
    const claim = async (sql, vals) => !!(await query(sql, vals)).rowCount;
    const taken = () => res.status(409).json({ error: `#${q.id} was just handled — use "#${q.id} fix <text>" to correct it` });

    if (skip) {
      if (!await claim(`update wa_questions set status='skipped', answered_at=now() where id=$1 and status='pending'`, [q.id])) return taken();
      return res.json({ question: q, answer: null });
    }

    let faq = null, versions = null, answer;
    if (faq_id) {
      faq = (await query(`select * from wa_faqs where id=$1`, [faq_id])).rows[0];
      if (!faq) return res.status(404).json({ error: `FAQ ${faq_id} not found` });
      answer = pickAnswer(faq, q.lang);
    } else {
      // Step 1: the owner's note becomes a draft message, shown to them first.
      // Their note can be the answer OR an instruction ("bol do kal ho jayega"). A note on
      // a question that already has a draft is a correction to THAT draft ("thoda short karo").
      if (!confirm) {
        if (!String(text || "").trim()) return res.status(400).json({ error: "empty answer" });
        const history = (await query(
          `select role, text from (select id, role, text from wa_messages where jid=$1 order by id desc limit 6) h order by id`,
          [q.jid])).rows;
        const draft = raw ? String(text).trim()
          : textOf(await draftReply({ note: text, question: q.text, lang: q.lang, history, previousDraft: q.draft || undefined }))
            || String(text).trim();
        await query(`update wa_questions set draft=$1, draft_at=now() where id=$2`, [draft, q.id]);
        return res.json({ question: q, draft, drafted: true });
      }
      // Step 2: confirmed — send it.
      answer = String(text || q.draft || "").trim();
      if (!answer) return res.status(400).json({ error: "nothing to send" });
      versions = langColumns(answer, q.lang);
    }
    if (!await claim(
      `update wa_questions set status='answered', answer=$1, source='owner', answered_at=now() where id=$2 and status='pending'`,
      [answer, q.id])) return taken();
    // A deal with one person (a price, a discount, "master copy hai") goes to them once
    // and is never saved — as a saved answer it would be repeated to everyone who asks.
    // Same for a reply to a bare voice note/photo: "[voice note]" is no question to match on,
    // and for "once": the owner's own say-so, for what the keyword check can't spot.
    if (once || isMediaPlaceholder(q.text) || (!faq && isOneOff({ question: q.text, answer })))
      return res.json({ question: q, answer, faq_id: faq?.id || null, versions, one_off: true });
    // The row is claimed: from here the client must get the answer. Saving it for next time
    // is a bonus — a failed write is logged, never a 500 that leaves them unanswered (a retry
    // would only hit "already answered").
    try {
      if (!faq) faq = (await query(`insert into wa_faqs (answer_en, answer_hinglish, answer_hi) values ($1,$2,$3) returning *`,
        [versions.answer_en, versions.answer_hinglish, versions.answer_hi])).rows[0];
      await query(`insert into wa_faq_phrases (faq_id, phrase) values ($1,$2)`, [faq.id, q.text]);
      await query(`update wa_questions set faq_id=$1 where id=$2`, [faq.id, q.id]);
    } catch (e) { console.error(`[wa] #${q.id} sent but not saved as an answer:`, e.message); }
    dropCache();
    res.json({ question: q, answer, faq_id: faq?.id || null, versions });
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
    // The phone is recorded whatever the status: a legacy chat stored under a LID-only id
    // has no phone, and without it "on <number>" can never find the chat to switch it on.
    await query(
      chat.status !== "active" ? `update wa_chats set phone=coalesce(nullif($2,''), phone) where jid=$1`
        : dir === "in"
          ? `update wa_chats set last_in_at=now(), followups=0, phone=coalesce(nullif($2,''), phone) where jid=$1`
          : `update wa_chats set last_out_at=now(), phone=coalesce(nullif($2,''), phone) where jid=$1`,
      [chat.jid, phone]);
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

// Owner "on/off <number>" and client opt-out. Body: { jid? | phone?, jids?, status?, opted_out? }
// jids: the number's own chat ids (phone id + private LID if WhatsApp knows it). A chat
// stored under its LID can have no phone yet — matched by phone alone, "on" would miss it
// and create a second row, while the old one keeps the client silenced.
// -> { updated: existing rows changed, created: true only when a new row had to be made }
waInternalRoutes.post("/chats/set", async (req, res) => {
  try {
    const { jid, status, opted_out } = req.body || {};
    const last10 = digits(req.body?.phone).slice(-10);
    const jids = (Array.isArray(req.body?.jids) ? req.body.jids : []).filter((j) => j && typeof j === "string");
    // the row the insert below would make — if it already exists (phone ''), it's this chat
    if (last10.length === 10) jids.push(`91${last10}@s.whatsapp.net`);
    if (!jid && !last10 && !jids.length) return res.status(400).json({ error: "jid or phone required" });
    // $1 <> '': an empty phone must not match every LID-only row that has phone ''
    const where = jid ? `jid=$1` : `(($1 <> '' and right(phone, 10)=$1) or jid = any($2::text[]))`;
    const sets = [];
    const vals = jid ? [jid] : [last10, jids];
    if (["active", "off"].includes(status)) { vals.push(status); sets.push(`status=$${vals.length}`, "followups=0"); }
    if (typeof opted_out === "boolean") { vals.push(opted_out); sets.push(`opted_out=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: "nothing to set" });
    const updated = (await query(`update wa_chats set ${sets.join(", ")} where ${where} returning jid`, vals)).rowCount;
    // "on <number>" for someone the bot has never seen: create it so their next message is answered.
    let created = false;
    if (!updated && status === "active" && !jid && last10.length === 10) {
      await query(`insert into wa_chats (jid, phone, started_by) values ($1,$2,'owner')`,
        [`91${last10}@s.whatsapp.net`, `91${last10}`]);
      created = true;
    }
    res.json({ updated, created });
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

waInternalRoutes.post("/chats/followed-up", wrap(async (req, res) => {
  await query(`update wa_chats set followups=followups+1, last_out_at=now() where jid=$1`, [req.body?.jid || ""]);
  res.json({ ok: true });
}));

// The owner marks a lead won or lost from WhatsApp ("won 98xxxxxxxx" / "lost 98xxxxxxxx"),
// so conversions can be counted against the chats that produced them.
waInternalRoutes.post("/leads/outcome", wrap(async (req, res) => {
  const last10 = digits(req.body?.phone).slice(-10);
  const outcome = ["won", "lost"].includes(req.body?.outcome) ? req.body.outcome : null;
  if (!last10 || !outcome) return res.status(400).json({ error: "phone and outcome (won|lost) required" });
  const r = await query(
    `update wa_leads set outcome=$2, outcome_at=now(), updated_at=now() where right(phone,10)=$1
      returning phone, name, business, store_name, stage`, [last10, outcome]);
  res.json({ updated: r.rowCount, lead: r.rows[0] || null });
}));

// The bot's side of the portal "Send" button: take the queued messages, then report back.
waInternalRoutes.get("/outbox", wrap(async (req, res) => {
  const rows = (await query(
    `select id, jid, phone, text from wa_outbox where status='pending' order by id limit 10`)).rows;
  res.json({ messages: rows });
}));

waInternalRoutes.post("/outbox/:id/done", wrap(async (req, res) => {
  const ok = req.body?.ok !== false;
  await query(
    `update wa_outbox set status=$2, error=$3, sent_at=now() where id=$1 and status='pending'`,
    [req.params.id, ok ? "sent" : "failed", ok ? null : String(req.body?.error || "").slice(0, 200)]);
  res.json({ ok: true });
}));

// Build a demo store by hand ("demo 98xxxxxxxx Shop Name" from the owner), and the
// housekeeping the bot's tick calls: pause the ones past their 7 days, list the live ones.
waInternalRoutes.post("/demo/create", wrap(async (req, res) => {
  const d = await createDemoStore(req.body || {});
  res.json({ ...d, days: DEMO_DAYS });
}));
waInternalRoutes.post("/demo/sweep", wrap(async (req, res) => res.json({ paused: await expireDemos() })));
waInternalRoutes.get("/demo/live", wrap(async (req, res) => res.json({ demos: await liveDemos() })));

// New/updated leads for the owner's daily digest.
waInternalRoutes.get("/leads/new", wrap(async (req, res) => {
  const hours = Math.max(1, Number(req.query.hours) || 24);
  const rows = (await query(
    `select phone, name, business, city, sells, shops, score, score_reason
       from wa_leads where updated_at > now() - make_interval(hours => $1)
      order by case score when 'hot' then 1 when 'warm' then 2 else 3 end, updated_at desc
      limit 25`, [hours])).rows;
  res.json({ leads: rows });
}));

// Used only when Gemini is down at the moment a chat needs picking back up. Each moves
// the talk to their shop instead of mentioning the wait; the first one this chat hasn't
// already been sent is used, so the same person doesn't get the same line twice.
const REENGAGE_FALLBACK = {
  hinglish: [
    "Waise aapki shop kahan hai, aur zyada customer kahan se aate hain — aas-paas se ya bahar se bhi?",
    "Ek baat batao, abhi aap WhatsApp pe products share karke bechte ho kya?",
    "Aap roz lagbhag kitne customers handle karte ho shop pe?",
  ],
  en: [
    "By the way, where's your shop, and do most customers come from nearby or further out?",
    "Quick one — do you already share products with customers on WhatsApp?",
    "Roughly how many customers do you serve in a day?",
  ],
  hi: [
    "वैसे आपकी दुकान कहाँ है, और ज़्यादातर ग्राहक आस-पास से आते हैं या दूर से भी?",
    "एक बात बताइए, क्या आप अभी WhatsApp पर प्रोडक्ट भेजकर बेचते हैं?",
    "आप रोज़ लगभग कितने ग्राहकों को संभालते हैं?",
  ],
};

// Chats left hanging: a question went to the owner `mins` ago, they haven't answered,
// and we haven't said anything since. Returns a fresh line that restarts the talk from
// another angle, so the client isn't left staring at their own message.
// Nothing is written to the chat memory here: the bot posts /sent once it has actually
// delivered the line — a line that never went out must not become "already said".
waInternalRoutes.get("/chats/reengage", async (req, res) => {
  try {
    const mins = Math.max(5, Number(req.query.mins) || 15);
    const rows = (await query(
      `select distinct on (q.jid) q.id, q.jid, q.phone, q.text, q.lang
         from wa_questions q join wa_chats c on c.jid = q.jid
        where q.status='pending' and not c.opted_out and c.status='active'
          and q.created_at < now() - make_interval(mins => $1)
          and q.created_at > now() - interval '6 hours'
          and (c.last_out_at is null or c.last_out_at < q.created_at)
          -- a line was already made for this question: if the bot never delivered it, try
          -- again after 30 minutes (not every tick), or at once if the client asked again
          and (q.reengaged_at is null or q.reengaged_at < q.created_at or q.reengaged_at < now() - interval '30 minutes')
        order by q.jid, q.id desc limit 10`, [mins])).rows.slice(0, 5);
    if (rows.length) await query(`update wa_questions set reengaged_at=now() where id = any($1)`, [rows.map((q) => q.id)]);

    // In parallel: the AI pool spreads these across keys, and ask() gives up at its own
    // deadline, so this answers well inside the bot's timeout.
    const out = (await Promise.all(rows.map(async (q) => {
      const history = (await query(
        `select role, text from (select id, role, text from wa_messages where jid=$1 order by id desc limit 8) h order by id`,
        [q.jid])).rows;
      const said = textOf(await reengage({ history, contact: await contactFor(q.phone), lang: q.lang, pendingQuestion: q.text }));
      // Gemini down too: the first fallback line this chat hasn't already been sent.
      const lines = REENGAGE_FALLBACK[q.lang] || REENGAGE_FALLBACK.hinglish;
      const fallback = lines.find((l) => !history.some((h) => h.text === l)) || lines[q.id % lines.length];
      return { jid: q.jid, text: (said && !isStalling(said) ? said : null) || fallback };   // never a "let me check" line
    }).map((p) => p.catch((e) => { console.error("[wa] reengage", e.message); return null; })))).filter(Boolean);
    res.json({ chats: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// End-of-day numbers for the owner. "Today" is the IST calendar day (the report goes out
// at 20:00 IST), not a rolling 24 hours that drags in last night; ?hours= still works.
waInternalRoutes.get("/report/today", async (req, res) => {
  try {
    const since = req.query.hours ? `now() - interval '${Math.max(1, Number(req.query.hours) || 24)} hours'`
      : `(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`;
    const one = async (sql, p = []) => (await query(sql, p)).rows;
    const [msgs] = await one(`select
        count(*) filter (where role='client')::int as incoming,
        count(*) filter (where role='us')::int as sent,
        count(distinct jid)::int as chats
      from wa_messages where created_at > ${since}`);
    // waiting_on_you counts every pending question, like the "still waiting" list below it.
    const [qs] = await one(`select
        count(*) filter (where source='ai')::int as answered_by_ai,
        count(*) filter (where source='owner' and status='answered')::int as answered_by_you,
        (select count(*) from wa_questions where status='pending')::int as waiting_on_you
      from wa_questions where created_at > ${since}`);
    // legacy rows are old chats found at link time, not new conversations
    const [chats] = await one(`select
        count(*) filter (where started_at > ${since} and status <> 'legacy')::int as new_chats,
        count(*) filter (where started_at > ${since} and started_by='owner')::int as you_started,
        count(*) filter (where opted_out)::int as opted_out_total
      from wa_chats`);
    const leads = await one(`select score, count(*)::int as n from wa_leads where updated_at > ${since} group by score`);
    // Every chat we talked in today, with what we learned and how far it got — the owner
    // wants to read the day rather than guess from counts.
    const perChat = await one(
      `select l.phone, l.name, l.business, l.city, l.sells, l.shops, l.online_already, l.suppliers,
              l.store_name, l.supplier_links, l.whatsapp_for_orders, l.own_domain, l.upi_id,
              l.plan_interest, l.intent, l.stage, l.score, l.score_reason, l.outcome,
              (select count(*) from wa_messages m where m.jid = l.jid and m.created_at > ${since})::int as msgs,
              (select text from wa_messages m where m.jid = l.jid and m.role='client'
                order by m.id desc limit 1) as last_from_them
         from wa_leads l
        where l.updated_at > ${since}
        order by case l.score when 'hot' then 1 when 'warm' then 2 else 3 end,
                 array_position(array['ready','details','demo_yes','demo_offered','talking','new','not_interested']::text[], l.stage),
                 l.updated_at desc
        limit 25`);
    const [funnel] = await one(`select
        count(*) filter (where stage in ('demo_offered','demo_yes','details','ready'))::int as demo_offered,
        count(*) filter (where stage in ('demo_yes','details','ready'))::int as demo_yes,
        count(*) filter (where stage = 'ready')::int as ready_to_build,
        count(*) filter (where outcome='won')::int as won_total,
        count(*) filter (where outcome='won' and outcome_at > ${since})::int as won_today,
        count(*) filter (where outcome='lost' and outcome_at > ${since})::int as lost_today
      from wa_leads`);
    const pending = await one(
      `select id, name, phone, text from wa_questions where status='pending' order by id desc limit 10`);
    res.json({ msgs, qs, chats, leads, funnel, perChat, pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Escalations the owner hasn't answered for `hours` — for the daily reminder.
waInternalRoutes.get("/questions/stale", wrap(async (req, res) => {
  const hours = Math.max(1, Number(req.query.hours) || 24);
  const rows = (await query(
    `select id, name, phone, text, created_at from wa_questions
      where status='pending' and created_at < now() - make_interval(hours => $1)
      order by created_at limit 20`, [hours])).rows;
  res.json({ questions: rows });
}));

waInternalRoutes.post("/bot-status", (req, res) => {
  botStatus = { state: String(req.body?.state || "unknown"), qr: req.body?.qr || null, at: new Date().toISOString() };
  res.json({ ok: true });
});

// ============================================================ admin (portal)
export const waAdminRoutes = Router();
waAdminRoutes.use(requireAuth, requireAdmin);

waAdminRoutes.get("/status", (req, res) => res.json({ ...botStatus, ai: aiUsage() }));

// Extra notes added on top of portal/kartify-guide.md (the assistant's main knowledge).
waAdminRoutes.get("/business", wrap(async (req, res) => {
  res.json({ notes: await extraNotes() });
}));

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
  // An edit in the admin screen is the owner's wording, even on a row the bot learned.
  const faq = id
    ? (await query(`update wa_faqs set answer_en=$1, answer_hinglish=$2, answer_hi=$3, source='owner', updated_at=now() where id=$4 returning *`, [...vals, id])).rows[0]
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

waAdminRoutes.delete("/faqs/:id", wrap(async (req, res) => {
  await query(`delete from wa_faqs where id=$1`, [req.params.id]);
  dropCache();
  res.json({ ok: true });
}));

waAdminRoutes.get("/questions", wrap(async (req, res) => {
  const status = ["pending", "answered", "skipped"].includes(req.query.status) ? req.query.status : "pending";
  const rows = (await query(
    `select q.*, u.email from wa_questions q left join users u on u.id = q.user_id
      where q.status=$1 order by q.created_at desc limit 200`, [status])).rows;
  res.json({ questions: rows });
}));

// The opener behind the Leads screen's "Continue on WhatsApp" button: written from THAT
// chat, not a template. Cached briefly in memory — reopening the same lead twice shouldn't
// cost two AI calls — and ?refresh=1 writes a fresh one.
const openerCache = new Map();   // phone -> { at, text }
const OPENER_TTL = 30 * 60e3;
waAdminRoutes.get("/leads/:phone/opener", wrap(async (req, res) => {
  const phone = digits(req.params.phone);
  const hit = openerCache.get(phone);
  if (hit && !req.query.refresh && Date.now() - hit.at < OPENER_TTL) return res.json({ text: hit.text, cached: true });

  const lead = (await query(`select * from wa_leads where right(phone,10)=$1 limit 1`, [phone.slice(-10)])).rows[0];
  const history = lead?.jid ? (await query(
    `select role, text from (select id, role, text from wa_messages where jid=$1 order by id desc limit 14) h order by id`,
    [lead.jid])).rows : [];
  const lang = (await query(`select lang from wa_contacts where phone=$1`, [phone])).rows[0]?.lang || "hinglish";

  const out = await openerFor({ history, contact: await contactFor(phone), lead, lang });
  if (!out?.reply) return res.json({ text: "", error: "AI is busy right now — type your own message." });
  openerCache.set(phone, { at: Date.now(), text: out.reply });
  res.json({ text: out.reply, cached: false, messages: history.length });
}));

// "Send" on the Leads screen. The backend can't reach WhatsApp — only the bot holds that
// connection — so the message is queued and the bot picks it up within seconds.
waAdminRoutes.post("/leads/:phone/send", wrap(async (req, res) => {
  const phone = digits(req.params.phone);
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "nothing to send" });
  if (phone.length < 10) return res.status(400).json({ error: "bad number" });

  // Prefer the jid we've actually been talking on (it may be a privacy @lid id).
  const known = (await query(
    `select coalesce(l.jid, c.jid) as jid from wa_leads l
       full join wa_chats c on right(c.phone,10) = right(l.phone,10)
      where right(coalesce(l.phone, c.phone),10) = $1 limit 1`, [phone.slice(-10)])).rows[0];
  const jid = known?.jid || `${phone.length === 10 ? "91" + phone : phone}@s.whatsapp.net`;

  const row = (await query(
    `insert into wa_outbox (jid, phone, text) values ($1,$2,$3) returning id`, [jid, phone, text])).rows[0];
  // The bot must be allowed to talk in that chat, or it will ignore the reply that comes back.
  await query(
    `insert into wa_chats (jid, phone, started_by) values ($1,$2,'owner')
     on conflict (jid) do update set status = case when wa_chats.status='legacy' then 'active' else wa_chats.status end,
       phone = coalesce(nullif(excluded.phone,''), wa_chats.phone)`, [jid, phone]);
  res.json({ queued: true, id: row.id });
}));

waAdminRoutes.get("/leads", wrap(async (req, res) => {
  const score = ["hot", "warm", "cold"].includes(req.query.score) ? req.query.score : null;
  const rows = (await query(
    `select * from wa_leads ${score ? "where score=$1" : ""}
      order by case score when 'hot' then 1 when 'warm' then 2 else 3 end, updated_at desc limit 300`,
    score ? [score] : [])).rows;
  res.json({ leads: rows });
}));

// "Test the matcher" box in the admin screen.
waAdminRoutes.post("/test-match", wrap(async (req, res) => {
  const m = bestMatch(req.body?.text, await phrases());
  res.json(m || { faq_id: null });
}));
