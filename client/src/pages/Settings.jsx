import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { useTheme } from "../theme/ThemeContext.jsx";
import { getUsers, createUser, deleteUser } from "../api.js";
import { useToast } from "../toast/ToastContext.jsx";

const EMPTY_FORM = { name: "", email: "", password: "", confirmPassword: "" };

export default function Settings() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const { showToast } = useToast();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  async function loadUsers() {
    setLoading(true);
    setListError("");
    try {
      setUsers(await getUsers());
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleAddUser(e) {
    e.preventDefault();
    setFormError("");

    if (form.password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    if (form.password !== form.confirmPassword) {
      setFormError("Passwords don't match.");
      return;
    }

    setSaving(true);
    try {
      await createUser({ name: form.name, email: form.email, password: form.password });
      setForm(EMPTY_FORM);
      showToast(`${form.name} added as a user`, "success");
      await loadUsers();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(u) {
    if (!window.confirm(`Remove ${u.name}'s login? They won't be able to log in anymore.`)) return;
    try {
      await deleteUser(u._id);
      showToast(`${u.name}'s login removed`, "success");
      await loadUsers();
    } catch (err) {
      setListError(err.message);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="card settings-section">
        <h2>Appearance</h2>
        <p className="muted small">Choose how the app looks on this device.</p>
        <div className="theme-toggle" role="group" aria-label="Theme">
          <button type="button" className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
            Light
          </button>
          <button type="button" className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
            Dark
          </button>
        </div>
      </div>

      <div className="card settings-section">
        <h2>Users</h2>
        <p className="muted small">Anyone with a login here can use the whole app.</p>

        {formError && <div className="form-error">{formError}</div>}

        <form className="settings-form" onSubmit={handleAddUser}>
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
                autoComplete="off"
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Password
              <input
                type="password"
                value={form.password}
                onChange={(e) => update("password", e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                value={form.confirmPassword}
                onChange={(e) => update("confirmPassword", e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Adding..." : "+ Add user"}
            </button>
          </div>
        </form>

        {listError && <div className="banner banner-error">{listError}</div>}

        {loading ? (
          <p>Loading users...</p>
        ) : (
          <div className="user-list">
            {users.map((u) => (
              <div className="user-row" key={u._id}>
                <div className="user-row-info">
                  <strong>
                    {u.name}
                    {u._id === user?._id && <span className="you-tag">You</span>}
                  </strong>
                  <span className="muted small">{u.email}</span>
                </div>
                {u._id !== user?._id && (
                  <button className="btn btn-small btn-danger" onClick={() => handleDelete(u)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
