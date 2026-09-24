import { useEffect, useState } from "react";
import { updateWorkerAvailability } from "../api.js";
import { useToast } from "../toast/ToastContext.jsx";

// Shared by WorkerTable.jsx (Workers page) and JobCard.jsx (the "Preview
// candidates" ranking table) - a click/tap-friendly way to see a worker's
// full day-by-day fortnight-form answers, without cluttering either table
// with 14 extra columns or relying on a hover-only tooltip (which doesn't
// work on mobile). Both places show a plain "Click to see" button and open
// the same popup on click/tap - it used to show "N days synced" instead,
// but that read as a status/count rather than something clickable.

// "Tue 16 Sep" - dates are stored as plain UTC-midnight calendar days (see
// services/availabilitySync.js), so this reads them back in UTC too rather
// than letting the viewer's own local timezone shift the day shown.
function formatDayShort(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * A "Click to see" button for a worker's `formAvailability` - tapping/
 * clicking it calls `onOpen(worker)` so the caller can show FortnightModal
 * below for that worker. Shown only once there's actually something synced
 * to see (see FortnightModal's own empty state for the zero-entries case
 * when a worker IS opened with nothing synced yet).
 */
export function FortnightCell({ worker, onOpen }) {
  const entries = worker.formAvailability || [];
  if (entries.length === 0) return <span className="muted small">-</span>;
  return (
    <button type="button" className="fortnight-cell-btn" onClick={() => onOpen(worker)}>
      Click to see
    </button>
  );
}

/**
 * Tap-friendly popup listing a worker's full day-by-day fortnight answers -
 * works the same on mobile (tap to open, tap the backdrop or Close to
 * dismiss) as it does on desktop. Render once per table/page, controlled by
 * a single `worker` (or null) state value the caller owns.
 *
 * Also supports editing: an admin can manually correct a day's text (e.g.
 * a worker gave an answer over the phone, or a form answer was garbled)
 * without waiting on the next Google Form sync to overwrite it. This only
 * edits the TEXT of days that already synced - adding a brand-new day for a
 * worker with zero synced answers isn't supported here (out of scope: it'd
 * need the same 14-day period boundaries the server computes when a form
 * is created, see formManager.js).
 *
 * `worker` can be either a full Worker document (Workers page - has `_id`)
 * or a "Preview candidates" ranking/excluded entry (JobCard.jsx - has
 * `workerId` instead of `_id`, see assignment.js's rankCandidates()); both
 * shapes carry `formAvailability`/`formAvailabilitySyncedAt`, so `id` below
 * falls back to whichever one is present.
 *
 * `onSaved(updated)` is called after a successful save with the worker
 * object merged with the server's fresh formAvailability/syncedAt, so the
 * caller can update whatever local state is driving this popup (and, if it
 * wants the underlying table/ranking to reflect the edit too, refetch it).
 */
export function FortnightModal({ worker, onClose, onSaved }) {
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(false);

  const id = worker?._id ?? worker?.workerId ?? null;

  // Leaving edit mode whenever a different worker is opened (or the popup
  // closes) - half-typed corrections for one worker shouldn't leak into the
  // next one opened.
  useEffect(() => {
    setEditing(false);
    setDrafts({});
  }, [id]);

  if (!worker) return null;

  const entries = [...(worker.formAvailability || [])].sort((a, b) => new Date(a.date) - new Date(b.date));

  function startEditing() {
    const next = {};
    for (const e of entries) next[e.date] = e.text;
    setDrafts(next);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updatedEntries = entries.map((e) => ({ date: e.date, text: (drafts[e.date] ?? e.text).trim() }));
      const result = await updateWorkerAvailability(id, updatedEntries);
      showToast(`Updated ${worker.name}'s availability`, "success");
      setEditing(false);
      onSaved?.({ ...worker, ...result });
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  }

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
        ) : editing ? (
          <ul className="fortnight-modal-list fortnight-modal-list-editing">
            {entries.map((e) => (
              <li key={e.date}>
                <span className="fortnight-modal-date">{formatDayShort(e.date)}</span>
                <input
                  type="text"
                  className="fortnight-modal-input"
                  value={drafts[e.date] ?? ""}
                  onChange={(ev) => setDrafts((d) => ({ ...d, [e.date]: ev.target.value }))}
                  placeholder="e.g. 8:00 AM - 5:00 PM"
                  disabled={saving}
                />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="fortnight-modal-list">
            {entries.map((e) => (
              <li key={e.date}>
                <span className="fortnight-modal-date">{formatDayShort(e.date)}</span>
                <span className="fortnight-modal-text">
                  {e.text}
                  {e.parsed && e.parsed.trim().toLowerCase() !== e.text.trim().toLowerCase() ? (
                    <span className="fortnight-modal-parsed"> ({e.parsed})</span>
                  ) : !e.parsed ? (
                    <span className="fortnight-modal-parsed fortnight-modal-unclear"> (unclear - ask for am/pm)</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {entries.length > 0 && (
          <div className="fortnight-modal-actions">
            {editing ? (
              <>
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary btn-small" onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-secondary btn-small" onClick={startEditing}>
                Edit
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
