import { useEffect, useState } from "react";
import { getPushPublicKey, subscribePush, unsubscribePush, sendTestPush } from "../api.js";
import { isStandalone, isIos } from "../utils/pwaInstall.js";
import { useToast } from "../toast/ToastContext.jsx";

// Settings card for push notifications on this device (phone or desktop).
// Subscribing needs the service worker (registered only in the production
// build) and, on iPhone/iPad, the app installed to the home screen first.

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export default function PushNotifications() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [serverReady, setServerReady] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(supported() ? Notification.permission : "unsupported");

  useEffect(() => {
    if (!supported()) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { publicKey } = await getPushPublicKey();
        if (cancelled) return;
        setServerReady(Boolean(publicKey));
        setSubscribed(Boolean(await currentSubscription()));
      } catch {
        // leave defaults - the card just shows the "off" state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleEnable() {
    setBusy(true);
    try {
      const { publicKey } = await getPushPublicKey();
      if (!publicKey) {
        setServerReady(false);
        return;
      }
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") {
        showToast("Notifications were blocked - allow them in your browser or phone settings", "error");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      await subscribePush(sub.toJSON());
      setSubscribed(true);
      showToast("Notifications turned on", "success");
    } catch (err) {
      showToast(err.message || "Couldn't turn on notifications", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribed(false);
      showToast("Notifications turned off", "success");
    } catch (err) {
      showToast(err.message || "Couldn't turn off notifications", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    try {
      await sendTestPush();
      showToast("Test notification sent", "success");
    } catch (err) {
      showToast(err.message || "Couldn't send the test notification", "error");
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (!supported()) {
    body =
      isIos() && !isStandalone() ? (
        <p className="muted small">
          On iPhone/iPad, install the app first (Share, then "Add to Home Screen"), open it from the home screen,
          and turn notifications on here.
        </p>
      ) : (
        <p className="muted small">This browser doesn't support push notifications.</p>
      );
  } else if (loading) {
    body = <p className="muted small">Checking...</p>;
  } else if (!serverReady) {
    body = <p className="muted small">Push notifications aren't set up on the server yet.</p>;
  } else if (permission === "denied") {
    body = <p className="muted small">Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.</p>;
  } else if (subscribed) {
    body = (
      <>
        <p className="muted small">Notifications are on for this device.</p>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={handleTest} disabled={busy}>
            Send test notification
          </button>
          <button type="button" className="btn" onClick={handleDisable} disabled={busy}>
            Turn off
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={handleEnable} disabled={busy}>
          Turn on notifications
        </button>
      </div>
    );
  }

  return (
    <div className="card settings-section">
      <h2>Push notifications</h2>
      {body}
    </div>
  );
}
