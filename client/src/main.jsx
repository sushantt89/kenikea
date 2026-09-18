import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./auth/AuthContext.jsx";
import { ThemeProvider } from "./theme/ThemeContext.jsx";
import { ToastProvider } from "./toast/ToastContext.jsx";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* AuthProvider needs the router (useNavigate) so it can send the
          user to /login on logout or when a session expires. ThemeProvider
          has no such dependency but lives alongside it here since both are
          app-wide concerns that everything else renders inside.
          ToastProvider is outermost of the three so a toast fired right
          before a route change (e.g. saving a job on Home.jsx, which
          navigates to /jobs immediately after) still renders - it isn't
          torn down by the navigation the way a page-local banner would be. */}
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
