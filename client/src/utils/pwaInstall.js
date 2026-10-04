// Tracks whether the browser is offering to install this app (the
// "beforeinstallprompt" event Chrome/Edge/Android fire) so the Settings
// page can show its own "Install app" button. The event can fire long
// before Settings is ever opened, so this module (imported once from
// main.jsx) listens from page load and just remembers it.
let deferredPrompt = null;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // stop the browser's own mini-infobar; we show a button instead
  deferredPrompt = e;
  notify();
});

window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
  notify();
});

export function subscribeInstall(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function canPromptInstall() {
  return deferredPrompt != null;
}

/** Shows the browser's install dialog. Resolves to "accepted" | "dismissed" | null (nothing to show). */
export async function promptInstall() {
  if (!deferredPrompt) return null;
  const prompt = deferredPrompt;
  deferredPrompt = null;
  notify();
  prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

/** True when the app is already running as an installed app (not in a normal browser tab). */
export function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    window.navigator.standalone === true
  );
}

/** iPhone/iPad Safari has no install event - it needs the manual Share > Add to Home Screen steps. */
export function isIos() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
