// Shared by WorkerTable.jsx (Workers page) and JobCard.jsx (the "Preview
// candidates" ranking table) - a click/tap-friendly way to see a worker's
// full day-by-day fortnight-form answers, without cluttering either table
// with 14 extra columns or relying on a hover-only tooltip (which doesn't
// work on mobile). Both places show "N days synced" and open the same
// popup on click/tap.

// "Tue 16 Sep" - dates are stored as plain UTC-midnight calendar days (see
// services/availabilitySync.js), so this reads them back in UTC too rather
// than letting the viewer's own local timezone shift the day shown.
function formatDayShort(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * A worker's `formAvailability` summarised as "N days synced" - tapping/
 * clicking it calls `onOpen(worker)` so the caller can show FortnightModal
 * below for that worker.
 */
export function FortnightCell({ worker, onOpen }) {
  const entries = worker.formAvailability || [];
  if (entries.length === 0) return <span className="muted small">-</span>;
  return (
    <button type="button" className="fortnight-cell-btn" onClick={() => onOpen(worker)}>
      {entries.length} day{entries.length === 1 ? "" : "s"} synced
    </button>
  );
}

/**
 * Tap-friendly popup listing a worker's full day-by-day fortnight answers -
 * works the same on mobile (tap to open, tap the backdrop or Close to
 * dismiss) as it does on desktop. Render once per table/page, controlled by
 * a single `worker` (or null) state value the caller owns.
 */
export function FortnightModal({ worker, onClose }) {
  if (!worker) return null;
  const entries = [...(worker.formAvailability || [])].sort((a, b) => new Date(a.date) - new Date(b.date));
  return (
    <div className="fortnight-modal-backdrop" onClick={onClose}>
      <div className="fortnight-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fortnight-modal-header">
          <h3>{worker.name}'s availability</h3>
          <button type="button" className="fortnight-modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        {worker.formAvailabilitySyncedAt && (
          <p className="muted small">Last synced {new Date(worker.formAvailabilitySyncedAt).toLocaleString()}</p>
        )}
        {entries.length === 0 ? (
          <p className="muted small">No fortnight answers synced for this worker yet.</p>
        ) : (
          <ul className="fortnight-modal-list">
            {entries.map((e) => (
              <li key={e.date}>
                <span className="fortnight-modal-date">{formatDayShort(e.date)}</span>
                <span className="fortnight-modal-text">{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
