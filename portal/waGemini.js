// Gemini layer for the WhatsApp bot — it holds the whole conversation.
// No menus, no language prompt: the model reads the chat and replies like a person,
// in whatever language the client is using. Everything it may say comes from
// portal/kartify-guide.md, the owner's saved answers, and that client's own data.
// If the key is missing, the quota is spent or Google errors, the caller falls back
// to keyword matching and then to asking the owner — the bot never goes silent.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "./db.js";

// flash-lite: the free tier allows many more requests per minute than plain
// "gemini-flash-latest" (which currently maps to a model capped at 5/min).
const MODEL = process.env.WA_GEMINI_MODEL || "gemini-flash-lite-latest";
const DAILY_MAX = Number(process.env.WA_AI_DAILY_MAX || 1500);
const TIMEOUT_MS = 20000;
const GUIDE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "kartify-guide.md");

let guideCache = { at: 0, text: "" };
function guide() {
  if (Date.now() - guideCache.at > 60e3) {
    try { guideCache = { at: Date.now(), text: fs.readFileSync(GUIDE_PATH, "utf8") }; }
    catch { guideCache = { at: Date.now(), text: "" }; }
  }
  return guideCache.text;
}

// Extra notes the admin adds in the portal, appended to the guide.
export async function extraNotes() {
  try {
    const row = (await query(`select value from app_settings where key='wa_business'`)).rows[0];
    return (row?.value?.profile || "").trim();
  } catch { return ""; }
}

let used = { date: "", n: 0 };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function spend() {
  if (used.date !== today()) used = { date: today(), n: 0 };
  if (used.n >= DAILY_MAX) return false;
  used.n++;
  return true;
}
export const aiUsage = () => ({ ...used, max: DAILY_MAX, enabled: !!process.env.GEMINI_API_KEY, model: MODEL });

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
        generationConfig: { temperature: 0.7, responseMimeType: "application/json", maxOutputTokens: 900 },
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

function clientFacts(contact) {
  if (!contact?.user) return "Not a registered client yet (this number has no verified account). Treat them as a new prospect.";
  const l = [`Registered client. Name: ${contact.user.name || "unknown"}`];
  for (const s of contact.sites || []) l.push(`Store: ${s.slug || s.domain} (${s.type}), status ${s.status}${s.plan ? `, plan ${s.plan}` : ""}, expires ${s.expiry_date || "n/a"}`);
  for (const i of contact.invoices || []) l.push(`Unpaid invoice ${i.invoice_no || ""}: ${i.item} ₹${i.amount}`);
  for (const o of (contact.orders || []).slice(0, 3)) l.push(`Order ${o.order_no}: ${o.status}, ₹${o.total}`);
  return l.join("\n");
}

const PLAYBOOK = `HOW YOU TALK
- You are a real person from the Kartify team on WhatsApp. Never say you are a bot, an AI or an assistant.
- Write the way people actually write on WhatsApp: 1-3 short sentences, warm, simple, no bullet points,
  no headings, no emoji spam (one is plenty, often none), no formal letter language.
- NEVER give numbered menus or ask them to "choose an option". Just talk.
- Mirror their language and script exactly: Hinglish gets Hinglish, Hindi script gets Hindi script,
  English gets English. If they switch, you switch.
- Ask ONE question at a time, then wait. Never interrogate.
- Do not repeat a greeting in every message, and do not re-introduce yourself mid-conversation.
- Use their name rarely — at most once in a while, not in every message.

HOW YOU SELL (you are a helpful shop-owner friend, not a salesman)
- Early on, get to know them like a person: how their day/business is going, what they sell,
  where their customers come from, whether they already sell online.
- Listen for the problem behind what they say — no online presence, customers only from the local area,
  stock money stuck, no time or skill to build a site, no product photos.
- Reflect that problem back in their own words, then show what it is costing them. Do the arithmetic
  ONLY with numbers THEY gave you (for example: "20 customers a day walk past and you're only
  reaching the ones nearby"). If you have no numbers, ask for one instead of inventing any.
- Then show the other side: with a ready store they can sell beyond their area, with no stock to buy,
  no photos to shoot, and the margin they set is theirs.
- Invite the next small step: seeing a sample store, or signing up free at app.thekartify.com.

SHOWING PRODUCTS (this is the hook that gets them onto the portal)
- If they ask about any product, brand or category ("nike hai kya", "sneakers dikhao", "watches?"),
  set "action": "show_products" and put the product words in "product_query".
- Photos are attached automatically — your "reply" should just be a natural line like
  "Yeh dekhiye ji, in me se kuch" and an invitation to see the full range on the portal.
- NEVER state a product's price, not even roughly. Prices, sizes in stock and the full catalogue
  are on the portal — that is the reason for them to open it and sign up.

PRICING RULE (important)
- Do NOT mention any price, plan or cost until they ask about it.
- When they DO ask, start with the simplest option: they can start free and see the platform.
- Give the detailed plan prices only if they ask again or ask directly what it costs.
- Never offer discounts, never negotiate, never promise a delivery date or an earnings figure.

WHEN TO HAND OVER TO THE OWNER (set "escalate": true)
- Discounts, price negotiation, refunds, complaints, custom deals, anything about someone else's account.
- Anything the guide and the saved answers do not cover, or anything you are unsure about.
- When they ask to speak to a person.
- When you escalate, your "reply" should be a natural line saying you'll check with the team and
  come back shortly — never a made-up answer.`;

// history: [{ role: 'client'|'us', text }] oldest first
// -> { reply, lang, escalate, action } | null
export async function converse({ question, history = [], faqs = [], contact, name }) {
  const saved = faqs.slice(0, 60).map((f) =>
    `- asked as: ${(f.phrases || []).join(" | ").slice(0, 160)}\n  answer: ${(f.answer_hinglish || f.answer_en || f.answer_hi || "").slice(0, 300)}`
  ).join("\n");
  const chat = history.slice(-12).map((m) => `${m.role === "client" ? "THEM" : "YOU"}: ${m.text}`).join("\n");
  const notes = await extraNotes();

  return ask(
`${PLAYBOOK}

WHAT YOU KNOW ABOUT THE BUSINESS (never say anything outside this)
${guide()}
${notes ? `\nEXTRA NOTES FROM THE OWNER\n${notes}` : ""}

THE OWNER'S OWN SAVED ANSWERS (use these words when they fit)
${saved || "(none yet)"}

WHO YOU ARE TALKING TO
${name ? `WhatsApp name: ${name}\n` : ""}${clientFacts(contact)}

CONVERSATION SO FAR
${chat || "(this is their first message)"}

THEIR NEW MESSAGE
"${question}"

Reply as JSON:
{"reply": "<your WhatsApp message>",
 "lang": "<en|hinglish|hi — the language you replied in>",
 "escalate": <true if the owner must handle this>,
 "action": "<show_products if they are asking to see a product/brand/category, pay_link if they want to pay a pending invoice now, else empty>",
 "product_query": "<when action=show_products: just the product or brand words, e.g. \\"nike sneakers\\">"}`);
}
