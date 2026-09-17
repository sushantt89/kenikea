import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { setAuthToken, login as apiLogin, getMe } from "../api.js";

const AuthContext = createContext(null);

/**
 * Holds the logged-in user (or null) for the whole app. On mount, if a
 * token was saved from a previous visit (see api.js), it's verified against
 * the server via GET /api/auth/me rather than trusted blindly - an expired
 * or since-revoked token just quietly logs the user back out instead of the
 * app pretending they're still signed in.
 *
 * Must be rendered inside a <BrowserRouter> (see main.jsx) since it uses
 * useNavigate to send the user to /login both on explicit logout and
 * whenever any API call comes back 401 (see the "auth:unauthorized" event
 * dispatched from api.js) - that covers a session expiring while the app is
 * already open, not just the initial page load.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
    navigate("/login");
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then(({ user }) => {
        if (!cancelled) setUser(user);
      })
      .catch(() => {
        // No token, or it's no longer valid - api.js already cleared it via
        // the 401 handler below; nothing else to do here.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally only on mount - login()/logout() manage `user` directly
    // from then on rather than re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    window.addEventListener("auth:unauthorized", logout);
    return () => window.removeEventListener("auth:unauthorized", logout);
  }, [logout]);

  async function login(email, password) {
    const { token, user } = await apiLogin(email, password);
    setAuthToken(token);
    setUser(user);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be used inside <AuthProvider>");
  return ctx;
}
