import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Persists the Beehiive session cookies produced by the one-time
 * Playwright login-link flow (see fetchViaBrowser() in scraper.js), so a
 * later plain fetch() to a direct jobs.beehiive.com/jobs/... link can reuse
 * them instead of needing that slow, resource-heavy headless-browser step
 * again - exactly like a real browser stays logged in to a site after you
 * follow a login link there once, and a plain address bar visit afterwards
 * just works.
 *
 * Stored as a plain JSON file next to the server code (NOT committed to
 * git - see .gitignore) rather than in MongoDB, since this is disposable,
 * server-local session state, not application data - deleting it just
 * means the next login link is needed again, nothing is lost.
 */

const SESSION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".beehiive-session.json");

/**
 * Real domain-match rule for whether a saved cookie should be sent to a
 * given host - the same rule a real browser uses (RFC 6265), and the piece
 * that was missing before: Beehiive turned out to set TWO different
 * PHPSESSID cookies - one host-only cookie scoped to auth.beehiive.com
 * (from the login page itself) and a separate host-only one scoped to
 * jobs.beehiive.com (the real, logged-in session). Both contain
 * "beehiive.com" so both used to get saved AND both got sent together in
 * one ambiguous "Cookie: PHPSESSID=x; PHPSESSID=y" header - which server
 * ends up reading is undefined, and in practice it was picking the wrong
 * (unauthenticated, auth.beehiive.com) one, so the direct jobs.beehiive.com
 * link still looked logged-out even with a valid session cookie attached.
 *
 * Playwright/Chromium's own convention (used here) is: a cookie's `domain`
 * has a leading "." when it was set as a wildcard/domain cookie (applies to
 * that domain AND its subdomains); no leading "." means a host-only cookie
 * that must only ever be sent back to that exact host.
 */
function cookieAppliesToHost(cookieDomain, host) {
  if (!cookieDomain || !host) return false;
  const h = host.toLowerCase();
  const cd = cookieDomain.toLowerCase();
  if (cd.startsWith(".")) {
    const base = cd.slice(1);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === cd; // host-only cookie: exact host match only, no subdomains
}

/**
 * @param {Array<{name: string, value: string, domain: string, expires: number}>} cookies
 *   Playwright's own cookie shape (from context.cookies()) - `expires` is a
 *   Unix timestamp in seconds, or -1 for a session-only cookie.
 */
export async function saveSessionCookies(cookies) {
  const all = cookies || [];
  const relevant = all.filter((c) => c.domain && c.domain.includes("beehiive.com"));

  // TEMPORARY DEBUG LOGGING - see the "second time still not working" note
  // in scraper.js's file header for why this is here. Safe to remove once
  // session reuse is confirmed working against the real site: this never
  // logs cookie *values*, only names/domains, so it's fine to leave running
  // even against production traffic if it turns out to be useful longer term.
  console.log(
    `[beehiive-session] browser context had ${all.length} cookie(s) total; ${relevant.length} on a beehiive.com domain.`
  );
  if (all.length > 0) {
    console.log(
      "[beehiive-session] all cookie domains/names seen:",
      all.map((c) => `${c.name}@${c.domain}`).join(", ")
    );
  }

  if (relevant.length === 0) {
    console.warn(
      "[beehiive-session] NOT saving a session - no cookies on a beehiive.com domain were found after login. " +
        "If Beehiive uses something other than a domain cookie for its session (e.g. a token kept in localStorage), " +
        "cookie replay can never work here and a different approach is needed."
    );
    return;
  }

  try {
    await fs.writeFile(
      SESSION_FILE,
      JSON.stringify({ savedAt: Date.now(), cookies: relevant }, null, 2),
      "utf8"
    );
    console.log(
      `[beehiive-session] saved ${relevant.length} cookie(s) to ${SESSION_FILE}:`,
      relevant.map((c) => c.name).join(", ")
    );
  } catch (err) {
    // Best-effort only - if this fails, the next direct-link scrape just
    // won't have a session to reuse and falls back to needing a fresh login
    // link, rather than the whole scrape erroring out over this.
    console.warn("[beehiive-session] could not save session cookies:", err.message);
  }
}

/**
 * Builds a `Cookie:` header value from whatever session is currently saved,
 * skipping any cookie that's already expired.
 *
 * @param {string} [forHost] - the exact host the request is actually going
 *   to (e.g. "jobs.beehiive.com"). When given, only cookies that really
 *   apply to THAT host (see cookieAppliesToHost above) are included - this
 *   is what stops a cookie meant for a different beehiive.com subdomain
 *   (e.g. the login page's own auth.beehiive.com session) from being sent
 *   alongside the real one and confusing the server about which session to
 *   use. Omitted only for callers that just want to know "is there some
 *   saved session at all" rather than build a real request header.
 *
 * Returns null if there's no saved session at all, or nothing in it is
 * still valid/applicable - callers should treat that the same as "not
 * logged in".
 */
export async function loadSessionCookieHeader(forHost) {
  let raw;
  try {
    raw = await fs.readFile(SESSION_FILE, "utf8");
  } catch {
    console.log(`[beehiive-session] no saved session file at ${SESSION_FILE} - nothing to reuse.`);
    return null; // no saved session yet
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn("[beehiive-session] saved session file is corrupt JSON - treating as no session.");
    return null;
  }

  const now = Date.now();
  const notExpired = (data.cookies || []).filter((c) => c.expires === -1 || c.expires * 1000 > now);
  const applicable = forHost ? notExpired.filter((c) => cookieAppliesToHost(c.domain, forHost)) : notExpired;
  console.log(
    `[beehiive-session] loaded session file saved ${Math.round((now - data.savedAt) / 1000)}s ago: ` +
      `${data.cookies?.length || 0} cookie(s) stored, ${notExpired.length} not expired` +
      (forHost ? `, ${applicable.length} actually apply to ${forHost}: ${applicable.map((c) => `${c.name}@${c.domain}`).join(", ") || "none"}.` : ".")
  );
  if (applicable.length === 0) return null;

  return applicable.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * Deletes the saved session. Called once a direct-link fetch confirms a
 * saved session is actually stale (the response still looks like a login
 * page), so the NEXT attempt fails fast with a clear "please log in again"
 * message instead of silently retrying a cookie already known to be dead.
 */
export async function clearSession() {
  try {
    await fs.unlink(SESSION_FILE);
  } catch {
    // already gone, or never existed - fine either way
  }
}
