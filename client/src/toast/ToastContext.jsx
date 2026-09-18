import { createContext, useCallback, useContext, useRef, useState } from "react";

const ToastContext = createContext(null);

let nextId = 1;
const AUTO_DISMISS_MS = 4500;

/**
 * App-wide toast notifications - a quick "task done" confirmation shown in
 * the corner after actions like creating a job/worker, sending the
 * fortnight rollout emails, assigning a worker, etc. (see each page/
 * component's showToast() calls).
 *
 * Deliberately mounted once here at the app shell (see main.jsx), not per
 * page - some actions (e.g. saving a job draft on Home.jsx) navigate to a
 * different route immediately after, which would unmount a page-local
 * toast before anyone could read it. Living above the router means a toast
 * survives that navigation.
 */
// One small inline icon per toast type, shown at the end of the message -
// SVG rather than an emoji so it always renders identically (weight,
// alignment) regardless of the OS/browser's own emoji font.
const TOAST_ICONS = {
  success: (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="currentColor" opacity="0.15" />
      <path d="M5.5 10.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="currentColor" opacity="0.15" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="currentColor" opacity="0.15" />
      <path d="M10 6v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="13.5" r="1" fill="currentColor" />
    </svg>
  ),
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message, type = "success") => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, type }]);
      const timer = setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
      timers.current.set(id, timer);
      return id;
    },
    [dismissToast]
  );

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismissToast(t.id)}>
            <span className="toast-message">{t.message}</span>
            <span className="toast-icon">{TOAST_ICONS[t.type] || TOAST_ICONS.success}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast() must be used inside <ToastProvider>");
  return ctx;
}
