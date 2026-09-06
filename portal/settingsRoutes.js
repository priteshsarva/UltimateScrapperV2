// Admin settings (SMTP + payment) and a non-secret payment-info endpoint.
//   app.use("/portal/admin/settings", adminSettingsRoutes)   // admin-only
//   app.use("/portal", publicSettingsRoutes)                 // GET /portal/payment-info
import { Router } from "express";
import { requireAuth, requireAdmin } from "./auth.js";
import {
  getSmtpConfig, getSmtpConfigMasked, saveSettings,
  getPaymentRegistryMasked, savePaymentProvider, setActiveProvider, getPaymentPublic,
  getPlatformUpi, savePlatformUpi,
} from "./settings.js";
import { sendMail } from "./mailer.js";

// ---------- admin ----------
const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

// SMTP — GET returns config with the password MASKED (never send the real one).
adminRouter.get("/smtp", async (_req, res) => {
  try { res.json({ smtp: await getSmtpConfigMasked() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT saves. A blank/masked password means "keep the existing one".
adminRouter.put("/smtp", async (req, res) => {
  const b = req.body || {};
  const patch = {
    host: b.host || "",
    port: parseInt(b.port || "587", 10),
    secure: !!b.secure,
    user: b.user || "",
    from: b.from || "",
  };
  if (b.pass && b.pass !== "********") patch.pass = b.pass;
  else { const cur = await getSmtpConfig(); patch.pass = cur.pass; } // preserve
  try { await saveSettings("smtp", patch); res.json({ ok: true, smtp: await getSmtpConfigMasked() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// send a test email to the given address (or the admin's own)
adminRouter.post("/smtp/test", async (req, res) => {
  const to = (req.body && req.body.to) || req.user.email;
  const r = await sendMail({
    to,
    subject: "Server Products — SMTP test",
    html: "<p>This is a test email. If you can read this, SMTP is configured correctly.</p>",
  });
  if (r.ok) res.json({ ok: true, to });
  else res.status(502).json({ error: r.error });
});

// Payment REGISTRY — GET returns every provider with keys MASKED + which is active.
adminRouter.get("/payment", async (_req, res) => {
  try { res.json({ payment: await getPaymentRegistryMasked() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// save one provider's fields (blank/masked secrets keep the stored value)
adminRouter.put("/payment/provider/:id", async (req, res) => {
  const b = req.body || {};
  const fields = {
    label: b.label, title: b.title, description: b.description,
    base_url: b.base_url, webhook_url: b.webhook_url, enabled: !!b.enabled,
    api_key: b.api_key, secret: b.secret,
  };
  try { res.json({ ok: true, payment: await savePaymentProvider(req.params.id, fields) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// choose the live gateway
adminRouter.put("/payment/active", async (req, res) => {
  try { res.json({ ok: true, payment: await setActiveProvider((req.body && req.body.id) || "") }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Platform UPI (our own manual collection from vendors). Not a gateway.
adminRouter.get("/platform-upi", async (_req, res) => {
  try { res.json({ upi: await getPlatformUpi() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
adminRouter.put("/platform-upi", async (req, res) => {
  try { res.json({ ok: true, upi: await savePlatformUpi(req.body || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- public (non-secret) ----------
// The portal app AND the WordPress plugin can read this to know whether online
// payment is available and via which provider. Contains NO credentials.
const publicRouter = Router();
publicRouter.get("/payment-info", async (_req, res) => {
  try { res.json(await getPaymentPublic()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

export { adminRouter as adminSettingsRoutes, publicRouter as publicSettingsRoutes };
