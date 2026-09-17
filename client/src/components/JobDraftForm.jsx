import { useState, useEffect } from "react";
import { WORK_AREAS, timezoneForWorkArea } from "../utils/workAreas.js";
import { zonedParts, zonedTimeToUtc } from "../utils/timezone.js";

// <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" and hands the same
// format back. Rather than the browser's own local time (which would show
// a different clock reading depending on where whoever's using the app
// happens to be), these show/parse it as the wall-clock time in the JOB's
// own work area - see timezoneForWorkArea() - so "7:00am" here always means
// 7:00am at the job's actual location, however this page is being viewed.
function toDatetimeLocal(iso, timeZone) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const { year, month, day, hour, minute } = zonedParts(d, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
}

function fromDatetimeLocal(value, timeZone) {
  if (!value) return null;
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) return null;
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const d = zonedTimeToUtc(year, month - 1, day, hour, minute, timeZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Mirrors server/src/services/pay.js purely for an instant on-screen
// preview as the user types - the real, authoritative number is always
// computed server-side on save. This is the ADMIN/business's own cut, not
// what any worker gets paid - see JobCard.jsx for the per-worker payout,
// which is entered by hand once a worker is actually assigned.
function formatAdminPayPreview(chargesTotal) {
  const total = Number(chargesTotal);
  if (!Number.isFinite(total) || total <= 0) return "-";
  const afterGst = total * 0.9;
  const adminPay = afterGst * 0.75;
  return `$${adminPay.toFixed(2)} (of $${total.toFixed(2)} - $${afterGst.toFixed(2)} after GST)`;
}

export default function JobDraftForm({ draft, onSave, onDiscard }) {
  const [form, setForm] = useState(draft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(draft), [draft]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function updateCustomer(field, value) {
    setForm((f) => ({ ...f, customer: { ...(f.customer || {}), [field]: value } }));
  }

  const timeZone = timezoneForWorkArea(form.workArea);

  async function handleSave() {
    setError("");
    if (!form.title.trim() || !form.location.trim()) {
      setError("Title and location are required before saving.");
      return;
    }
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card draft-card">
      <h2>Review scraped job</h2>
      {form.extraction?.notes && (
        <div className="banner banner-warning">Heads up: {form.extraction.notes}. Please double check the fields below.</div>
      )}
      {error && <div className="form-error">{error}</div>}

      <div className="form-row">
        <label>
          Title
          <input value={form.title} onChange={(e) => update("title", e.target.value)} />
        </label>
      </div>

      <label>
        Description
        <textarea
          rows={4}
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
        />
      </label>

      <div className="form-row">
        <label>
          Location
          <input value={form.location} onChange={(e) => update("location", e.target.value)} />
        </label>
        <label>
          Difficulty
          <select value={form.difficulty} onChange={(e) => update("difficulty", e.target.value)}>
            <option value="Easy">Easy (under 1 hour)</option>
            <option value="Medium">Medium (1-3 hours)</option>
            <option value="Difficult">Difficult (over 3 hours)</option>
          </select>
        </label>
      </div>

      <div className="form-row">
        <label>
          Work area
          <select value={form.workArea || ""} onChange={(e) => update("workArea", e.target.value || null)}>
            <option value="">Not set</option>
            {WORK_AREAS.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="muted small">
        Coordinates are looked up automatically from the location above - only set these by hand
        to override that.
      </p>
      <div className="form-row">
        <label>
          Latitude (auto-detected if left blank)
          <input
            type="number"
            step="any"
            value={form.lat ?? ""}
            onChange={(e) => update("lat", e.target.value)}
          />
        </label>
        <label>
          Longitude (optional)
          <input
            type="number"
            step="any"
            value={form.lng ?? ""}
            onChange={(e) => update("lng", e.target.value)}
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Scheduled start (optional - {form.workArea ? `${form.workArea} local time` : "default local time - set a work area above for the exact zone"}, used for the calendar invite)
          <input
            type="datetime-local"
            value={toDatetimeLocal(form.scheduledStart, timeZone)}
            onChange={(e) => update("scheduledStart", fromDatetimeLocal(e.target.value, timeZone))}
          />
        </label>
        <label>
          Duration (minutes)
          <input
            type="number"
            min="15"
            step="15"
            value={form.durationMinutes ?? 60}
            onChange={(e) => update("durationMinutes", Number(e.target.value))}
          />
        </label>
      </div>

      <label>
        Priority
        <select value={form.priority} onChange={(e) => update("priority", e.target.value)}>
          <option>Low</option>
          <option>Medium</option>
          <option>High</option>
        </select>
      </label>

      <div className="form-row">
        <label>
          Customer name (optional)
          <input value={form.customer?.name || ""} onChange={(e) => updateCustomer("name", e.target.value)} />
        </label>
        <label>
          Customer phone (optional)
          <input value={form.customer?.phone || ""} onChange={(e) => updateCustomer("phone", e.target.value)} />
        </label>
      </div>

      <div className="form-row">
        <label>
          IKEA payout / charges total ($AUD, optional)
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.chargesTotal ?? ""}
            onChange={(e) => update("chargesTotal", e.target.value === "" ? null : Number(e.target.value))}
          />
        </label>
        <div className="pay-preview">
          <span className="muted small">Admin pay preview (after 10% GST, 75% share)</span>
          <strong>{formatAdminPayPreview(form.chargesTotal)}</strong>
        </div>
      </div>

      <p className="muted small">Source: {form.sourceUrl}</p>

      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onDiscard} disabled={saving}>
          Discard
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save job"}
        </button>
      </div>
    </div>
  );
}
