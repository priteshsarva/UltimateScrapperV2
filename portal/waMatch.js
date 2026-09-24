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
// Sales maths done on THIS person's numbers ("roz 40 customer × Rs 800 = 32,000, 9 lakh
// mahine ka") is about them — replayed to the next person it's numbers they never gave.
const SALES_MATHS = /\brs\b|rupa?y|rupee|rupiy|रुपय|रुपए|रुपये|\blakh|\blac\b|लाख|hazaa?r|हज़ार|हजार|\broz|रोज़|रोज|×|\d\s*[x*]\s*\d|\d[\d,]{2,}/i;
const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
const nums = (s) => String(s || "").match(/\p{Nd}+/gu) || [];
// names: the client's WhatsApp / lead / account name — a reply that uses it is theirs alone.
export function worthLearning({ question = "", answer = "", action = "", names = [] } = {}) {
  if (action) return false;                          // show_products / pay_link replies
  if (isStalling(answer)) return false;              // never learn "let me check and get back"
  if (question.trim().length < 12 || answer.trim().length < 20) return false;
  if (PERSONAL.test(answer) || SALES_MATHS.test(answer)) return false;
  // Their own count echoed back ("daily 40 customer" -> "40 customer daily achha hai") is
  // about them: replayed to the next shop it's a number they never gave.
  if (nums(answer).some((n) => nums(question).includes(n))) return false;
  if (isOneOff({ question, answer })) return false;  // money, deals, originality: never a stock answer
  const said = new Set(words(answer));
  if (names.flatMap(words).some((w) => w.length >= 3 && !STOP.has(w) && said.has(w))) return false;
  return normalize(question).length >= 2;            // not a greeting or "ok thanks"
}

// An owner answer that is a deal with ONE person — a price, a discount, "master copy hai"
// told to one vendor. It goes to that person once and is never kept as a saved answer:
// saved, the bot would repeat someone else's deal (or a vendor-only line) to everyone.
const ONE_OFF = new RegExp([
  "₹", "%", "\\brs\\b", "rupa?y", "rupee", "rupiy", "रुपय", "रुपए", "रुपये", "\\d[\\d,]{2,}", "\\blakh", "\\blac\\b", "hazaa?r", "हज़ार", "हजार", "लाख",
  "dis?count", "\\bdisc\\b", "\\boff(er)?\\b", "\\bdeal", "negotiat", "bargain", "\\bkam\\s?(kar|kr|ho|de)", "(last|best|final) price", "छूट", "डिस्काउंट", "कम (कर|हो)",
  "price", "\\brate\\b", "\\bcost", "charge", "\\bfees?\\b", "margin", "commission", "refund", "\\bpaise?\\b", "\\bpaisa", "payment", "\\bpay\\b",
  "ori?gi?n?al", "genuine", "authentic", "\\basli", "\\basal\\b", "nakli", "\\bfake", "duplicate", "replica", "\\bcopy\\b", "\\b7a\\b", "\\baaa\\b",
  "ओरिजिनल", "असली", "नकली", "कॉपी", "मास्टर",
].join("|"), "i");
export const isOneOff = ({ question = "", answer = "" } = {}) => ONE_OFF.test(`${question}\n${answer}`);

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
  // sales maths on one client's numbers (no ₹ sign) is theirs, not a general answer
  for (const a of ["Ramesh ji, 40 customer roz matlab mahine ke 1200 — Rs 800 average bill hai kya?",
                   "Agar 20 order extra aaye toh 2 lakh ka business ho jayega, socho zara.",
                   "25 × 800 matlab din ka bada amount hai, yeh sirf dukaan wale log hain.",
                   "रोज़ 30 ग्राहक और 500 रुपये का बिल, यह तो अच्छा काम है जी।"])
    assert.equal(W("mere shop pe roz 40 customer aate hain", a), false, a);
  // the client's own small counts echoed back, with none of the money words above
  assert.equal(W("mere shop pe daily 40 customer aate hain", "40 customer daily achha footfall hai ji, unme se kitne online bhi poochte hain?"), false);
  assert.equal(W("My shop gets around 40 customers daily", "40 customers daily is good footfall, how many of them also ask about buying online?"), false);
  // a number only in the question is fine as long as the answer doesn't repeat it
  assert.equal(W("mere 2 shop hain, dono ke liye ek store chalega?", "Haan ji, ek hi store me dono shop ke products dikha sakte hain, koi dikkat nahi."), true);
  const withName = { question: "delivery kitne din me hoti hai", answer: "Suresh ji, delivery 1 se 3 din me ho jati hai." };
  assert.equal(worthLearning({ ...withName, names: ["Suresh Kumar"] }), false);                                     // their name
  assert.equal(worthLearning({ ...withName, names: ["Ramesh"] }), true);
  assert.equal(W("bhai discount milega kya", "Nahi ji, abhi koi discount nahi chal raha hai."), false);            // money
  // owner answers that are one person's deal are sent once, never saved for everyone
  const O = (q, a) => isOneOff({ question: q, answer: a });
  assert.equal(O("discount milega?", "Aapke liye kar denge ji"), true);
  assert.equal(O("thoda kam karo bhai", "3500 kar dunga, final"), true);
  assert.equal(O("original hai?", "Master copy hai ji, quality top hai"), true);
  assert.equal(O("ye असली है?", "जी, मास्टर कॉपी है"), true);
  assert.equal(O("kitne ka padega", "Standard plan Rs 4000 mahina"), true);
  assert.equal(O("delivery kitne din me hoti hai", "1 se 3 din me ho jati hai ji, poore India me"), false);
  assert.equal(O("plan change kar sakte hain?", "Haan ji, bas humein bata dijiye, mahine ke beech me bhi ho jata hai"), false);
  assert.equal(O("store kab live hoga", "Submit karte hi 24 ghante me live ho jata hai"), false);
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
