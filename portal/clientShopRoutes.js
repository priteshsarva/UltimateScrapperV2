// Client: add another shop (enrollment) to their account.
//   app.use("/portal", clientShopRoutes)
import { Router } from "express";
import { query } from "./db.js";
import { requireAuth } from "./auth.js";
import { generateEnrollmentKey } from "./keys.js";

function normDomain(d) {
  if (!d) return "";
  let h = String(d).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, "").replace(/^www\./, "");
  h = h.split("/")[0].split(":")[0];
  return h;
}

const router = Router();

// POST /portal/shops  { shop_url, plan_id }  -> a new pending shop with its own key
router.post("/shops", requireAuth, async (req, res) => {
  const { shop_url, plan_id } = req.body || {};
  if (!shop_url) return res.status(400).json({ error: "shop URL required" });
  if (!plan_id) return res.status(400).json({ error: "please choose a plan" });

  const domain = normDomain(shop_url);
  if (!domain) return res.status(400).json({ error: "invalid shop URL" });

  try {
    if ((await query(`select 1 from enrollments where lower(domain)=lower($1)`, [domain])).rowCount)
      return res.status(409).json({ error: "That shop domain is already registered" });
    if (!(await query(`select 1 from plans where id=$1 and active=true`, [plan_id])).rowCount)
      return res.status(400).json({ error: "Invalid plan" });

    const shop = (await query(
      `insert into enrollments (user_id, domain, plan_id, enrollment_key, status)
       values ($1,$2,$3,$4,'pending')
       returning id, domain, status, enrollment_key`,
      [req.user.sub, domain, plan_id, generateEnrollmentKey()]
    )).rows[0];

    res.json({ ok: true, shop });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That shop domain is already registered" });
    res.status(500).json({ error: e.message });
  }
});

export default router;
