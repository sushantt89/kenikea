import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { resetPassword } from "../api.js";

// Step 2 of "forgot password" - reached via the link emailed by
// ForgotPassword.jsx/POST /api/auth/forgot-password, which carries the
// account's email and a one-time reset token as query params. Submitting
// a new password here calls POST /api/auth/reset-password, which verifies
// that token server-side (see services/auth.js verifyResetToken) before
// actually changing anything.
export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const email = searchParams.get("email") || "";
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const missingLinkParts = !email || !token;

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Those two passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await resetPassword({ email, token, password });
      setDone(true);
      setTimeout(() => navigate("/login", { replace: true }), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="card login-card">
        <h1>Reset password</h1>
        <span className="muted small login-subtitle">Choose a new password for {email || "your account"}.</span>

        {error && <div className="form-error">{error}</div>}

        {missingLinkParts ? (
          <p className="banner banner-error">
            This reset link looks incomplete or broken. Request a new one from the{" "}
            <Link to="/forgot-password">Forgot password</Link> page.
          </p>
        ) : done ? (
          <p className="banner banner-success">Password updated - taking you to the login page...</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label>
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
                required
                minLength={8}
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={submitting} style={{ width: "100%" }}>
                {submitting ? "Saving..." : "Set new password"}
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
