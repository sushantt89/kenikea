import { useState } from "react";
import { Link } from "react-router-dom";
import { forgotPassword } from "../api.js";

// Step 1 of "forgot password": ask for the account's email, always show
// the same generic confirmation regardless of whether it matched an
// account (the server behaves the same way - see routes/auth.js - so
// there's genuinely nothing more specific this page could truthfully
// say). Step 2 is ResetPassword.jsx, reached via the emailed link.
export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await forgotPassword(email);
      setMessage(result.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="card login-card">
        <h1>Forgot password</h1>
        <span className="muted small login-subtitle">
          Enter your account email and we'll send you a link to reset your password.
        </span>

        {error && <div className="form-error">{error}</div>}

        {message ? (
          <p className="banner banner-success">{message}</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
                {submitting ? "Sending..." : "Send reset link"}
              </button>
            </div>
          </form>
        )}

        <p className="muted small" style={{ marginTop: 14, textAlign: "center" }}>
          <Link to="/login">Back to log in</Link>
        </p>
      </div>
    </div>
  );
}
