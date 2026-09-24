// WhatsApp bot FAQ matching — deterministic, no AI.
// normalize(): lowercase, map Hinglish/Hindi/misspelt words to one canonical
// token, drop filler words ("kaise", "bhai", "how to"...). Then Dice overlap
// of the remaining tokens, with typo-tolerant token equality.
// Self-check: node portal/waMatch.js
import { pathToFileURL } from "url";

// canonical <- variants. Hindi words map to the same tokens so a Hindi
// question can hit a FAQ learned from a Hinglish one. Add spellings here.
const SYNONYMS = {
  cancel:   "cancle cancell cancelled radd rad kainsal कैंसिल रद्द",
  payment:  "pay paid paisa paise pymt pmt bhugtan पेमेंट भुगतान पैसे",
  renew:    "renewal rinew renu recharge रिन्यू",
  expiry:   "expire expired expires khatam validity एक्सपायर",
  order:    "orders odr ordr ऑर्डर आर्डर",
  product:  "products prodct maal saman samaan item items प्रोडक्ट सामान",
  store:    "shop site website dukan dukaan स्टोर दुकान वेबसाइट",
  invoice:  "invoices bill bills बिल इनवॉइस",
  plan:     "plans package प्लान",
  add:      "dalna daalna dale daale upload jodna जोड़ना डालना",
  delete:   "hatana hatao remove हटाना",
  price:    "rate rates kimat keemat daam prices कीमत दाम",
  login:    "signin log लॉगिन",
  password: "pass pwd पासवर्ड",
  refund:   "wapas vapas return रिफंड",
  delivery: "deliver delivered डिलीवरी",
  shipping: "ship shipped shipment",
  not:      "nahi nahin nhi nai नहीं",
  change:   "badalna badlo edit update बदलना",
};
const CANON = new Map();
for (const [canon, vars] of Object.entries(SYNONYMS)) for (const v of vars.split(" ")) CANON.set(v, canon);

const STOP = new Set((
  "i me my mine you your the a an is are am was were be to of in on for it this that how what why when where " +
  "can could do does did please pls plz sir madam hi hii hello hey and or with get want need " +
  "bhai bhaiya ji mera meri mere mujhe muje hum humne maine main mai me mein ka ki ke ko se hai h he hain ho hoga hua " +
  "tha thi kaise kese kaisay kaisa kya kyu kyun kab kaha kahan kar kare karu karna karne karo kiya karein raha rahi rahe " +
  "na to bhi aur ya ek koi batao bataye bata chahiye sakte sakta sakti skte apna apni apne yeh ye woh wo abhi namaste " +
  "ok okay thanks thank thx thankyou shukriya dhanyavad hmm hm acha achha accha theek thik sahi done great nice " +
  "मेरा मेरी मेरे मुझे का की के को से है हैं हो कैसे क्या क्यों कब कहाँ कर करें करना करे रहा रही भी और या एक कोई जी भाई बताओ बताइए चाहिए सकते अपना यह वह अभी में"
).split(" "));

export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => CANON.get(w) || w)
    .filter((w) => !STOP.has(w));
}

const bigrams = (s) => { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
function tokenEq(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false; // short words must match exactly
  const A = bigrams(a), B = bigrams(b);
  let hit = 0; const pool = [...B];
  for (const g of A) { const i = pool.indexOf(g); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length) >= 0.75;
}

export function score(qTokens, pTokens) {
  if (!qTokens.length || !pTokens.length) return 0;
  const pool = [...pTokens];
  let hit = 0;
  for (const q of qTokens) { const i = pool.findIndex((p) => tokenEq(q, p)); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return (2 * hit) / (qTokens.length + pTokens.length);
}

export const MATCH_THRESHOLD = 0.6;

// phrases: [{ faq_id, phrase }] -> { faq_id, score } | null
// ponytail: linear scan of every phrase per message; fine to a few thousand phrases, index tokens if it grows past that.
export function bestMatch(text, phrases, threshold = MATCH_THRESHOLD) {
  const q = normalize(text);
  let best = null;
  for (const p of phrases) {
    // weight lets the owner's own answers win a close call against AI-learned ones
    const s = score(q, normalize(p.phrase)) * (p.weight || 1);
    if (s >= threshold && (!best || s > best.score)) best = { faq_id: p.faq_id, score: s };
  }
  return best;
}

// Is this AI answer safe to keep as a general saved answer? Anything tied to one
// person's account (their invoice, their order, their expiry) would be wrong for the
// next person who asks, and product/payment replies carry one-off links.
const PERSONAL = /₹|\bINV-|\bORD-|expir|invoice|\border\b/i;
export function worthLearning({ question = "", answer = "", action = "" } = {}) {
  if (action) return false;                          // show_products / pay_link replies
  if (isStalling(answer)) return false;              // never learn "let me check and get back"
  if (question.trim().length < 12 || answer.trim().length < 20) return false;
  if (PERSONAL.test(answer)) return false;
  return normalize(question).length >= 2;            // not a greeting or "ok thanks"
}

// A reply that stalls instead of answering: "team se confirm karke batata hoon",
// "let me check and get back to you". The owner never wants these sent — the model is
// told not to, but a rule in a prompt isn't a guarantee, so the server checks too.
// Plain "batata hoon" is NOT enough on its own: "main aapko batata hoon kaise kaam
// karta hai" is a real answer. Only phrases that promise to come back later count.
const STALL = new RegExp([
  "team se", "confirm kar(ke|ke\\s|ne|\\s?ke)", "check kar(ke|ne|\\s?ke)", "pata kar(ke|\\s?ke)",
  "po+c?hh?(\\s?ke|kar)", "pu+chh?\\s?ke", "thodi der (me|mein) bata", "baad me(in)? bata",
  "get back to you", "check with (the|my|our) team", "let me (check|confirm|find out)", "i'?ll (check|confirm) and",
  "टीम से", "पूछकर", "पूछ के", "पता करके", "कन्फर्म करके",
].join("|"), "i");
export const isStalling = (text) => STALL.test(String(text || ""));

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const assert = (await import("assert")).strict;
  const P = [
    { faq_id: 1, phrase: "order cancel kaise kare" },
    { faq_id: 2, phrase: "product kaise add kare" },
    { faq_id: 3, phrase: "payment kab tak aayega" },
  ];
  assert.deepEqual(normalize("Bhai, mera ORDER cancle kaise karu??"), ["order", "cancel"]);
  assert.equal(bestMatch("how to cancel my order", P)?.faq_id, 1);
  assert.equal(bestMatch("ऑर्डर कैंसिल कैसे करें", P)?.faq_id, 1);
  assert.equal(bestMatch("naya prodct kaise dale", P)?.faq_id, 2);
  assert.equal(bestMatch("store live nahi hua", P), null);
  const W = (q, a, action) => worthLearning({ question: q, answer: a, action });
  assert.equal(W("delivery kitne din me hoti hai", "Delivery 1 se 3 din me ho jati hai ji, pure India me."), true);
  assert.equal(W("mera plan kab khatam hoga", "Aapka Standard plan 1 October 2026 ko expire ho raha hai."), false); // personal
  assert.equal(W("iska price", "Aapka invoice ₹4,000 ka hai."), false);                                             // personal
  assert.equal(W("ok thanks bhai", "Theek hai ji, koi baat nahi. Kabhi bhi poochh lijiye."), false);                 // no content
  assert.equal(W("nike ke shoes dikhao", "Haan ji, yeh dekhiye kuch options.", "show_products"), false);             // one-off
  // stalling lines are caught...
  for (const s of ["Main team se confirm karke abhi batata hoon.", "Team se baat karke bata hu", "ek min, check karke batata hoon ji",
                   "Let me check with the team and get back to you.", "मैं टीम से पूछकर अभी बताता हूँ।", "poochh ke batata hu"])
    assert.equal(isStalling(s), true, s);
  // ...but real answers that happen to say "batata hoon" are not
  for (const s of ["Main aapko batata hoon kaise kaam karta hai — products ready milte hain.",
                   "Delivery 1 se 3 din me ho jati hai ji.", "Standard plan ₹4,000 per month ka hai."])
    assert.equal(isStalling(s), false, s);
  console.log("waMatch ok");
}
