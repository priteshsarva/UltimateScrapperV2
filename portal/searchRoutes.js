// Public catalogue-search landing funnel:
//   anonymous (3 free searches, by device id)
//     -> mobile + OTP signup (grants 50 free searches, becomes a client)
//        -> ₹100/month search-only plan (unlimited; manual UPI reconcile)
//
// Mounted WITHOUT requireAuth. A bearer token, if present and valid, upgrades
// the caller to a signed-in user (quota then counts against their account);
// otherwise the caller is anonymous and counted against x-device-id.
//   app.use("/search",       searchPublicRoutes)   // catalogue + quota + sources
//   app.use("/search-auth",  searchAuthRoutes)     // OTP send/verify
//   app.use("/search-plan",  searchPlanRoutes)     // ₹100/mo plan (authed)
//   app.use("/portal/admin", searchPlanAdminRoutes)// admin: verify plan payments
import { Router } from "express";
import jwt from "jsonwebtoken";
import { query } from "./db.js";
import { signToken, requireAuth, requireAdmin, hashPassword } from "./auth.js";
import { searchCatalogue } from "./catalogueSearch.js";
import { getPlatformUpi } from "./settings.js";
import { verifyFirebaseIdToken } from "./firebaseAdmin.js";
import { getPlan } from "./plans.js";
import { findProduct, isStale, rescrape } from "../core/refreshProduct.js";
import { logCatalogue, logLoginAttempt } from "./activityLog.js";

// Fire-and-forget live re-scrape of one product when it's opened from search.
// Guarded so public traffic can't pile onto the Puppeteer gate: per-product
// cooldown + a global in-flight cap, and only when the row is actually stale.
const CATS = new Set(["watches", "shoes"]);
const _refreshing = new Set();
const _lastRefresh = new Map();
const REFRESH_COOLDOWN_MS = 60 * 1000;
const REFRESH_MAX_INFLIGHT = Math.max(1, parseInt(process.env.REFRESH_MAX_INFLIGHT, 10) || 4);
function kickLiveRefresh(category, productId) {
  if (!CATS.has(category) || !productId) return;
  const k = category + ":" + productId;
  if (_refreshing.has(k)) return;
  if (_lastRefresh.has(k) && Date.now() - _lastRefresh.get(k) < REFRESH_COOLDOWN_MS) return;
  if (_refreshing.size >= REFRESH_MAX_INFLIGHT) return;
  _refreshing.add(k); _lastRefresh.set(k, Date.now());
  if (_lastRefresh.size > 20000) _lastRefresh.clear();
  (async () => {
    try {
      const product = await findProduct(productId, category);
      if (product && isStale(product)) {
        console.log(`[search-refresh] live scrape ${k} ${product.productUrl || ""}`);
        await rescrape(product, category);
      }
    } catch (e) { console.log(`[search-refresh] failed ${k} -> ${e.message}`); }
    finally { _refreshing.delete(k); }
  })();
}

const intervalDays = (interval, count) => (Number(count) || 1) * ({ day: 1, week: 7, month: 30, year: 365 }[interval] || 30);

// Grant/upgrade a user's search plan, effective now. views 0 = unlimited.
// A null plan falls back to the legacy 30-day unlimited grant.
async function grantSearchPlan(userId, plan) {
  const days = plan ? intervalDays(plan.interval, plan.interval_count) : 30;
  const views = Number(plan?.limits?.search_views || 0);   // 0 = unlimited
  await query(
    `update users set search_used = 0, search_plan_views = $2,
        search_plan_until = now() + ($3 || ' days')::interval
      where id = $1`, [userId, views, days]
  );
}

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const FREE_ANON = 3;
const FREE_USER = 50;
const OTP_TTL_MIN = 10;
// Production mobile verification is Firebase Phone Auth (client sends+verifies
// the SMS; we verify the returned ID token in POST /search-auth/firebase). The
// server-side /otp/send + /otp/verify below are a dev fallback that works
// without Firebase configured — the code is logged + returned so the flow is
// testable locally. Set OTP_LIVE=1 to stop returning the dev code.
const OTP_DEV = process.env.OTP_LIVE !== "1";

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error("[search]", e.message);
  if (!res.headersSent) res.status(500).json({ error: e.message });
});

// Canonical Indian mobile: digits only, 10-digit local numbers get the 91
// country code so the dev path and Firebase (E.164, e.g. +919…) agree.
const canonMobile = (m) => { const d = String(m || "").replace(/\D/g, ""); return d.length === 10 ? "91" + d : d; };

// A verified number maps to a client account: "verified" immediately, but
// "incomplete" until the user fills in their details.
async function findOrCreateMobileUser(mobile) {
  // Match by the last 10 digits so an EXISTING email/password user (whose mobile
  // may be stored as "+91 98765 43210", "9876…", etc.) resolves to their real
  // account instead of spawning a duplicate.
  const last10 = String(mobile).replace(/\D/g, "").slice(-10);
  let user = (await query(
    `select id, email, name, role, plan, status, profile_complete from users
      where regexp_replace(coalesce(mobile,''), '[^0-9]', '', 'g') like $1
      order by created_at limit 1`, ["%" + last10]
  )).rows[0];
  if (!user) {
    user = (await query(
      `insert into users (email, password_hash, name, role, mobile, status, mobile_verified, profile_complete)
       values (null, '', null, 'client', $1, 'active', true, false)
       returning id, email, name, role, plan, status, profile_complete`, [mobile]
    )).rows[0];
  } else {
    await query(`update users set mobile_verified=true where id=$1`, [user.id]);
  }
  return user;
}

// Soft auth: attach req.user if a valid bearer token is present, else leave it.
function softAuth(req, _res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (t) { try { req.user = jwt.verify(t, JWT_SECRET); } catch { /* stay anon */ } }
  next();
}

// Resolve the caller's current search quota (does not mutate).
//   -> { scope:'user'|'anon', limit, used, remaining, plan:bool, need }
async function getQuota(req) {
  if (req.user) {
    const u = (await query(`select search_used, search_last_q, search_plan_until, search_plan_views from users where id=$1`, [req.user.sub])).rows[0] || {};
    const planActive = u.search_plan_until && new Date(u.search_plan_until) > new Date();
    const views = Number(u.search_plan_views || 0);          // 0 = unlimited while the plan is active
    const unlimited = planActive && views === 0;
    const limit = unlimited ? Infinity : (planActive ? views : FREE_USER);
    const used = Number(u.search_used || 0);
    return { scope: "user", plan: !!planActive, unlimited, limit, used, last_q: u.search_last_q || "",
             remaining: unlimited ? Infinity : Math.max(0, limit - used), need: "plan" };
  }
  const dev = String(req.headers["x-device-id"] || "").slice(0, 100);
  const row = dev ? (await query(`select used, last_q from anon_search where device_id=$1`, [dev])).rows[0] : null;
  const used = Number(row?.used || 0);
  return { scope: "anon", plan: false, unlimited: false, limit: FREE_ANON, used, last_q: row?.last_q || "",
           remaining: Math.max(0, FREE_ANON - used), need: "signup", device_id: dev };
}

// Only opening a product costs a view (keyed "open:cat:id" so re-opening the
// same product back-to-back is free). Searching and browsing are unlimited.
async function bump(req, quota, key) {
  if (quota.scope === "user")
    await query(`update users set search_used=search_used+1, search_last_q=$2 where id=$1`, [req.user.sub, key]);
  else if (quota.device_id)
    await query(`insert into anon_search (device_id, used, last_q, updated_at) values ($1,1,$2,now())
                 on conflict (device_id) do update set used=anon_search.used+1, last_q=$2, updated_at=now()`, [quota.device_id, key]);
}
const quotaOut = (qt) => ({ scope: qt.scope, plan: qt.plan, unlimited: !!qt.unlimited, used: qt.used,
  limit: qt.limit === Infinity ? null : qt.limit, remaining: qt.remaining === Infinity ? null : qt.remaining });

// ============================================================ public search
const pub = Router();
pub.use(softAuth);

pub.get("/quota", asyncH(async (req, res) => res.json({ quota: quotaOut(await getQuota(req)) })));

pub.get("/sources", asyncH(async (_req, res) => {
  const rows = (await query(`select id, name, category from sources where status='active' or status is null order by name`)).rows;
  res.json({ sources: rows });
}));

// Plans the admin flagged for the search landing (their own plans, live-managed).
pub.get("/plans", asyncH(async (_req, res) => {
  const rows = (await query(
    `select id, name, price, discount_price, currency, interval, interval_count, description, features, limits
       from plans where active = true and show_on_search = true order by sort_order, price`
  )).rows;
  res.json({ plans: rows });
}));

pub.get("/catalogue", asyncH(async (req, res) => {
  // Searching + browsing are free; only opening a product (POST /consume) counts.
  const quota = await getQuota(req);
  const out = await searchCatalogue(req.query);
  const q = (req.query.q || "").toString().trim();
  if (q.length >= 2) logCatalogue({                    // record real searches (skip debounce partials)
    event: "search", scope: "landing", user_id: req.user?.sub || null, device_id: req.headers["x-device-id"] || null,
    q, category: req.query.category || null, results_count: out.count,
    filters: { stock: req.query.stock, brand: req.query.brand, size: req.query.size, source: req.query.source, sort: req.query.sort },
  });
  res.json({ ...out, quota: quotaOut(quota) });
}));

// Opening a product counts as a search too. Same free allowance / gate; opening
// the same product again (your last action) is free.
pub.post("/consume", asyncH(async (req, res) => {
  const category = String(req.body?.category || "").slice(0, 40);
  const productId = String(req.body?.productId || "").slice(0, 80);
  const key = "open:" + category + ":" + productId;
  const quota = await getQuota(req);
  // Opening a product also kicks a background live re-scrape + logs the click.
  const allow = () => {
    kickLiveRefresh(category, productId);
    logCatalogue({ event: "open", scope: "landing", user_id: req.user?.sub || null, device_id: req.headers["x-device-id"] || null, category, product_id: productId });
    res.json({ ok: true, quota: quotaOut(quota) });
  };

  if (quota.unlimited) return allow();                       // active plan w/ unlimited views
  if (key === (quota.last_q || "")) return allow();          // same product again — free, still refresh
  if (quota.remaining <= 0)
    return res.status(403).json({ error: "Free views used up", need: quota.need, quota: quotaOut(quota) });
  await bump(req, quota, key); quota.used += 1; quota.remaining -= 1;
  allow();
}));

// ============================================================ OTP mobile auth
const authR = Router();

// PRIMARY: exchange a Firebase phone-auth ID token (client already did the
// SMS + code) for our JWT. Verifies the token server-side so the phone number
// is trustworthy, then find-or-creates the account.
authR.post("/firebase", asyncH(async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken) return res.status(400).json({ error: "Missing idToken" });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  let decoded;
  try { decoded = await verifyFirebaseIdToken(idToken); }
  catch (e) { console.error("[firebase]", e.message); logLoginAttempt({ method: "otp", success: false, reason: "firebase verify failed", ip }); return res.status(401).json({ error: "Phone verification failed" }); }
  const mobile = canonMobile(decoded.phone_number);
  if (!mobile) return res.status(400).json({ error: "No phone number on token" });
  const user = await findOrCreateMobileUser(mobile);
  logLoginAttempt({ identifier: mobile, method: "otp", user_id: user.id, success: true, ip });
  res.json({ token: signToken(user), user, profile_complete: user.profile_complete });
}));

// DEV FALLBACK (no Firebase configured): server-generated OTP.
authR.post("/otp/send", asyncH(async (req, res) => {
  const mobile = canonMobile(req.body?.mobile);
  if (mobile.length < 10 || mobile.length > 13) return res.status(400).json({ error: "Enter a valid mobile number" });
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await query(`delete from otp_codes where mobile=$1`, [mobile]);
  await query(`insert into otp_codes (mobile, code, expires_at) values ($1,$2, now() + interval '${OTP_TTL_MIN} minutes')`, [mobile, code]);
  console.log(`[otp] (dev) -> ${mobile}: ${code}`);
  res.json({ sent: true, ...(OTP_DEV ? { dev_code: code } : {}) });
}));

authR.post("/otp/verify", asyncH(async (req, res) => {
  const mobile = canonMobile(req.body?.mobile);
  const code = String(req.body?.code || "").trim();
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
  if (!mobile || !code) return res.status(400).json({ error: "Mobile and code required" });
  const row = (await query(`select 1 from otp_codes where mobile=$1 and code=$2 and expires_at > now() order by created_at desc limit 1`, [mobile, code])).rows[0];
  if (!row) { logLoginAttempt({ identifier: mobile, method: "otp", success: false, reason: "invalid code", ip }); return res.status(400).json({ error: "Invalid or expired code" }); }
  await query(`delete from otp_codes where mobile=$1`, [mobile]);
  const user = await findOrCreateMobileUser(mobile);
  logLoginAttempt({ identifier: mobile, method: "otp", user_id: user.id, success: true, ip });
  res.json({ token: signToken(user), user, profile_complete: user.profile_complete });
}));

// After OTP the user can flesh out their account (name / email / password so
// they can also log in the normal way). Optional — skipping leaves the account
// verified-but-incomplete.
authR.post("/complete-profile", requireAuth, asyncH(async (req, res) => {
  const { name, email, password } = req.body || {};
  const sets = ["profile_complete=true"], params = [];
  if (name != null) { params.push(String(name).trim() || null); sets.push(`name=$${params.length}`); }
  if (email) {
    const em = String(email).trim().toLowerCase();
    if ((await query(`select 1 from users where lower(email)=$1 and id<>$2`, [em, req.user.sub])).rowCount)
      return res.status(409).json({ error: "That email is already registered" });
    params.push(em); sets.push(`email=$${params.length}`);
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    params.push(await hashPassword(password)); sets.push(`password_hash=$${params.length}`);
  }
  params.push(req.user.sub);
  const u = (await query(`update users set ${sets.join(", ")} where id=$${params.length}
     returning id, email, name, role, plan, status`, params)).rows[0];
  res.json({ user: u });
}));

// ============================================================ ₹100/mo plan
const planR = Router();
planR.use(requireAuth);

// Start (or reuse) a pending plan payment for the chosen plan; return the UPI.
planR.post("/order", asyncH(async (req, res) => {
  const planId = req.body?.plan_id || null;
  const plan = planId ? await getPlan(planId) : null;
  const planPrice = plan ? Number(plan.discount_price != null && plan.discount_price !== "" ? plan.discount_price : plan.price) : 100;
  const amount = planPrice;
  // Free plan: grant immediately, no payment / QR.
  if (plan && amount <= 0) {
    await grantSearchPlan(req.user.sub, plan);
    await query(`insert into search_plan_orders (user_id, plan_id, amount, status, paid_at) values ($1,$2,0,'paid',now())`, [req.user.sub, planId]);
    return res.json({ granted: true, amount: 0, plan });
  }
  let order = (await query(`select * from search_plan_orders where user_id=$1 and status in ('pending','claimed') order by created_at desc limit 1`, [req.user.sub])).rows[0];
  if (order) order = (await query(`update search_plan_orders set plan_id=$2, amount=$3 where id=$1 returning *`, [order.id, planId, amount])).rows[0];
  else order = (await query(`insert into search_plan_orders (user_id, plan_id, amount) values ($1,$2,$3) returning *`, [req.user.sub, planId, amount])).rows[0];
  res.json({ order, amount: Number(order.amount), plan, upi: await getPlatformUpi() });
}));

planR.post("/claim", asyncH(async (req, res) => {
  const utr = (req.body?.utr || "").toString().trim() || null;
  const r = (await query(`update search_plan_orders set status='claimed', utr=coalesce($2,utr)
     where id = (select id from search_plan_orders where user_id=$1 and status in ('pending','claimed') order by created_at desc limit 1)
     returning *`, [req.user.sub, utr])).rows[0];
  if (!r) return res.status(404).json({ error: "No pending plan payment" });
  res.json({ order: r });
}));

// ============================================================ admin: verify plan
const planAdmin = Router();
planAdmin.use(requireAuth, requireAdmin);

planAdmin.get("/search-plans", asyncH(async (req, res) => {
  const status = req.query.status;
  const params = [];
  let sql = `select p.*, u.mobile, u.email, u.name, u.search_plan_until
               from search_plan_orders p join users u on u.id = p.user_id`;
  if (status) { params.push(status); sql += ` where p.status=$${params.length}`; }
  else sql += ` where p.status in ('pending','claimed')`;
  sql += ` order by (p.status='claimed') desc, p.created_at desc limit 200`;
  res.json({ orders: (await query(sql, params)).rows });
}));

// Confirm payment: grant/extend 30 days of unlimited search and reset the counter.
planAdmin.post("/search-plans/:id/mark-paid", asyncH(async (req, res) => {
  const utr = (req.body?.utr || "").toString().trim() || null;
  const o = (await query(`select * from search_plan_orders where id=$1`, [req.params.id])).rows[0];
  if (!o) return res.status(404).json({ error: "Not found" });
  if (o.status === "paid") return res.status(400).json({ error: "Already paid" });
  await query(`update search_plan_orders set status='paid', utr=coalesce($2,utr), paid_at=now() where id=$1`, [o.id, utr]);
  await grantSearchPlan(o.user_id, o.plan_id ? await getPlan(o.plan_id) : null);
  res.json({ ok: true });
}));

// Admin manually assigns / upgrades a user's search plan (e.g. after confirming
// an offline payment). Takes effect immediately. No plan_id = revoke the plan.
planAdmin.post("/users/:userId/search-plan", asyncH(async (req, res) => {
  const planId = req.body?.plan_id;
  if (!planId) {
    await query(`update users set search_plan_until = null, search_plan_views = null where id = $1`, [req.params.userId]);
    return res.json({ ok: true, cleared: true });
  }
  const plan = await getPlan(planId);
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  await grantSearchPlan(req.params.userId, plan);
  const u = (await query(`select search_plan_until, search_plan_views from users where id=$1`, [req.params.userId])).rows[0];
  res.json({ ok: true, until: u.search_plan_until, views: u.search_plan_views });
}));

export { pub as searchPublicRoutes, authR as searchAuthRoutes, planR as searchPlanRoutes, planAdmin as searchPlanAdminRoutes };
