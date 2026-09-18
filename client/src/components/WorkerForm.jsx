import { useState, useEffect } from "react";
import { WORK_AREAS } from "../utils/workAreas.js";

const EMPTY = {
  name: "",
  email: "",
  location: "",
  lat: "",
  lng: "",
  workArea: "",
  gender: "Prefer not to say",
  phone: "",
  skillLevel: 3,
  priority: "Medium",
};

export default function WorkerForm({ initial, onSubmit, onCancel, submitLabel = "Save" }) {
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (initial) {
      setForm({
        ...EMPTY,
        ...initial,
        lat: initial.lat ?? "",
        lng: initial.lng ?? "",
        workArea: initial.workArea ?? "",
      });
    } else {
      setForm(EMPTY);
    }
  }, [initial]);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (!form.name.trim() || !form.email.trim() || !form.location.trim()) {
      setError("Name, email, and location are required.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit(form);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="worker-form" onSubmit={handleSubmit}>
      {error && <div className="form-error">{error}</div>}

      <div className="form-row">
        <label>
          Name
          <input value={form.name} onChange={(e) => update("name", e.target.value)} required />
        </label>
        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
            required
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Location
          <input
            value={form.location}
            onChange={(e) => update("location", e.target.value)}
            placeholder="e.g. Adelaide CBD"
            required
          />
        </label>
        <label>
          Phone
          <input value={form.phone} onChange={(e) => update("phone", e.target.value)} />
        </label>
      </div>

      <p className="muted small">
        Coordinates are looked up automatically from the location above (for real distance-based
        matching) - only set these by hand to override that.
      </p>
      <div className="form-row">
        <label>
          Latitude (auto-detected if left blank)
          <input
            type="number"
            step="any"
            value={form.lat}
            onChange={(e) => update("lat", e.target.value)}
            placeholder="-34.9285"
          />
        </label>
        <label>
          Longitude (auto-detected if left blank)
          <input
            type="number"
            step="any"
            value={form.lng}
            onChange={(e) => update("lng", e.target.value)}
            placeholder="138.6007"
          />
        </label>
      </div>

      <div className="form-row">
        <label>
          Gender
          <select value={form.gender} onChange={(e) => update("gender", e.target.value)}>
            <option>Male</option>
            <option>Female</option>
            <option>Other</option>
            <option>Prefer not to say</option>
          </select>
        </label>
        <label>
          Priority
          <select value={form.priority} onChange={(e) => update("priority", e.target.value)}>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
        </label>
      </div>

      <div className="form-row">
        <label>
          Work area
          <select value={form.workArea} onChange={(e) => update("workArea", e.target.value)}>
            <option value="">Not set</option>
            {WORK_AREAS.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="form-row">
        <label>
          Skill level (1-5)
          <input
            type="number"
            min="1"
            max="5"
            value={form.skillLevel}
            onChange={(e) => update("skillLevel", Number(e.target.value))}
            required
          />
        </label>
      </div>

      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "Saving..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
