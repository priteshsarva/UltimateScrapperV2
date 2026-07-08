// /auth/*  — client signup + login (returns JWT) + current user.
import { Router } from "express";
import { query, pool } from "./db.js";
import { hashPassword, comparePassword, signToken, requireAuth } from "./auth.js";
import { generateEnrollmentKey } from "./keys.js";
import { sendWelcomeEmail } from "./mailer.js";
import { listPlans } from "./plans.js";

function normDomain(d) {
  if (!d) return "";
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0];
  return h;
}

const router = Router();

// POST /auth/signup
// { email, password, name, mobile, shop_url, plan_id,
//   social_urls?, whatsapp_number?, whatsapp_community_url? }
// Creates the user AND their first shop (pending admin approval) and emails a welcome.
router.post("/signup", async (req, res) => {
  const {
    email, password, name, mobile,
    shop_url, plan_id,
    social_urls, whatsapp_number, whatsapp_community_url,
  } = req.body || {};

  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  if (!shop_url) return res.status(400).json({ error: "shop URL required" });
  if (!plan_id) return res.status(400).json({ error: "please choose a plan" });

  const domain = normDomain(shop_url);
  if (!domain) return res.status(400).json({ error: "invalid shop URL" });

  const client = await pool.connect();
  try {
    if ((await client.query(`select 1 from users where email=$1`, [email])).rowCount)
      return res.status(409).json({ error: "Email already registered" });
    if ((await client.query(`select 1 from enrollments where lower(domain)=lower($1)`, [domain])).rowCount)
      return res.status(409).json({ error: "That shop domain is already registered" });
    if (!(await client.query(`select 1 from plans where id=$1 and active=true`, [plan_id])).rowCount)
      return res.status(400).json({ error: "Invalid plan" });

    const hash = await hashPassword(password);
    await client.query("BEGIN");

    const user = (await client.query(
      `insert into users
         (email, password_hash, name, role, mobile, whatsapp_number, whatsapp_community_url, social_urls)
       values ($1,$2,$3,'client',$4,$5,$6,$7)
       returning id, email, name, role, plan, status`,
      [email, hash, name || null, mobile || null,
       whatsapp_number || null, whatsapp_community_url || null,
       social_urls ? JSON.stringify(social_urls) : "{}"]
    )).rows[0];

    const shop = (await client.query(
      `insert into enrollments (user_id, domain, plan_id, enrollment_key, status)
       values ($1,$2,$3,$4,'pending')
       returning id, domain, status, enrollment_key`,
      [user.id, domain, plan_id, generateEnrollmentKey()]
    )).rows[0];

    await client.query("COMMIT");
    sendWelcomeEmail(user, shop).catch(() => {});
    res.json({ token: signToken(user), user, shop });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  } finally {
    client.release();
  }
});

// GET /auth/plans -> active plans (public — the signup page needs these before login)
router.get("/plans", async (req, res) => {
  try { res.json({ plans: await listPlans({ activeOnly: true }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /auth/login  { email, password }
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "email and password required" });
  try {
    const { rows } = await query(
      `select id, email, name, role, plan, status, password_hash from users where email=$1`,
      [email]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.status === "suspended") return res.status(403).json({ error: "Account suspended" });
    const ok = await comparePassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    delete user.password_hash;
    res.json({ token: signToken(user), user });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await query(
    `select id, email, name, role, plan, status from users where id=$1`,
    [req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  res.json({ user: rows[0] });
});

export default router;
