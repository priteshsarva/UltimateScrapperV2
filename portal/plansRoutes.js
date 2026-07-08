// Plan routes.
//   app.use("/portal/plans",        plansRoutes)        // clients: active plans for the picker
//   app.use("/portal/admin/plans",  adminPlansRoutes)   // admin: define/edit tiers
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import { listPlans, getPlan, createPlan, updatePlan } from "./plans.js";

// ---- client: list active plans ----
const clientRouter = Router();
clientRouter.use(requireAuth);
clientRouter.get("/", async (req, res) => {
  try {
    res.json({ plans: await listPlans({ activeOnly: true }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- admin: full CRUD ----
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

adminRouter.get("/", async (req, res) => {
  try { res.json({ plans: await listPlans({}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.post("/", async (req, res) => {
  const { name, price } = req.body || {};
  if (!name || price === undefined || price === null || isNaN(Number(price))) {
    return res.status(400).json({ error: "name and numeric price are required" });
  }
  try { res.json({ plan: await createPlan(req.body) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.patch("/:id", async (req, res) => {
  try {
    const plan = await updatePlan(req.params.id, req.body || {});
    if (!plan) return res.status(404).json({ error: "Plan not found" });
    res.json({ plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export { clientRouter as plansRoutes, adminRouter as adminPlansRoutes };
