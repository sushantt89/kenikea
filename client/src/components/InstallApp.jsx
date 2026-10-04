import { useEffect, useState } from "react";
import { canPromptInstall, promptInstall, subscribeInstall, isStandalone, isIos } from "../utils/pwaInstall.js";
import { useToast } from "../toast/ToastContext.jsx";

// Settings card for installing the site as an app on a phone or desktop.
// What it shows depends on what the current browser supports - see
// utils/pwaInstall.js.
export default function InstallApp() {
  const { showToast } = useToast();
  const [canPrompt, setCanPrompt] = useState(canPromptInstall());
  const [installing, setInstalling] = useState(false);
  const standalone = isStandalone();

  useEffect(() => subscribeInstall(() => setCanPrompt(canPromptInstall())), []);

  async function handleInstall() {
    setInstalling(true);
    try {
      const outcome = await promptInstall();
      if (outcome === "accepted") showToast("App installed", "success");
    } finally {
      setInstalling(false);
    }
  }

  let body;
  if (standalone) {
    body = <p className="muted small">This app is already installed on this device.</p>;
  } else if (canPrompt) {
    body = (
      <>
        <p className="muted small">
          Add this to your phone's home screen or your computer's apps, so it opens in its own window like any
          other app.
        </p>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={handleInstall} disabled={installing}>
            {installing ? "Installing..." : "Install app"}
          </button>
        </div>
      </>
    );
  } else if (isIos()) {
    body = (
      <p className="muted small">
        On iPhone/iPad: open this page in Safari, tap the Share button, then choose "Add to Home Screen".
      </p>
    );
  } else {
    body = (
      <p className="muted small">
        Use your browser's menu and choose "Install app" (or "Add to Home screen" on a phone). If you don't see
        it, open this page in Chrome, Edge or Safari.
      </p>
    );
  }

  return (
    <div className="card settings-section">
      <h2>Install app</h2>
      {body}
    </div>
  );
}
