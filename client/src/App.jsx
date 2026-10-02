import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext.jsx";
import Navbar from "./components/Navbar.jsx";
import Home from "./pages/Home.jsx";
import Jobs from "./pages/Jobs.jsx";
import Workers from "./pages/Workers.jsx";
import Login from "./pages/Login.jsx";
import ForgotPassword from "./pages/ForgotPassword.jsx";
import ResetPassword from "./pages/ResetPassword.jsx";
import Settings from "./pages/Settings.jsx";

// Guards a route: bounces to /login (remembering where the user was headed)
// if nobody's signed in. Rendered per-route rather than wrapping the whole
// app so /login itself never needs special-casing here.
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null; // avoid a flash of the login page during the initial /me check
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}

// /login, /forgot-password, and /reset-password are all full-bleed,
// centered-card screens with no navbar - /reset-password is reachable even
// while logged in (see its route below), so which layout to use is
// decided by the current path, not just by whether `user` is set, or an
// already-logged-in person clicking a reset link would see the navbar
// stacked awkwardly on top of that card instead of the plain screen below.
const BARE_PAGES = ["/login", "/forgot-password", "/reset-password"];

export default function App() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;

  const isBarePage = BARE_PAGES.includes(location.pathname);

  return (
    <div className="app-shell">
      {user && !isBarePage && <Navbar />}
      <main className={isBarePage ? "app-content app-content-bare" : "app-content"}>
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
          <Route path="/forgot-password" element={user ? <Navigate to="/" replace /> : <ForgotPassword />} />
          {/* Unlike /login and /forgot-password above, this one does NOT bounce
              an already-logged-in user to "/" - a reset link has to keep
              working even if you're still signed in elsewhere (e.g. the
              Settings page's "send reset email" button, used precisely
              while logged in), since the whole point is setting a new
              password via the emailed token, independent of any existing
              session. */}
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Home />
              </RequireAuth>
            }
          />
          <Route
            path="/jobs"
            element={
              <RequireAuth>
                <Jobs />
              </RequireAuth>
            }
          />
          <Route
            path="/workers"
            element={
              <RequireAuth>
                <Workers />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <Settings />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
