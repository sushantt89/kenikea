/**
 * Dependency-free-ish job scraper.
 *
 * Uses Node's built-in fetch (Node 18+) so no HTTP client library is
 * required for most sites, and a handful of regexes to pull useful fields
 * out of a job posting page. This is intentionally a *best effort*
 * extraction: real job sites vary wildly in structure, so every field it
 * produces is meant to be reviewed/edited by the user in the UI before the
 * job is saved.
 *
 * The link the user pastes may already contain an access token as a query
 * parameter (e.g. https://example.com/jobs/123?token=abc) - that is fetched
 * as-is, no special handling needed. If a site instead expects the token as
 * an Authorization header, pass it via the optional `authHeader` argument.
 *
 * BEEHIIVE LOGIN LINKS ARE DIFFERENT, AND NEED A REAL BROWSER. A link like
 * https://auth.beehiive.com/login?token=... looks like it should redeem the
 * token via a normal HTTP redirect (that was the original assumption here,
 * and a hand-written cookie-carrying redirect-follower used to live in this
 * file to handle it) - but checking it in DevTools showed that request
 * actually comes back as a plain HTTP 200, not a 301/302. There is no
 * server-side redirect to follow at all: the page loads normally and then
 * its own JavaScript redeems the token and navigates to the real job page
 * (e.g. https://jobs.beehiive.com/jobs/123/accept). A plain fetch() has no
 * JavaScript engine, so it can never see that navigation happen - it just
 * gets stuck looking at the initial (login-ish) page forever, no matter
 * what headers or cookie handling are added on top. The only thing that
 * actually works here is running a real, invisible browser - see
 * fetchViaBrowser() below.
 *
 * That browser step only needs to happen ONCE per login, though - exactly
 * like a real browser tab, once the login link has been followed and the
 * session cookie set, a plain visit to a direct jobs.beehiive.com/jobs/...
 * link afterwards just works without logging in again. fetchViaBrowser()
 * saves the resulting cookies (see beehiiveSession.js), and the plain-fetch
 * path below reuses them on a direct link - so the slow/heavy headless
 * browser is only needed again once that saved session actually expires.
 */

import { guessWorkArea, timezoneForWorkArea, DEFAULT_TIMEZONE } from "../utils/workAreas.js";
import { zonedTimeToUtc } from "../utils/timezone.js";
import { saveSessionCookies, loadSessionCookieHeader, clearSession } from "./beehiiveSession.js";

const FETCH_TIMEOUT_MS = 15000;
const BROWSER_NAV_TIMEOUT_MS = 20000;
const BROWSER_REDIRECT_TIMEOUT_MS = 12000;

// Used for BOTH the Playwright browser (which logs in and creates the
// Beehiive session) and the plain fetch() that replays it afterward (see
// scrapeJob() below). Many sites tie a session cookie to the browser
// "identity" (User-Agent, and the Client Hints headers real Chrome always
// sends alongside it) that created it, as a basic anti-hijacking check -
// if the login happens as one browser identity and the cookie is then
// replayed as a different one, the server can quietly treat it as
// suspicious/invalid even though the cookie value itself is correct. Using
// the exact same identity for both closes that gap.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const DESKTOP_CLIENT_HINTS = {
  "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/**
 * Loads a URL in a real (headless) Chromium browser via Playwright and
 * returns the final, fully-rendered page - the only reliable way to handle
 * a login page that redeems its token and navigates onward via JavaScript
 * rather than a real HTTP redirect (see the file header for how this was
 * confirmed against the real Beehiive login flow).
 *
 * If `waitForUrlPattern` is given, this waits for the browser to actually
 * navigate to a URL matching it (e.g. onto jobs.beehiive.com) before
 * reading the page - but only up to `redirectTimeoutMs`. If the token is
 * invalid/expired, the page simply never navigates away, so that wait
 * times out harmlessly and this just returns whatever's currently on
 * screen (the login page itself), which looksLikeLoginPage() then
 * correctly flags as a failure rather than hanging or throwing here.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.authHeader] - sent as a real Authorization header on every request the browser makes
 * @param {RegExp} [opts.waitForUrlPattern] - if given, wait for navigation to a URL matching this before reading the page
 * @param {number} [opts.navTimeoutMs]
 * @param {number} [opts.redirectTimeoutMs]
 * @returns {Promise<{html: string, finalUrl: string}>}
 */
async function fetchViaBrowser(
  url,
  { authHeader, waitForUrlPattern, navTimeoutMs = BROWSER_NAV_TIMEOUT_MS, redirectTimeoutMs = BROWSER_REDIRECT_TIMEOUT_MS } = {}
) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new HttpError(
      500,
      "This link needs a real browser to log in (its login page uses JavaScript, not a plain redirect), but the 'playwright' package isn't set up on the server yet. Run `npm install` in server/, then `npx playwright install chromium`, and try again."
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new HttpError(
      500,
      `Could not start the headless browser needed for this link (${err.message}). Make sure Chromium is installed - run \`npx playwright install chromium\` in server/.`
    );
  }

  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      extraHTTPHeaders: {
        ...DESKTOP_CLIENT_HINTS,
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });
    const page = await context.newPage();

    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
    } catch (err) {
      throw new HttpError(504, `Timed out loading that link in the browser: ${err.message}`);
    }

    if (response && !response.ok()) {
      throw new HttpError(response.status(), `The link responded with ${response.status()} ${response.statusText()}.`);
    }

    // Give the page's own JavaScript a chance to redeem the token and
    // navigate onward. A timeout here is expected (and harmless) whenever
    // that doesn't happen - see the function doc comment above.
    if (waitForUrlPattern) {
      await page.waitForURL(waitForUrlPattern, { timeout: redirectTimeoutMs }).catch(() => {});
    } else {
      await page.waitForLoadState("networkidle", { timeout: redirectTimeoutMs }).catch(() => {});
    }

    const finalUrl = page.url();
    const html = await page.content();

    // Only save cookies when the login actually appears to have worked -
    // saving cookies off a still-on-the-login-screen page (e.g. an
    // expired/invalid token) would just persist a session that isn't
    // really logged in, and the next direct-link fetch would fail anyway
    // (see looksLikeLoginPage below).
    const stillOnLoginScreen = looksLikeLoginPage(html);
    console.log(
      `[beehiive-session] login link navigated to ${finalUrl}; page ${
        stillOnLoginScreen ? "still looks like a login screen (NOT saving a session)" : "looks like a real logged-in page"
      }.`
    );
    if (!stillOnLoginScreen) {
      const cookies = await context.cookies();
      await saveSessionCookies(cookies);
    }

    return { html, finalUrl };
  } finally {
    await browser.close();
  }
}

function looksLikeLoginPage(html) {
  // Real Beehiive job pages carry unmistakable markers (their own job-ID
  // title, the customer's "OrderNumber" line, the map-marker icon next to
  // the address). If any of those are present, trust that over the
  // heuristics below - a shared site layout can bake a hidden login
  // modal/link into *every* page (including the real job page itself),
  // which would otherwise cause a false "still on the login screen"
  // result even though the login actually succeeded and the job rendered
  // fine. This was confirmed happening in practice: a link that opened
  // the real job page correctly in a browser was still being flagged
  // here, purely because of this heuristic.
  const hasJobPageMarkers =
    /<title[^>]*>\s*Job\s+\d+\s*<\/title>/i.test(html) ||
    /<b>\s*OrderNumber\s*<\/b>/i.test(html) ||
    /fa-map-marker/i.test(html);
  if (hasJobPageMarkers) return false;

  if (/<input[^>]+type=["']password["']/i.test(html)) return true;
  const visibleText = stripHtml(html).slice(0, 500).toLowerCase();
  return /\blog\s?in\b/.test(visibleText) || /\bsign\s?in\b/.test(visibleText);
}

// Job.difficulty is a plain three-level label now (Easy/Medium/Difficult -
// see the file-level note near difficultyFromMinutes() below for why), so
// every source of a difficulty guess here ultimately produces one of those
// three strings rather than a 1-5 number.
const TIER_ORDER = ["Easy", "Medium", "Difficult"];

function numberToTier(n) {
  if (n <= 2) return "Easy";
  if (n <= 3) return "Medium";
  return "Difficult";
}

/** One tier up (Easy -> Medium -> Difficult), capped at Difficult. */
function bumpTier(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(i + 1, TIER_ORDER.length - 1)];
}

const DIFFICULTY_KEYWORDS = [
  { pattern: /\b(entry[\s-]?level|no experience|beginner|trainee|junior)\b/i, value: "Easy" },
  { pattern: /\b(some experience|intermediate)\b/i, value: "Medium" },
  { pattern: /\b(experienced|skilled|senior)\b/i, value: "Difficult" },
  { pattern: /\b(expert|advanced|master|highly skilled|specialist)\b/i, value: "Difficult" },
];

// These match text like "difficulty: 4/5" or "skill level - 2" - still
// expressed as a 1-5 number in the source text, so the captured digit is
// mapped onto the three-tier scale via numberToTier().
const EXPLICIT_DIFFICULTY_PATTERNS = [
  /difficulty\s*[:\-]\s*(\d)\s*(?:\/\s*5)?/i,
  /skill\s*level\s*[:\-]\s*(\d)\s*(?:\/\s*5)?/i,
  /(\d)\s*\/\s*5\s*(?:difficulty|skill)/i,
];

const YEARS_EXPERIENCE_PATTERN = /(\d+)\s*\+?\s*years?\s+(?:of\s+)?experience/i;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const LOCATION_PATTERNS = [
  /location\s*[:\-]\s*([^\n<]{2,60})/i,
  /based\s+in\s+([A-Z][a-zA-Z.\s]{2,40}?)(?:[.,\n]|$)/,
  /\blocated\s+in\s+([A-Z][a-zA-Z.\s]{2,40}?)(?:[.,\n]|$)/i,
];

const PRIORITY_KEYWORDS = [
  { pattern: /\b(urgent|asap|immediate(?:ly)?|high priority)\b/i, value: "High" },
  { pattern: /\b(low priority|whenever|no rush)\b/i, value: "Low" },
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag && titleTag[1].trim()) return stripHtml(titleTag[1]).slice(0, 200);

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1[1].trim()) return stripHtml(h1[1]).slice(0, 200);

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1].slice(0, 200);

  return "Untitled job";
}

function extractMetaDescription(html) {
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (meta) return meta[1];
  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1];
  return "";
}

function guessDifficulty(text) {
  for (const { pattern } of EXPLICIT_DIFFICULTY_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { value: numberToTier(clamp(Number(m[1]), 1, 5)), confidence: "high" };
  }

  const yearsMatch = text.match(YEARS_EXPERIENCE_PATTERN);
  if (yearsMatch) {
    const years = Number(yearsMatch[1]);
    let value = "Easy";
    if (years >= 5) value = "Difficult";
    else if (years >= 2) value = "Medium";
    return { value, confidence: "medium" };
  }

  for (const { pattern, value } of DIFFICULTY_KEYWORDS) {
    if (pattern.test(text)) return { value, confidence: "medium" };
  }

  return { value: "Medium", confidence: "low" };
}

function guessLocation(text) {
  for (const pattern of LOCATION_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { value: m[1].trim().replace(/\s{2,}/g, " "), confidence: "medium" };
  }
  return { value: "", confidence: "low" };
}

function guessPriority(text) {
  for (const { pattern, value } of PRIORITY_KEYWORDS) {
    if (pattern.test(text)) return value;
  }
  return "Medium";
}

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Fetch a job posting and pull out a best-guess draft.
 * @param {string} url - full URL, may already include an access token as a query param
 * @param {string} [authHeader] - optional raw Authorization header value, e.g. "Bearer xyz"
 */
export async function scrapeJob(url, authHeader) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "That doesn't look like a valid URL.");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new HttpError(400, "Only http(s) URLs are supported.");
  }

  // A Beehiive login link needs a real (headless) browser - see the file
  // header and fetchViaBrowser() above for why. Every other URL, including
  // a jobs.beehiive.com link pasted directly, is fetched the plain, direct
  // way below - a direct beehiive.com job link reuses the session cookies
  // saved from the last time a login link was followed (see
  // beehiiveSession.js), same as it would in a real browser tab.
  const isBeehiiveLoginLink = parsed.hostname === "auth.beehiive.com";
  const isBeehiiveJobPage = parsed.hostname === "jobs.beehiive.com";

  if (isBeehiiveLoginLink) {
    const { html, finalUrl } = await fetchViaBrowser(url, {
      authHeader,
      waitForUrlPattern: /jobs\.beehiive\.com/,
    });

    if (looksLikeLoginPage(html)) {
      // NOT 401: a 401 from ANY endpoint is treated by the frontend
      // (client/src/api.js) as "your session in THIS app expired" and force
      // logs the user out of the whole worker-assignment app - but this 401
      // would be about Beehiive's login link, a completely unrelated
      // external session. Use 409 (Conflict) instead so it just shows as a
      // normal scrape error.
      throw new HttpError(
        409,
        "Logging in with that link didn't work - the page still looks like a login screen, which usually means the token has expired. Try a fresh login link from a new job notification."
      );
    }

    return draftFromBeehiiveHtml(html, finalUrl);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // Looks like a real desktop Chrome session rather than a script - some
  // sites bounce an obvious bot/script User-Agent to a different response
  // even for an otherwise plain, public page. Uses the exact same UA and
  // Client Hints as the Playwright browser above (DESKTOP_UA /
  // DESKTOP_CLIENT_HINTS) - for a Beehiive job page specifically, this
  // also matters for session validity: if the server ties the session
  // cookie to the browser identity that created it, this fetch needs to
  // look like the same browser that logged in, not just any browser.
  const requestHeaders = {
    "User-Agent": DESKTOP_UA,
    ...DESKTOP_CLIENT_HINTS,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    ...(authHeader ? { Authorization: authHeader } : {}),
  };

  // Reuse whatever session was saved the last time a login link was
  // followed through the browser (fetchViaBrowser above) - this is what
  // lets a direct jobs.beehiive.com/jobs/... link work on its own after
  // that first login, without needing the slow headless-browser step again
  // each time, same as staying logged in in a real browser tab.
  if (isBeehiiveJobPage) {
    // Pass the actual target host so only cookies that really apply to
    // jobs.beehiive.com are sent - see the domain-match comment in
    // beehiiveSession.js for why this matters (Beehiive turned out to set
    // a SEPARATE, host-only session cookie for auth.beehiive.com too).
    const cookieHeader = await loadSessionCookieHeader(parsed.hostname);
    if (cookieHeader) {
      requestHeaders.Cookie = cookieHeader;
      console.log(`[beehiive-session] attaching saved session to direct link fetch: ${url}`);
    } else {
      console.log(`[beehiive-session] no saved session available - fetching direct link with no cookies: ${url}`);
    }
  }

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: requestHeaders,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new HttpError(504, "Timed out fetching that link.");
    }
    throw new HttpError(502, `Could not reach that link: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new HttpError(
      response.status,
      `The link responded with ${response.status} ${response.statusText}. If it needs a login, make sure the token in the URL is valid, or pass an Authorization header.`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();

  if (contentType.includes("application/json")) {
    return draftFromJson(raw, url);
  }

  // Real Beehiive job pages are plain server-rendered HTML with a known
  // structure (confirmed against an actual page) - route those to the
  // dedicated parser instead of generic guessing.
  if (isBeehiiveJobPage) {
    const directLinkLooksLikeLogin = looksLikeLoginPage(raw);
    console.log(
      `[beehiive-session] direct link response for ${url} ${
        directLinkLooksLikeLogin ? "still looks like a login screen" : "looks like a real job page"
      } (cookie was ${requestHeaders.Cookie ? "" : "NOT "}attached).`
    );
    if (directLinkLooksLikeLogin) {
      // Either there was no saved session yet, or it's expired - either
      // way, a plain fetch can't log in on its own (there's no token in
      // THIS url to redeem, only the original login link had one). Clear
      // whatever's saved so the next attempt fails with this same clear
      // message right away, instead of silently retrying a cookie that's
      // already known to be dead.
      await clearSession();
      // NOT 401 - see the comment on the other Beehiive HttpError above:
      // a 401 here would incorrectly trigger the frontend's global
      // "your app session expired, log out" handler. This is Beehiive's
      // session, not this app's, so it uses 409 instead.
      throw new HttpError(
        409,
        "This job page needs you to be logged in to Beehiive, and there's no valid saved session (either you haven't used a login link yet, or it's expired). Paste a fresh Beehiive login link (the auth.beehiive.com/login?token=... one from a job notification) once - after that, direct jobs.beehiive.com links like this one will work on their own until the session expires again."
      );
    }
    return draftFromBeehiiveHtml(raw, url);
  }

  return draftFromHtml(raw, url);
}

/**
 * Parses the REAL rendered Beehiive job page (e.g. .../jobs/694369/accept),
 * confirmed against an actual redacted copy of one during development.
 * This is plain server-rendered HTML, not JSON - so unlike
 * draftFromBeehiiveJob() below (which parses the JSON payload shape this
 * app was originally built against), this pulls fields directly out of the
 * markup: the customer block sits right after a map-marker icon (name,
 * then a tel: link, then the address across two lines), "Expected date" is
 * a heading immediately followed by a paragraph with the same
 * "7:00am to 5:00pm Wed 23rd Sep 2026 (AEST)" shape already handled by
 * parseExpectedDate(), and the allocated-minutes line matches the same
 * "83 mins (1.38 hrs) allocated" pattern already handled by
 * parseAllocatedMinutes() - both regexes are reused unchanged.
 */
function draftFromBeehiiveHtml(html, url) {
  const text = stripHtml(html);

  const idMatch = html.match(/<title[^>]*>\s*Job\s+(\d+)\s*<\/title>/i);
  const jobId = idMatch ? idMatch[1] : "";

  // The recurring "Attend, set up and commence IKEA assembly" line (also
  // seen in the JSON payload format) makes the best short title when
  // present - matched against the raw HTML (not the stripped text) so the
  // match stops cleanly at the paragraph boundary instead of running on
  // into whatever text follows.
  const attendMatch = html.match(/<p>\s*(Attend,\s*set up and commence[^<]*)<\/p>/i);
  const categoryMatch = html.match(/class="markdown">\s*<h2>([^<]+)<\/h2>/i);
  const category = categoryMatch ? categoryMatch[1].trim() : "";
  const title = attendMatch
    ? attendMatch[1].trim()
    : category
    ? `${category} - Job ${jobId}`.trim()
    : `Job ${jobId || "Unknown"}`;

  const phoneMatch = html.match(/href="tel:([^"]+)"/i);
  const phone = phoneMatch ? phoneMatch[1] : "";

  const emailMatch = html.match(/href="mailto:([^"]+)"/i);
  const email = emailMatch ? emailMatch[1] : "";

  // Customer name sits as a bare <b>Name</b> immediately above the tel:
  // link in the "Job site" block. The old `fa-map-marker ... <br` pattern
  // never actually matched the real template (the map-marker icon there is
  // followed by the "Job site" heading text, not the customer's name), so
  // customerName always came back empty. The service center's <b>company
  // name</b> also precedes a tel: link further down the page, but it's
  // wrapped in its own <a>, and that intervening </a> tag breaks the \s*
  // gap this regex requires before <br>, so it doesn't get matched instead.
  const nameMatch = html.match(/<b>([^<]+?)<\/b>\s*<br\s*\/?>\s*<a href="tel:/i);
  const customerName = nameMatch ? nameMatch[1].trim() : "";

  // The job's street address lives in an <address> block (usually wrapping
  // a Google Maps directions link) under the "Job site" heading. This used
  // to match <span title="on site"> instead, which is actually the job-type
  // badge over in the unrelated "Service center" column (on site / Furniture
  // Cabinetry, etc.) - that's why "location" was coming through as literal
  // text like "on site Furniture Cabinetry" instead of a real address.
  const addressBlockMatch =
    html.match(/<address>\s*<a[^>]*>([\s\S]*?)<\/a>\s*<\/address>/i) ||
    html.match(/<address>([\s\S]*?)<\/address>/i);
  const address = addressBlockMatch
    ? stripHtml(addressBlockMatch[1].replace(/<br\s*\/?>/gi, ", ")).trim()
    : "";

  const orderNumberMatch = html.match(/<b>OrderNumber<\/b>\s*([\s\S]*?)<\/p>/i);
  const orderNumber = orderNumberMatch ? stripHtml(orderNumberMatch[1]).trim() : "";

  const allocatedMinutes = parseAllocatedMinutes(text);
  // Work area needs to be known BEFORE parsing the scheduled time, so the
  // "7:00am ... (AEST)" wall-clock text gets interpreted in the right real
  // timezone for wherever this job actually is, not the server's own - see
  // parseExpectedDate() and utils/timezone.js.
  //
  // Guess from the ADDRESS first, and only fall back to the whole page's
  // text if that comes up empty. Every Beehiive page includes the logged-in
  // account's own profile email in its nav menu (e.g. "lumlee.nsw@yahoo.com"
  // in the corner dropdown) - guessWorkArea's \bnsw\b pattern happily matches
  // "nsw" inside that email (the surrounding "." and "@" count as word
  // boundaries), and NSW is checked before Adelaide/Perth/etc, so scanning
  // the full page text let a totally unrelated account email override a
  // perfectly good "SA 5069" in the real address. The address alone doesn't
  // have this problem.
  const workArea = guessWorkArea(address) || guessWorkArea(text);
  const scheduledStart = parseExpectedDate(text, timezoneForWorkArea(workArea));
  const commitTime = parseCommitTime(html);

  const productLis = [...html.matchAll(/<li>\s*([\s\S]*?)\s*<\/li>/gi)].map((m) => stripHtml(m[1]));
  // Tidy up spacing left behind by stripping inline tags like <em> out of
  // things like "60616849 (<em>2 pkgs</em>) -" -> "60616849 ( 2 pkgs ) -".
  const products = cleanProductList(productLis).map((p) => p.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")"));

  const isSecureIt = /secure\s*it/i.test(text);
  const isOverdue = /overdue/i.test(text);

  let difficulty = difficultyFromMinutes(allocatedMinutes);
  if (isSecureIt) difficulty = bumpTier(difficulty);
  if (products.length >= 6) difficulty = bumpTier(difficulty);

  const totalMatch = text.match(/Total\s+([\d,]+\.\d{2})\s*AUD/i);
  const chargesTotal = totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : null;

  const descriptionParts = [];
  if (products.length) descriptionParts.push(`Products: ${products.join("; ")}`);
  if (allocatedMinutes) descriptionParts.push(`Estimated duration: ${allocatedMinutes} mins`);
  if (orderNumber) descriptionParts.push(`Order #: ${orderNumber}`);
  if (customerName) descriptionParts.push(`Customer: ${customerName}${phone ? ` (${phone})` : ""}`);
  if (chargesTotal != null) descriptionParts.push(`Charges total: ~$${chargesTotal.toFixed(2)}`);
  if (isSecureIt) descriptionParts.push("May require IKEA Secure It! - please verify on site");
  if (commitTime) descriptionParts.push(`Must commit to attend: ${commitTime.toLocaleString()}`);

  const notes = [];
  if (!scheduledStart) notes.push("couldn't parse an exact scheduled date/time, please set it manually");
  if (!address) notes.push("no address found, please fill in the location");

  return {
    title: title.slice(0, 200),
    description: (descriptionParts.join(". ") || text.slice(0, 500)).slice(0, 2000),
    sourceUrl: url,
    location: address,
    workArea,
    difficulty,
    priority: isOverdue || /\b(urgent|asap)\b/i.test(text) ? "High" : "Medium",
    scheduledStart: scheduledStart ? scheduledStart.toISOString() : null,
    durationMinutes: allocatedMinutes || 60,
    customer: { name: customerName, phone, email },
    chargesTotal,
    extraction: {
      confidence: scheduledStart && address ? "high" : "medium",
      notes: notes.join("; "),
    },
  };
}

function parseCommitTime(html) {
  const m = html.match(/<time\s+datetime="([^"]+)"[^>]*>/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function draftFromHtml(html, url) {
  const title = extractTitle(html);
  const metaDescription = extractMetaDescription(html);
  const bodyText = stripHtml(html);
  const combinedText = `${metaDescription} ${bodyText}`.slice(0, 20000);

  const difficulty = guessDifficulty(combinedText);
  const location = guessLocation(combinedText);
  const priority = guessPriority(combinedText);

  const notes = [];
  if (difficulty.confidence === "low") notes.push("difficulty guessed with a default, please check");
  if (!location.value) notes.push("couldn't find a location, please fill it in");

  return {
    title,
    description: (metaDescription || bodyText).slice(0, 2000),
    sourceUrl: url,
    location: location.value,
    // Address first, whole-page text only as a fallback - see the long
    // comment on the equivalent line in draftFromBeehiiveHtml() above for
    // why (a generic job page's markup can just as easily have an account
    // email or other stray text in its header/footer that happens to
    // contain a state abbreviation).
    workArea: guessWorkArea(location.value) || guessWorkArea(combinedText),
    difficulty: difficulty.value,
    priority,
    scheduledStart: null,
    durationMinutes: 60,
    customer: { name: "", phone: "", email: "" },
    chargesTotal: null,
    extraction: {
      confidence: lowestConfidence([difficulty.confidence, location.confidence]),
      notes: notes.join("; "),
    },
  };
}

function draftFromJson(raw, url) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(502, "That link returned JSON that couldn't be parsed.");
  }

  // Recognise the InstallEzi/Beehiive-style job payload
  // ({ success, job: { jobId, location: { address }, description: [...], ... } })
  // and parse it properly instead of falling back to generic guessing.
  if (data && data.job && (data.job.jobId || data.job.location?.address || Array.isArray(data.job.description))) {
    return draftFromBeehiiveJob(data.job, url);
  }

  // Try a handful of common field names used by other job/ATS APIs.
  const pick = (...keys) => {
    for (const key of keys) {
      const val = key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), data);
      if (typeof val === "string" && val.trim()) return val.trim();
    }
    return "";
  };

  const title = pick("title", "job_title", "position", "name") || "Untitled job";
  const description = pick("description", "job_description", "summary", "details");
  const location = pick("location", "job_location", "city", "address");
  const combinedText = `${title} ${description}`;
  const difficulty = guessDifficulty(combinedText);
  const priority = guessPriority(combinedText);

  return {
    title,
    description: description.slice(0, 2000),
    sourceUrl: url,
    location,
    // Same "address/location first, other text only as a fallback" fix as
    // the other three spots in this file - see the long comment on
    // draftFromBeehiiveHtml() above.
    workArea: guessWorkArea(location) || guessWorkArea(combinedText),
    difficulty: difficulty.value,
    priority,
    scheduledStart: null,
    durationMinutes: 60,
    customer: { name: "", phone: "", email: "" },
    chargesTotal: null,
    extraction: {
      confidence: location ? "medium" : "low",
      notes: location ? "" : "couldn't find a location field in the JSON response, please fill it in",
    },
  };
}

/**
 * Parses the real job payload format from the InstallEzi / Beehiive
 * assembly-job marketplace, e.g.:
 *   { success: true, job: { jobId, title, scheduled: {start, display},
 *     location: {address}, customer: {name, phone, email},
 *     serviceCentre: {distance}, products: [...], description: [...],
 *     notes: [...], charges: [...], sourceUrl } }
 *
 * The interesting bits (scheduled date, allocated minutes, product count)
 * are buried inside free-text `description` entries rather than their own
 * fields, so this pulls them out with a couple of targeted regexes.
 */
function draftFromBeehiiveJob(job, url) {
  const descriptionArr = Array.isArray(job.description) ? job.description : [];
  const allText = descriptionArr.join(" \n ");

  const title = (job.title && job.title.trim()) || pickShortTitle(descriptionArr) || `Job #${job.jobId || ""}`.trim();

  const products = cleanProductList(job.products);
  const allocatedMinutes = parseAllocatedMinutes(allText);

  const location = job.location?.address || "";
  const customer = job.customer || {};
  // Same ordering reason as draftFromBeehiiveHtml above: guess the work
  // area first so a fallback-parsed time (see below) is interpreted in the
  // right real timezone for this job, not the server's own. Address first,
  // description text only as a fallback - see the long comment in
  // draftFromBeehiiveHtml() for why (lower risk here since allText is just
  // this job's own description entries, not a whole page's nav/footer
  // boilerplate, but the same "location is more trustworthy" logic applies).
  const workArea = guessWorkArea(location) || guessWorkArea(allText);

  // job.scheduled.start (when present) is a real timestamp straight from
  // the source API - it already carries its own correct absolute instant,
  // so it's used as-is. Only the free-text "Expected date ..." fallback
  // needs timezone help, since that's parsed from a bare wall-clock string.
  const scheduledFromField = job.scheduled?.start ? new Date(job.scheduled.start) : null;
  const scheduledStart =
    scheduledFromField && !Number.isNaN(scheduledFromField.getTime())
      ? scheduledFromField
      : parseExpectedDate(allText, timezoneForWorkArea(workArea));

  let difficulty = difficultyFromMinutes(allocatedMinutes);
  if (hasSecureIt(job)) difficulty = bumpTier(difficulty);
  if (products.length >= 6) difficulty = bumpTier(difficulty);

  let chargesTotal = null;
  if (Array.isArray(job.charges) && job.charges.length) {
    const total = job.charges.reduce((sum, c) => sum + (parseFloat(c.price) || 0), 0);
    if (total > 0) chargesTotal = Math.round((total + Number.EPSILON) * 100) / 100;
  }

  const descriptionParts = [];
  if (products.length) descriptionParts.push(`Products: ${products.join("; ")}`);
  if (allocatedMinutes) descriptionParts.push(`Estimated duration: ${allocatedMinutes} mins`);
  if (job.serviceCentre?.distance) descriptionParts.push(`Distance to job: ${job.serviceCentre.distance}`);
  if (customer.name) {
    descriptionParts.push(`Customer: ${customer.name}${customer.phone ? ` (${customer.phone})` : ""}`);
  }
  if (chargesTotal != null) descriptionParts.push(`Charges total: ~$${chargesTotal.toFixed(2)}`);

  const notes = [];
  if (!scheduledStart) notes.push("couldn't parse an exact scheduled date/time, please set it manually");
  if (!location) notes.push("no address found, please fill in the location");

  return {
    title: title.slice(0, 200),
    description: (descriptionParts.join(". ") || allText.slice(0, 500)).slice(0, 2000),
    sourceUrl: job.sourceUrl || url,
    location,
    workArea,
    difficulty,
    priority: /\b(urgent|asap)\b/i.test(allText) ? "High" : "Medium",
    scheduledStart: scheduledStart ? scheduledStart.toISOString() : null,
    durationMinutes: allocatedMinutes || 60,
    customer: {
      name: customer.name || "",
      phone: customer.phone || "",
      email: customer.email || "",
    },
    chargesTotal,
    extraction: {
      confidence: scheduledStart && location ? "high" : "medium",
      notes: notes.join("; "),
    },
  };
}

function pickShortTitle(descriptionArr) {
  const candidates = descriptionArr.filter(
    (d) => typeof d === "string" && d.trim().length > 0 && d.length <= 120 && !/expected date/i.test(d)
  );
  if (!candidates.length) return "";
  return candidates.sort((a, b) => a.length - b.length)[0].trim();
}

function cleanProductList(products) {
  if (!Array.isArray(products)) return [];
  // Real product lines look like "2 x 20616549 - BESTÅ TV bnch...".
  // Other array entries are instructional filler text - drop those.
  return products.filter((p) => typeof p === "string" && /^\d+\s*x\s/i.test(p.trim()));
}

function parseAllocatedMinutes(text) {
  const m = text.match(/(\d+)\s*mins?\s*\([\d.]+\s*hrs?\)\s*allocated/i);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} text
 * @param {string} [timeZone] - IANA zone the scraped wall-clock time is
 *   actually in (see call sites - guessed from the job's address/work area
 *   before this is called). Defaults to DEFAULT_TIMEZONE if not given, e.g.
 *   for any other caller that doesn't yet know the job's area.
 */
function parseExpectedDate(text, timeZone = DEFAULT_TIMEZONE) {
  // e.g. "Expected date 7:00am to 5:00pm Mon 24th Aug 2026 (ACST)". The
  // "(ACST)" part is deliberately not used to pick the zone - it's an
  // ambiguous abbreviation (AEST is shared by both NSW and Brisbane, which
  // differ in daylight saving), whereas the caller's guessed work area maps
  // to an exact IANA zone that already knows each area's own DST rules.
  const m = text.match(
    /expected date\s+(\d{1,2}:\d{2}\s*[ap]m)\s+to\s+\d{1,2}:\d{2}\s*[ap]m\s+\w{3}\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\w{3,9})\s+(\d{4})/i
  );
  if (!m) return null;

  const [, startTimeStr, dayStr, monStr, yearStr] = m;
  const month = MONTHS[monStr.slice(0, 3).toLowerCase()];
  if (month === undefined) return null;

  const { hours, minutes } = parseClockTime(startTimeStr);
  if (hours == null) return null;

  const date = zonedTimeToUtc(Number(yearStr), month, Number(dayStr), hours, minutes, timeZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseClockTime(str) {
  const m = str.match(/(\d{1,2}):(\d{2})\s*([ap])m/i);
  if (!m) return { hours: null, minutes: null };
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const isPM = m[3].toLowerCase() === "p";
  if (isPM && hours !== 12) hours += 12;
  if (!isPM && hours === 12) hours = 0;
  return { hours, minutes };
}

// Duration-based difficulty: under 1hr is Easy, 1-3hrs is Medium, over 3hrs
// is Difficult. Secure It! items and large product counts (handled at each
// call site via bumpTier()) bump the tier up one notch on top of this.
function difficultyFromMinutes(mins) {
  if (mins == null) return "Medium";
  if (mins < 60) return "Easy";
  if (mins <= 180) return "Medium";
  return "Difficult";
}

function hasSecureIt(job) {
  try {
    return JSON.stringify(job).toLowerCase().includes("secureit") || JSON.stringify(job).toLowerCase().includes("secure it");
  } catch {
    return false;
  }
}

function lowestConfidence(list) {
  if (list.includes("low")) return "low";
  if (list.includes("medium")) return "medium";
  return "high";
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}