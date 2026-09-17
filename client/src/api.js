const BASE = "/api";

// The logged-in user's session token (see AuthContext.jsx), kept as a
// module-level variable so every api.js call can attach it without every
// caller having to pass it through by hand. AuthContext calls
// setAuthToken() whenever login/logout happens; this line just means a
// page refresh doesn't momentarily forget it before AuthContext mounts.
let authToken = null;
try {
  authToken = localStorage.getItem("authToken");
} catch {
  // localStorage can throw in some contexts (private browsing, disabled
  // storage) - just start logged out rather than crashing the app.
}

export function setAuthToken(token) {
  authToken = token;
  try {
    if (token) localStorage.setItem("authToken", token);
    else localStorage.removeItem("authToken");
  } catch {
    // best-effort only - see above
  }
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;

  if (!res.ok) {
    // Only treat a 401 as "your session in THIS app expired" when it's
    // actually one of the two messages requireAuth (server/src/middleware/
    // auth.js) sends. Every other error - including a Beehiive-login-link
    // or Beehiive-session problem from the /scrape endpoint - must NOT log
    // the user out of the whole app just because it happens to reuse status
    // 401 for its own, unrelated reason. (Server-side, those Beehiive cases
    // now use 409 instead of 401 for exactly this reason - this check is a
    // second, independent safety net in case anything else ever reuses 401.)
    const isAppSessionExpired =
      res.status === 401 &&
      (body?.error === "Please log in to continue." ||
        body?.error === "Your account no longer exists - please log in again.");
    if (isAppSessionExpired) {
      // Session expired/invalid - let AuthContext know so it can clear
      // itself and send the user back to the login page, from wherever in
      // the app this happened to fire.
      window.dispatchEvent(new Event("auth:unauthorized"));
    }
    const message = body?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }

  return body;
}

// Auth
export const login = (email, password) =>
  request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const getMe = () => request("/auth/me");
export const getUsers = () => request("/auth/users");
export const createUser = (data) => request("/auth/users", { method: "POST", body: JSON.stringify(data) });
export const deleteUser = (id) => request(`/auth/users/${id}`, { method: "DELETE" });

// Workers
export const getWorkers = () => request("/workers");
export const getWorker = (id) => request(`/workers/${id}`);
export const createWorker = (data) => request("/workers", { method: "POST", body: JSON.stringify(data) });
export const updateWorker = (id, data) =>
  request(`/workers/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteWorker = (id) => request(`/workers/${id}`, { method: "DELETE" });

// Jobs
export const getJobs = () => request("/jobs");
export const getJob = (id) => request(`/jobs/${id}`);
export const scrapeJobLink = (url, authHeader) =>
  request("/jobs/scrape", { method: "POST", body: JSON.stringify({ url, authHeader }) });
export const createJob = (data) => request("/jobs", { method: "POST", body: JSON.stringify(data) });
export const updateJob = (id, data) => request(`/jobs/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const deleteJob = (id) => request(`/jobs/${id}`, { method: "DELETE" });
export const getCandidates = (id) => request(`/jobs/${id}/candidates`);
export const assignJob = (id) => request(`/jobs/${id}/assign`, { method: "POST" });
export const assignJobTo = (id, workerId) =>
  request(`/jobs/${id}/assign-to/${workerId}`, { method: "PUT" });
export const setWorkerPayout = (id, workerId, payout) =>
  request(`/jobs/${id}/payout/${workerId}`, { method: "PUT", body: JSON.stringify({ payout }) });
export const unassignWorkerFromJob = (id, workerId) =>
  request(`/jobs/${id}/unassign-worker/${workerId}`, { method: "POST" });
export const unassignJob = (id) => request(`/jobs/${id}/unassign`, { method: "POST" });
export const completeJob = (id) => request(`/jobs/${id}/complete`, { method: "POST" });
