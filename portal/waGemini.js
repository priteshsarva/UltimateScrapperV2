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
const TIMEOUT_MS = 30000;
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
export const aiUsage = () => ({ ...used, max: DAILY_MAX, enabled: keys().length > 0, keys: keys().length, model: MODEL });

// Gemini calls run one at a time, spaced out: the free tier limits requests per
// MINUTE, and three clients typing at once would otherwise burn the quota and get
// nothing back. A queued call still beats "sorry, please try again".
let chain = Promise.resolve();
// With several keys the gap can be small — each call goes to a different key.
const MIN_GAP_MS = Number(process.env.WA_AI_GAP_MS || 1200);
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => new Promise((s) => setTimeout(s, MIN_GAP_MS)), () => new Promise((s) => setTimeout(s, MIN_GAP_MS)));
  return run;
}

// One Gemini call -> parsed JSON, or null on any problem (never throws).
// 503/429 ("high demand") is common and clears in a second, so it gets one retry.
const ask = (prompt) => serialize(() => askNow(prompt));

// One or many keys: GEMINI_API_KEYS=key1,key2,key3 (GEMINI_API_KEY still works).
// Each key has its own free quota, so a rate-limited call retries on the next key.
const keys = () => (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
let keyTurn = 0;

async function askNow(prompt, retry = true) {
  const pool = keys();
  const key = pool[keyTurn++ % pool.length];
  if (!key || !spend()) return null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, responseMimeType: "application/json", maxOutputTokens: 400 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error("[wa-ai]", r.status, j?.error?.message || "");
      if (retry && (r.status === 503 || r.status === 429)) {
        // Rate limited: the next call already uses the next key, so retry fast when
        // there is more than one; wait a moment when there is only one.
        await new Promise((s) => setTimeout(s, pool.length > 1 ? 200 : 1500));
        return askNow(prompt, false);
      }
      return null;
    }
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) return null;
    const clean = text.replace(/^```json\s*|\s*```$/g, "");
    try { return JSON.parse(clean); }
    catch {
      // Cut off mid-JSON: salvage the reply rather than losing the whole turn.
      const m = clean.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return m ? { reply: JSON.parse(`"${m[1]}"`) } : null;
    }
  } catch (e) {
    console.error("[wa-ai]", e.message);
    if (retry) { await new Promise((s) => setTimeout(s, 1500)); return askNow(prompt, false); }  // timeouts/network blips
    return null;
  }
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
- Never ask a question you already asked in this chat, and never repeat a line you already sent.
  If they haven't answered it, let it go and move the talk forward.
- Do not repeat a greeting in every message, and do not re-introduce yourself mid-conversation.
- Use their name rarely — at most once in a while, not in every message.
- Earlier messages in this chat may have been written by an older, robotic version of this system or
  by the owner in a hurry. Never copy their style or their menus — always write in your own natural way.

THEIR FIRST MESSAGE IN A CHAT (when CONVERSATION SO FAR is empty)
Your reply MUST have all three parts, in this order, in about two short lines:
  1. a warm greeting + how are you ("Kaise ho aap?" / "Aap kaise hain?" / "How are you doing?")
  2. ONE short hook: a ready online store with products and photos included, nothing to stock
  3. ONE light question that gets them talking about their shop
Never send only a greeting — a bare "Hello, kaise ho aap?" is a wasted message, it MUST carry the
hook and the question too.
These show the shape; mix and vary the wording yourself, never repeat one word for word:
 - "Kaise ho aap ji? Hum shop wale bhaiyon ko banaya banaya online store dete hain — na stock, na
    photo ka jhanjhat. Aapki shop kis cheez ki hai?"
 - "Aur ji, sab badhiya? Aaj kal log apna saara maal online bhi bech rahe hain, wahi setup hum
    ready karke dete hain. Aap kya bechte ho?"
 - "How are you doing? We set shop owners up with a ready online store — products and photos are
    already in it, nothing to stock. What do you sell?"
Language for a first message: if they wrote a full sentence in English, reply fully in English.
If they wrote in Devanagari, reply fully in Devanagari — never mix scripts in one message.
If it is ONLY a greeting ("hi", "hello", "namaste") with nothing else, reply in Hinglish.

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

SHOWING PRODUCTS
- ONLY when they actually ask to see a product, brand or category ("nike hai kya", "sneakers dikhao"),
  set "action": "show_products" and put the product words in "product_query".
- The photos and their links are attached automatically. So your "reply" is just one short natural
  line like "Haan ji, yeh dekhiye" — do NOT describe the photos and do NOT paste any link yourself.
- If a customer asks what a PRODUCT costs, say that product prices depend on the markup they set
  and are shown in the catalogue — then carry on with the conversation. Never quote a product price.

OUR PRICING (this is about OUR monthly plan, and is different from product prices)
- Do NOT mention our plan or cost until they ask about it.
- The FIRST time they ask what it costs, do NOT give a number. Tell them they can start free and
  see the whole thing, and ask one question back about their shop so the talk keeps going.
- Only if they ask a SECOND time, or clearly push for the figure, tell them: Standard is ₹4,000 per month.
- Never send them to the portal to find out what WE charge — that is your question to answer.
- Never offer discounts, never negotiate, never promise a delivery date or an earnings figure.

ABOUT LINKS
- At most one link in a message, and only when it genuinely helps.
- Do not end every message with the portal. A conversation is what sells; a link is not.

IF SOMEONE IS MESSING ABOUT (abuse, trolling, testing you, time-wasting)
- Don't grovel and don't apologise for nothing — you are not a servant, you are their equal.
- Give it back with a calm, light, slightly cheeky line that holds its ground, then either bring
  the talk back to business or leave it there. Think confident shopkeeper, not doormat.
- Never insult them, never swear, never match filth with filth — this is a business number and
  an ugly screenshot travels further than any sale. Wit wins, abuse loses.
- If they keep at it after one comeback, stop replying to the nonsense and escalate.
- Threats, blackmail ("free do warna review kharab kar dunga"), or anything that could harm the
  business: answer calmly with one line and ALWAYS escalate so the owner sees it.

WHEN TO HAND OVER TO THE OWNER (set "escalate": true)
- Discounts, price negotiation, refunds, complaints, custom deals, anything about someone else's account.
- Anything the guide and the saved answers do not cover, or anything you are unsure about.
- When they ask to speak to a person.
- When you escalate, your "reply" should be a natural line saying you'll check with the team and
  come back shortly — never a made-up answer.`;

// The owner's note -> the message to send the client. The note may be the answer
// itself ("2 din lagenge"), or an INSTRUCTION about what to say ("bol do monday tak
// ho jayega", "uska budget poochho"). Either way this returns what the client reads.
export async function draftReply({ note, question, lang, history = [] }) {
  const chat = history.slice(-6).map((m) => `${m.role === "client" ? "THEM" : "YOU"}: ${m.text}`).join("\n");
  const out = await ask(
`You write WhatsApp messages for the Kartify team. The owner has told you how to answer a customer.
Turn the owner's note into the message the customer should receive.

BUSINESS
${guide()}

CONVERSATION
${chat || "(no earlier messages)"}

THE CUSTOMER ASKED
"${question}"

THE OWNER'S NOTE (this may be the answer itself, or an instruction telling you what to say/ask)
"${note}"

RULES
- Follow the note exactly. If it is an instruction, do what it says; if it is the answer, say it properly.
- Always fix the spelling, grammar and shorthand of the note — the owner types fast ("h" -> "hai",
  "nhi" -> "nahi"). The customer must never see rough notes.
- Keep every number, date, price and link from the note EXACTLY as written. Add no facts of your own.
- Write it the way a person writes on WhatsApp: warm, 1-3 short sentences, no bullet points.
- Write in ${LANG_NAME[lang] || LANG_NAME.hinglish}, the language the customer is using.

Return JSON: {"message": "<the message to send>"}`);
  const msg = String(out?.message || "").trim();
  return msg || null;
}

const LANG_NAME = { en: "English", hinglish: "Hinglish (Hindi written in English letters)", hi: "Hindi (Devanagari)" };

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
