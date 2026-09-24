/**
 * The five work areas this business operates in. Used in two places:
 *   - Worker.workArea (server/src/models/Worker.js) - which area a worker
 *     is based in, purely informational/organisational.
 *   - Job.workArea (server/src/models/Job.js) - which area a JOB is in,
 *     auto-guessed from its address text when scraped (see guessWorkArea
 *     below) but editable by hand. This is what drives the Google Calendar
 *     event color (see services/googleCalendar.js) - deliberately the
 *     job's own area, not whichever worker ends up assigned, so the color
 *     stays the same even if the assignment changes later.
 *
 * Google Calendar event colors are a fixed built-in palette identified by
 * numeric "colorId" - there's no way to set an arbitrary hex color on an
 * event, only one of Google's 11 presets. The mapping below is the
 * business's own requested color per area, using Google Calendar's own
 * names for each preset:
 *   10 = Basil, 5 = Banana, 3 = Grape, 6 = Tangerine, 7 = Peacock
 */

export const WORK_AREAS = ["Adelaide", "Perth", "Brisbane", "NSW", "Auckland"];

/**
 * The real IANA timezone each work area sits in - used to parse a scraped
 * job's "Expected date 7:00am ... (ACST)" style wall-clock time into the
 * correct real UTC instant, and to display it back out the same way (see
 * utils/timezone.js). NSW and Auckland observe daylight saving; Perth and
 * Brisbane don't; Adelaide's is the odd 30-minute-offset one - all of that
 * is handled automatically by the IANA zone itself, nothing hardcoded here.
 */
export const WORK_AREA_TIMEZONE = {
  Adelaide: "Australia/Adelaide",
  Perth: "Australia/Perth",
  Brisbane: "Australia/Brisbane",
  NSW: "Australia/Sydney",
  Auckland: "Pacific/Auckland",
};

// Used whenever a job's work area isn't known yet (not guessed from the
// scraped address, not set by hand) but a scheduled time still needs *some*
// zone to be interpreted/displayed in. Falls back to the TZ env var (the
// business's original single-timezone setting, see .env.example) and then
// to Adelaide specifically, rather than silently using whatever OS
// timezone the server machine happens to be running in.
export const DEFAULT_TIMEZONE = process.env.TZ || "Australia/Adelaide";

/** The timezone to use for a job/worker's work area, with the fallback above. */
export function timezoneForWorkArea(area) {
  return WORK_AREA_TIMEZONE[area] || DEFAULT_TIMEZONE;
}

export const WORK_AREA_COLOR_IDS = {
  Adelaide: "10", // Basil
  Perth: "5", // Banana
  Brisbane: "3", // Grape
  NSW: "6", // Tangerine
  Auckland: "7", // Peacock
};

/**
 * Which country/currency each work area's money is actually in - used
 * wherever a job's IKEA payout, admin pay or profit is calculated or
 * displayed (services/pay.js, routes/jobs.js, and the client's Jobs page +
 * JobsChart), so a New Zealand job's dollars are never silently added
 * straight into an Australian one's, and NZD figures are labeled as such
 * rather than shown with a plain "$" that implies AUD. All four Australian
 * areas use AUD; Auckland uses NZD.
 */
export const WORK_AREA_COUNTRY = {
  Adelaide: "Australia",
  Perth: "Australia",
  Brisbane: "Australia",
  NSW: "Australia",
  Auckland: "New Zealand",
};

export const WORK_AREA_CURRENCY = {
  Adelaide: "AUD",
  Perth: "AUD",
  Brisbane: "AUD",
  NSW: "AUD",
  Auckland: "NZD",
};

export const CURRENCY_SYMBOL = { AUD: "A$", NZD: "NZ$" };

/**
 * The country a work area is in, defaulting to Australia (the original,
 * single-country assumption this app started with) for a job/worker with
 * no work area set yet.
 */
export function countryForWorkArea(area) {
  return WORK_AREA_COUNTRY[area] || "Australia";
}

/** The currency a work area's money is in - same default reasoning as
 * countryForWorkArea() above. */
export function currencyForWorkArea(area) {
  return WORK_AREA_CURRENCY[area] || "AUD";
}

// Keyword guesses used to auto-tag a scraped job's area from its address/
// description text - order matters (checked top to bottom, first match
// wins), so put more specific/common tokens first if that ever changes.
const WORK_AREA_PATTERNS = [
  { area: "NSW", pattern: /\bnsw\b|\bsydney\b/i },
  { area: "Brisbane", pattern: /\bqld\b|\bbrisbane\b/i },
  { area: "Perth", pattern: /\bwa\b|\bperth\b/i },
  { area: "Adelaide", pattern: /\bsa\b|\badelaide\b/i },
  { area: "Auckland", pattern: /\bauckland\b|\bnew zealand\b|\bnz\b/i },
];

/**
 * Best-guess work area from free text (an address is enough). Returns null
 * when nothing matches - the UI/user can still set it by hand.
 */
export function guessWorkArea(text) {
  if (!text) return null;
  for (const { area, pattern } of WORK_AREA_PATTERNS) {
    if (pattern.test(text)) return area;
  }
  return null;
}
