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
  let user = (await query(`select id, email, name, role, plan, status, profile_complete from users where mobile=$1 order by created_at limit 1`, [mobile])).rows[0];
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
    const u = (await query(`select search_used, search_last_q, search_plan_until from users where id=$1`, [req.user.sub])).rows[0] || {};
    const plan = u.search_plan_until && new Date(u.search_plan_until) > new Date();
    const used = Number(u.search_used || 0);
    return { scope: "user", plan: !!plan, limit: plan ? Infinity : FREE_USER, used, last_q: u.search_last_q || "",
             remaining: plan ? Infinity : Math.max(0, FREE_USER - used), need: "plan" };
  }
  const dev = String(req.headers["x-device-id"] || "").slice(0, 100);
  const row = dev ? (await query(`select used, last_q from anon_search where device_id=$1`, [dev])).rows[0] : null;
  const used = Number(row?.used || 0);
  return { scope: "anon", plan: false, limit: FREE_ANON, used, last_q: row?.last_q || "",
           remaining: Math.max(0, FREE_ANON - used), need: "signup", device_id: dev };
}

// A billable action is keyed so we can de-dupe: a new keyword search
// (key=the query) or opening a product (key="open:cat:id"). Filter tweaks,
// pagination and repeating your last action don't cost anything.
const catalogueActionKey = (req) => {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return q && page === 1 ? q : null;   // null = browse/pagination, never counts
};
async function bump(req, quota, key) {
  if (quota.scope === "user")
    await query(`update users set search_used=search_used+1, search_last_q=$2 where id=$1`, [req.user.sub, key]);
  else if (quota.device_id)
    await query(`insert into anon_search (device_id, used, last_q, updated_at) values ($1,1,$2,now())
                 on conflict (device_id) do update set used=anon_search.used+1, last_q=$2, updated_at=now()`, [quota.device_id, key]);
}
const quotaOut = (qt) => ({ scope: qt.scope, plan: qt.plan, used: qt.used,
  limit: qt.limit === Infinity ? null : qt.limit, remaining: qt.remaining === Infinity ? null : qt.remaining });

// ============================================================ public search
const pub = Router();
pub.use(softAuth);

pub.get("/quota", asyncH(async (req, res) => res.json({ quota: quotaOut(await getQuota(req)) })));

pub.get("/sources", asyncH(async (_req, res) => {
  const rows = (await query(`select id, name, category from sources where status='active' or status is null order by name`)).rows;
  res.json({ sources: rows });
}));

pub.get("/catalogue", asyncH(async (req, res) => {
  const quota = await getQuota(req);
  const key = catalogueActionKey(req);
  const willCount = key && key !== (quota.last_q || "");
  // Block only a NEW keyword search once the free allowance is spent; browsing
  // (empty q), pagination and repeats stay open so the page isn't a dead end.
  if (willCount && quota.remaining <= 0)
    return res.status(403).json({ error: "Free searches used up", need: quota.need, quota: quotaOut(quota) });

  const out = await searchCatalogue(req.query);
  if (willCount) { await bump(req, quota, key); quota.used += 1; quota.remaining -= 1; }
  res.json({ ...out, quota: quotaOut(quota) });
}));

// Opening a product counts as a search too. Same free allowance / gate; opening
// the same product again (your last action) is free.
pub.post("/consume", asyncH(async (req, res) => {
  const quota = await getQuota(req);
  if (quota.plan) return res.json({ ok: true, quota: quotaOut(quota) });   // unlimited plan
  const key = "open:" + String(req.body?.key || "").slice(0, 120);
  if (key === (quota.last_q || "")) return res.json({ ok: true, quota: quotaOut(quota) });
  if (quota.remaining <= 0)
    return res.status(403).json({ error: "Free views used up", need: quota.need, quota: quotaOut(quota) });
  await bump(req, quota, key); quota.used += 1; quota.remaining -= 1;
  res.json({ ok: true, quota: quotaOut(quota) });
}));

// ============================================================ OTP mobile auth
const authR = Router();

// PRIMARY: exchange a Firebase phone-auth ID token (client already did the
// SMS + code) for our JWT. Verifies the token server-side so the phone number
// is trustworthy, then find-or-creates the account.
authR.post("/firebase", asyncH(async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken) return res.status(400).json({ error: "Missing idToken" });
  let decoded;
  try { decoded = await verifyFirebaseIdToken(idToken); }
  catch (e) { console.error("[firebase]", e.message); return res.status(401).json({ error: "Phone verification failed" }); }
  const mobile = canonMobile(decoded.phone_number);
  if (!mobile) return res.status(400).json({ error: "No phone number on token" });
  const user = await findOrCreateMobileUser(mobile);
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
  if (!mobile || !code) return res.status(400).json({ error: "Mobile and code required" });
  const row = (await query(`select 1 from otp_codes where mobile=$1 and code=$2 and expires_at > now() order by created_at desc limit 1`, [mobile, code])).rows[0];
  if (!row) return res.status(400).json({ error: "Invalid or expired code" });
  await query(`delete from otp_codes where mobile=$1`, [mobile]);
  const user = await findOrCreateMobileUser(mobile);
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

// Start (or reuse) a pending plan payment; return the platform UPI to pay into.
planR.post("/order", asyncH(async (req, res) => {
  let order = (await query(`select * from search_plan_orders where user_id=$1 and status in ('pending','claimed') order by created_at desc limit 1`, [req.user.sub])).rows[0];
  if (!order) order = (await query(`insert into search_plan_orders (user_id) values ($1) returning *`, [req.user.sub])).rows[0];
  res.json({ order, amount: Number(order.amount), upi: await getPlatformUpi() });
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
  await query(
    `update users set search_used=0,
        search_plan_until = greatest(coalesce(search_plan_until, now()), now()) + interval '30 days'
      where id=$1`, [o.user_id]
  );
  res.json({ ok: true });
}));

export { pub as searchPublicRoutes, authR as searchAuthRoutes, planR as searchPlanRoutes, planAdmin as searchPlanAdminRoutes };
