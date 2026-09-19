import { useState, useEffect } from "react";
import DatePicker from "react-datepicker";
import "react-datepicker/dist/react-datepicker.css";
import { WORK_AREAS, timezoneForWorkArea } from "../utils/workAreas.js";
import { zonedParts, zonedTimeToUtc } from "../utils/timezone.js";

// react-datepicker works with real JS Date objects rather than the native
// datetime-local input's plain string, but a Date has no timezone of its
// own - it's just an instant, and reading it back via its LOCAL getters
// (getFullYear/getHours/etc, which is how react-datepicker itself displays
// and reports a value) depends on whatever timezone the browser happens to
// be in. So exactly like the old string-based helpers below used to, these
// treat the Date purely as a carrier for the JOB's own wall-clock
// Y/M/D/H/M numbers - built with `new Date(y, m, d, h, min)` (never
// Date.UTC) so react-datepicker's local getters come back with exactly
// those numbers regardless of the viewer's real timezone. "7:00am" here
// always means 7:00am at the job's actual location - see
// timezoneForWorkArea() - however this page is being viewed.
function toPickerDate(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const { year, month, day, hour, minute } = zonedParts(d, timeZone);
  return new Date(year, month - 1, day, hour, minute);
}

function fromPickerDate(date, timeZone) {
  if (!date || Number.isNaN(date.getTime())) return null;
  const d = zonedTimeToUtc(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    timeZone
  );
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

  // A manually-created job (see Home.jsx's "+ Create a job manually")
  // never has a sourceUrl at all, unlike a scraped draft - used here to
  // adjust the heading and hide the (otherwise blank/meaningless) Source
  // line further down.
  const isManual = !form.sourceUrl;
  // Editing an already-saved job (opened from JobCard.jsx's "Edit" button)
  // reuses this exact same form - only a saved job ever has an _id, so
  // that's what tells the two apart for the heading/button wording below.
  const isEdit = Boolean(form._id);

  return (
    <div className="card draft-card">
      <h2>{isEdit ? "Edit job" : isManual ? "New job (manual)" : "Review scraped job"}</h2>
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
          <DatePicker
            selected={toPickerDate(form.scheduledStart, timeZone)}
            onChange={(date) => update("scheduledStart", fromPickerDate(date, timeZone))}
            showTimeSelect
            timeIntervals={15}
            dateFormat="EEE d MMM yyyy, h:mm aa"
            placeholderText="Not set"
            isClearable
            autoComplete="off"
            wrapperClassName="scheduled-start-wrapper"
            calendarClassName="scheduled-start-calendar"
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
          <span className="muted small">Proposed worker payout preview (after 10% GST, 75% share)</span>
          <strong>{formatAdminPayPreview(form.chargesTotal)}</strong>
        </div>
      </div>

      {!isManual && <p className="muted small">Source: {form.sourceUrl}</p>}

      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onDiscard} disabled={saving}>
          {isEdit ? "Cancel" : "Discard"}
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : isEdit ? "Save changes" : "Save job"}
        </button>
      </div>
    </div>
  );
}
