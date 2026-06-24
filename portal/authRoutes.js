// /auth/*  — client signup + login (returns JWT) + current user.
import { Router } from "express";
import { query } from "./db.js";
import { hashPassword, comparePassword, signToken, requireAuth } from "./auth.js";

const router = Router();

// POST /auth/signup  { email, password, name }
router.post("/signup", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "email and password required" });
  try {
    const exists = await query(`select 1 from users where email=$1`, [email]);
    if (exists.rowCount) return res.status(409).json({ error: "Email already registered" });
    const hash = await hashPassword(password);
    const { rows } = await query(
      `insert into users (email, password_hash, name, role)
       values ($1,$2,$3,'client')
       returning id, email, name, role, plan, status`,
      [email, hash, name || null]
    );
    const user = rows[0];
    res.json({ token: signToken(user), user });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
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
