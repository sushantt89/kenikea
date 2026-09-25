import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getNotifications, markNotificationRead, markAllNotificationsRead } from "../api.js";

// How often to poll for new notifications while the app is open. There's
// no push/real-time channel from the server (see services/declineSync.js's
// header comment) - this poll IS what "checks" for a worker's calendar
// decline while you're on any page, not just Jobs, since GET /notifications
// runs that same check server-side.
const POLL_MS = 60000;

function timeAgo(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// The bell icon shown in the navbar (see Navbar.jsx). Polls for
// notifications on an interval, shows an unread-count badge, and opens a
// dropdown listing them - clicking one marks it read and jumps straight to
// the job it's about (see pages/Jobs.jsx's "focus" query param handling).
export default function NotificationBell() {
  const [notifications, setNotifications] = useState([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const navigate = useNavigate();

  async function load() {
    try {
      const data = await getNotifications();
      setNotifications(data);
    } catch {
      // Best-effort background poll - a failed check just tries again next
      // interval, no need for an error banner over a notification refresh.
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Close the dropdown on a click outside it.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  function handleSelect(n) {
    setOpen(false);
    if (!n.read) {
      setNotifications((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: true } : x)));
      markNotificationRead(n._id).catch(() => {});
    }
    // A decline notification points at a job; an availability-submission
    // one points at a worker (see models/Notification.js) - whichever one
    // it has, that's where "focus" takes you (see pages/Jobs.jsx and
    // pages/Workers.jsx's own "focus" query param handling).
    if (n.job) navigate(`/jobs?focus=${n.job}`);
    else if (n.worker) navigate(`/workers?focus=${n.worker}`);
  }

  function handleMarkAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    markAllNotificationsRead().catch(() => {});
  }

  return (
    <div className="notification-bell" ref={containerRef}>
      <button
        type="button"
        className="notification-bell-button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
      >
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && <span className="notification-bell-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>}
      </button>

      {open && (
        <div className="notification-bell-dropdown">
          <div className="notification-bell-header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button type="button" className="notification-bell-markall" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <p className="muted small notification-bell-empty">No notifications yet.</p>
          ) : (
            <ul className="notification-bell-list">
              {notifications.map((n) => (
                <li key={n._id}>
                  <button
                    type="button"
                    className={`notification-bell-item${n.read ? "" : " unread"}`}
                    onClick={() => handleSelect(n)}
                  >
                    <span className="notification-bell-message">{n.message}</span>
                    <span className="notification-bell-time">{timeAgo(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
