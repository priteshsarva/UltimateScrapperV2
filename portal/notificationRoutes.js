// GET /portal/notifications  -> feed for the logged-in user's role.
import { Router } from "express";
import { requireAuth } from "./auth.js";
import { listNotifications } from "./notifications.js";

const router = Router();
router.use(requireAuth);

router.get("/notifications", async (req, res) => {
  try {
    res.json({ notifications: await listNotifications(req.user.role) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
