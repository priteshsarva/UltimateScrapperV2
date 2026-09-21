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
    const s = score(q, normalize(p.phrase));
    if (s >= threshold && (!best || s > best.score)) best = { faq_id: p.faq_id, score: s };
  }
  return best;
}

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
  console.log("waMatch ok");
}
