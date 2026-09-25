import { Router } from "express";
import Notification from "../models/Notification.js";
import { checkCalendarDeclines } from "../services/declineSync.js";
import { checkNewAvailabilitySubmissions } from "../services/availabilitySync.js";

const router = Router();

// GET /api/notifications - list notifications, most recent first, for the
// bell icon in the navbar (see client/src/components/NotificationBell.jsx,
// which polls this on every page - not just the Jobs page - so this is
// what actually catches a worker's calendar decline while you're
// elsewhere in the app). Runs the same check as routes/jobs.js's GET / -
// see services/declineSync.js.
router.get("/", async (req, res, next) => {
  try {
    await checkCalendarDeclines();
    await checkNewAvailabilitySubmissions();
    const notifications = await Notification.find().sort({ createdAt: -1 }).limit(50).lean();
    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/:id/read - mark one notification read (the bell
// dropdown does this the moment you click a notification).
router.put("/:id/read", async (req, res, next) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    res.json(notification);
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/read-all - mark every notification read (a "mark
// all read" action in the bell dropdown, in case a few build up).
router.put("/read-all", async (req, res, next) => {
  try {
    await Notification.updateMany({ read: false }, { $set: { read: true } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
