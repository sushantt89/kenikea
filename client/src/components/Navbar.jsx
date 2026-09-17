import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext.jsx";

// A small hamburger toggle handles narrow/mobile widths (see the
// .navbar-toggle / .navbar-links.open rules in styles.css); on wider
// screens the toggle is hidden by CSS and the links just show inline as
// before, so this component works the same regardless of screen size.
export default function Navbar() {
  const [open, setOpen] = useState(false);
  const { user, logout } = useAuth();

  const linkClass = ({ isActive }) => (isActive ? "active" : "");
  const closeMenu = () => setOpen(false);

  return (
    <header className="navbar">
      <div className="navbar-brand">Worker Assignment</div>

      <button
        type="button"
        className="navbar-toggle"
        aria-label="Toggle navigation menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span />
        <span />
        <span />
      </button>

      <nav className={`navbar-links ${open ? "open" : ""}`}>
        <NavLink to="/" end className={linkClass} onClick={closeMenu}>
          Home
        </NavLink>
        <NavLink to="/jobs" className={linkClass} onClick={closeMenu}>
          Jobs
        </NavLink>
        <NavLink to="/workers" className={linkClass} onClick={closeMenu}>
          Workers
        </NavLink>
        <NavLink to="/settings" className={linkClass} onClick={closeMenu}>
          Settings
        </NavLink>
        {user && <span className="navbar-user-name">{user.name}</span>}
        <button
          type="button"
          className="navbar-logout"
          onClick={() => {
            closeMenu();
            logout();
          }}
        >
          Log out
        </button>
      </nav>
    </header>
  );
}
