// File uploads → Cloudflare R2. Multipart in, public URLs out. Used by the
// wholesale product form (images) and, in Phase 2, shipment parcel photos.
//   app.use("/portal", uploadRoutes)
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "./auth.js";
import { isConfigured, putProductImage, putShipmentPhoto } from "./storage.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10 } });
const router = Router();

// Lets the portal decide: show a real uploader (configured) or the URL-paste
// fallback (not configured yet).
router.get("/upload/status", (_req, res) => res.json({ configured: isConfigured() }));

router.post("/wholesale/upload", requireAuth, upload.array("files", 10), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: "Image storage is not configured. Paste an image URL instead." });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });
    const out = [];
    for (const f of files) out.push(await putProductImage(f.buffer));
    res.json({ files: out, urls: out.map((o) => o.url) });
  } catch (e) { console.error("[upload]", e.message); res.status(500).json({ error: e.message }); }
});

// Shipment parcel photos (2..10). Wired to the shipments flow in Phase 2.
router.post("/shipments/upload", requireAuth, upload.array("files", 10), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: "Image storage is not configured." });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files uploaded" });
    const out = [];
    for (const f of files) out.push(await putShipmentPhoto(f.buffer));
    res.json({ files: out });
  } catch (e) { console.error("[upload]", e.message); res.status(500).json({ error: e.message }); }
});

export default router;
