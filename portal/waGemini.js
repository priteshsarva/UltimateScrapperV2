// Gemini layer for the WhatsApp bot. Two jobs, both optional — if the key is
// missing, the quota is spent or Google errors, everything falls back to the
// plain keyword matching + "ask the owner" flow.
//   1. answerWithAi()  — a question the keyword matcher missed: pick a saved
//      answer, or answer from the business profile + that client's own data.
//   2. polish()        — the owner's typed answer: fix spelling/grammar and
//      write it in all three languages before it's saved as a FAQ.
// The business profile is admin-editable (app_settings key 'wa_business').
import { query } from "./db.js";

// flash-lite: the free tier allows many more requests per minute than plain
// "gemini-flash-latest" (which currently maps to a model capped at 5/min).
const MODEL = process.env.WA_GEMINI_MODEL || "gemini-flash-lite-latest";
const DAILY_MAX = Number(process.env.WA_AI_DAILY_MAX || 400);   // free-tier guard
const TIMEOUT_MS = 20000;

// Shown in the admin screen when nothing is saved yet — edit it there, not here.
export const DEFAULT_PROFILE = `Kartify (thekartify.com) — we run online clothing/footwear stores for shop owners in India.
What we do:
- Hosted online store: we build and host the store at <name>.thekartify.com, or on your own domain.
- Products: we supply the catalogue from our verified sources. The owner picks categories; products, photos and prices update automatically.
- WooCommerce plugin: if the owner already has a WordPress site, our plugin pulls the same products into it.
- Orders come to the store owner over WhatsApp; payment by UPI.
Plans: Free (try it), Standard ₹4000/month (full store), Search the product ₹100/month (catalogue search only).
Getting started: sign up on the portal, pick a plan and categories, we approve the store, it goes live the same day.
We do not hold stock for the owner; we ship from our sources after an order is confirmed.`;

let used = { date: "", n: 0 };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function spend() {
  if (used.date !== today()) used = { date: today(), n: 0 };
  if (used.n >= DAILY_MAX) return false;
  used.n++;
  return true;
}
export const aiUsage = () => ({ ...used, max: DAILY_MAX, enabled: !!process.env.GEMINI_API_KEY });

export async function businessProfile() {
  try {
    const row = (await query(`select value from app_settings where key='wa_business'`)).rows[0];
    return (row?.value?.profile || "").trim() || DEFAULT_PROFILE;
  } catch { return DEFAULT_PROFILE; }
}

// One Gemini call -> parsed JSON, or null on any problem (never throws).
// 503/429 ("high demand") is common and clears in a second, so it gets one retry.
async function ask(prompt, retry = true) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !spend()) return null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 800 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("[wa-ai]", r.status, j?.error?.message || "");
      if (retry && (r.status === 503 || r.status === 429)) {
        await new Promise((s) => setTimeout(s, 1500));
        return ask(prompt, false);
      }
      return null;
    }
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return text ? JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")) : null;
  } catch (e) { console.error("[wa-ai]", e.message); return null; }
}

const LANG_NAME = { en: "English", hinglish: "Hinglish (Hindi written in English letters)", hi: "Hindi (Devanagari)" };

// Compact, readable facts about the sender. Option A: the model sees the
// client's own account so it can answer "when does my plan expire" style questions.
function clientFacts(contact) {
  if (!contact?.user) return "This number is NOT linked to a verified account. Do not invent account details.";
  const l = [`Name: ${contact.user.name || "unknown"}`, `Email: ${contact.user.email || "none"}`];
  for (const s of contact.sites || []) l.push(`Store: ${s.slug || s.domain} (${s.type}), status ${s.status}${s.plan ? `, plan ${s.plan}` : ""}, expires ${s.expiry_date || "n/a"}`);
  for (const i of contact.invoices || []) l.push(`Unpaid invoice ${i.invoice_no || ""}: ${i.item} ₹${i.amount} (${i.status})`);
  for (const o of (contact.orders || []).slice(0, 3)) l.push(`Order ${o.order_no}: ${o.status}, ₹${o.total}, ${o.buyer_name}`);
  return l.join("\n");
}

// faqs: [{ id, phrases[], answer_en, answer_hinglish, answer_hi }]
// -> { faq_id } | { answer } | null (null = hand it to the owner)
export async function answerWithAi({ question, lang, faqs, contact }) {
  const list = faqs.slice(0, 80).map((f) =>
    `#${f.id} asked as: ${(f.phrases || []).join(" | ").slice(0, 200)}\n   answer: ${(f.answer_hinglish || f.answer_en || f.answer_hi || "").slice(0, 300)}`
  ).join("\n");

  const out = await ask(
`You are the WhatsApp support assistant for this business. Reply like a helpful Indian shop owner: short, warm, WhatsApp-style, 1-4 sentences, no markdown headings.

BUSINESS
${await businessProfile()}

SAVED ANSWERS (the owner's own words — prefer these)
${list || "(none yet)"}

THIS CLIENT
${clientFacts(contact)}

RULES
- Use ONLY the business description, the saved answers and this client's facts above.
- Never invent prices, discounts, refund terms, delivery dates or promises.
- If a saved answer fits, return its id in use_faq and leave answer empty.
- If the question is about this client's account, answer from their facts.
- If the question is not covered, or asks for a decision only the owner can make, set confident=false.
- Discounts, price negotiation, refunds, complaints, custom deals and deadlines are ALWAYS confident=false — the owner handles those, so do not accept or refuse them yourself.
- Write the answer in ${LANG_NAME[lang] || LANG_NAME.hinglish}.

CLIENT'S QUESTION
"${question}"

Return JSON: {"use_faq": <id or null>, "answer": "<text or empty>", "confident": <true|false>}`);

  if (!out) return null;
  if (out.use_faq && faqs.some((f) => f.id === Number(out.use_faq))) return { faq_id: Number(out.use_faq) };
  if (out.confident && String(out.answer || "").trim()) return { answer: String(out.answer).trim() };
  return null;
}

// The owner's raw answer -> tidy text in all three languages.
// Returns null on failure; the caller then saves the raw text as typed.
export async function polish({ text, lang }) {
  const out = await ask(
`The shop owner typed this reply to a customer on WhatsApp. Clean it up and write it in three languages.

BUSINESS
${await businessProfile()}

OWNER'S REPLY (may have typos or shorthand; it was meant as ${LANG_NAME[lang] || "Hinglish"})
"${text}"

RULES
- Keep the owner's meaning and any numbers/links EXACTLY as given. Never add facts, offers or promises.
- Fix spelling and grammar, make it polite and clear, WhatsApp style, 1-4 sentences.
- hinglish = Hindi written in English letters (natural, not a literal translation).

Return JSON: {"en": "...", "hinglish": "...", "hi": "..."}`);

  if (!out) return null;
  const pick = (v) => String(v || "").trim();
  const r = { answer_en: pick(out.en), answer_hinglish: pick(out.hinglish), answer_hi: pick(out.hi) };
  return (r.answer_en || r.answer_hinglish || r.answer_hi) ? r : null;
}
