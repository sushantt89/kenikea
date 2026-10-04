import { Router } from "express";
import PushSubscription from "../models/PushSubscription.js";
import { getPublicKey, isPushConfigured, sendPush } from "../services/push.js";

const router = Router();

// GET /api/push/public-key - what the browser needs to subscribe. null
// means push isn't set up on this server (no VAPID keys).
router.get("/public-key", (req, res) => {
  res.json({ publicKey: getPublicKey() });
});

// POST /api/push/subscribe - save this device. Body: { subscription } (the
// browser's PushSubscription.toJSON()).
router.post("/subscribe", async (req, res, next) => {
  try {
    if (!isPushConfigured()) return res.status(503).json({ error: "Push notifications aren't set up on the server yet." });
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return res.status(400).json({ error: "That doesn't look like a valid push subscription." });
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      {
        user: req.user._id,
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/push/unsubscribe - forget this device. Body: { endpoint }.
router.post("/unsubscribe", async (req, res, next) => {
  try {
    const endpoint = req.body?.endpoint;
    if (endpoint) await PushSubscription.deleteOne({ endpoint, user: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/push/test - sends a test notification to the CALLER's own
// devices only, so it's safe to press any time.
router.post("/test", async (req, res, next) => {
  try {
    if (!isPushConfigured()) return res.status(503).json({ error: "Push notifications aren't set up on the server yet." });
    const count = await PushSubscription.countDocuments({ user: req.user._id });
    if (count === 0) {
      return res.status(400).json({ error: "No device of yours has notifications turned on yet - turn them on first." });
    }
    const result = await sendPush(
      { title: "Test notification", body: "Push notifications are working on this device.", url: "/settings", tag: "test" },
      { userId: req.user._id }
    );
    if (result.sent === 0) {
      return res.status(502).json({ error: "The push service didn't accept the message - try turning notifications off and on again." });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
