import webpush from "web-push";
import PushSubscription from "../models/PushSubscription.js";

// Web Push to phones/desktops that turned notifications on in Settings.
// Needs a VAPID key pair in the environment (generate one with
// `npx web-push generate-vapid-keys` - see README / .env.example); without
// it everything here quietly does nothing and Settings says push isn't set
// up yet.
const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      VAPID_SUBJECT || "mailto:admin@example.com",
      VAPID_PUBLIC_KEY.trim(),
      VAPID_PRIVATE_KEY.trim()
    );
    configured = true;
  } catch (err) {
    console.error("[push] VAPID keys look invalid - push notifications are off:", err.message);
  }
}

export function isPushConfigured() {
  return configured;
}

export function getPublicKey() {
  return configured ? VAPID_PUBLIC_KEY.trim() : null;
}

/**
 * Sends one payload ({ title, body, url }) to every saved device - or only
 * to `userId`'s devices when given. Devices the push service says are gone
 * (404/410 - app uninstalled, permission revoked) are deleted. Never
 * throws: a push failure must not break whatever created the notification.
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function sendPush(payload, { userId } = {}) {
  if (!configured) return { sent: 0, failed: 0 };

  const subs = await PushSubscription.find(userId ? { user: userId } : {});
  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          body,
          { TTL: 60 * 60 }
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        } else {
          console.error("[push] send failed:", err.statusCode || "", err.message);
        }
      }
    })
  );

  return { sent, failed };
}
