// Archive stale + unavailable products — NO Authorization required, so it can be
// hit from a plain curl / browser / cron on the server (same style as /dev/*).
//
// Safety without auth:
//   * preview is read-only.
//   * the destructive run needs ?confirm=yes so a stray GET / prefetch can't wipe
//     data by accident.
//   * OPTIONAL lock: set ARCHIVE_KEY in .env and every call must pass ?key=<that>.
//     Leave ARCHIVE_KEY unset to keep it fully open (the default you asked for).
//
// Mount:  app.use("/portal", archiveRoutes)  ->  /portal/archive-stale/*
import { Router } from "express";
import { previewArchive, archiveStale, archiveStaleAll, listCategoryDbs } from "./dbMaintenance.js";

const router = Router();

// optional shared-secret gate (NOT an Authorization header — just ?key=)
function keyOk(req) {
  const need = process.env.ARCHIVE_KEY;
  if (!need) return true;                 // unset -> open
  return (req.query.key || "") === need;  // set -> must match
}

// GET /portal/archive-stale/preview?months=2&category=shoes   (read-only dry run)
router.get("/archive-stale/preview", async (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ error: "bad or missing ?key" });
  const { category, months } = req.query;
  try {
    if (category) return res.json(await previewArchive(category, months));
    const databases = [];
    for (const c of listCategoryDbs()) databases.push(await previewArchive(c, months));
    res.json({ months: parseFloat(months) || 2, databases });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /portal/archive-stale/run?months=2&category=shoes&confirm=yes   (destructive)
// Omit category to run across every DB. confirm=yes is required.
router.get("/archive-stale/run", async (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ error: "bad or missing ?key" });
  if (req.query.confirm !== "yes") {
    return res.status(400).json({
      error: "add &confirm=yes to actually archive",
      hint: "run /portal/archive-stale/preview first to see the counts",
    });
  }
  const { category, months } = req.query;
  try {
    if (category) return res.json(await archiveStale(category, months));
    res.json({ months: parseFloat(months) || 2, databases: await archiveStaleAll(months) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
