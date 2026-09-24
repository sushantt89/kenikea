// Keep this list in sync with server/src/utils/workAreas.js.
export const WORK_AREAS = ["Adelaide", "Perth", "Brisbane", "NSW", "Auckland"];

// Keep in sync with server/src/utils/workAreas.js - see that file for why
// each area maps to this specific IANA zone.
export const WORK_AREA_TIMEZONE = {
  Adelaide: "Australia/Adelaide",
  Perth: "Australia/Perth",
  Brisbane: "Australia/Brisbane",
  NSW: "Australia/Sydney",
  Auckland: "Pacific/Auckland",
};

// Used to display/edit a scheduled time when its job has no work area set
// yet. The client can't read the server's TZ env var, so this is just the
// same hardcoded fallback the server uses when that var is unset too - see
// server/src/utils/workAreas.js.
export const DEFAULT_TIMEZONE = "Australia/Adelaide";

export function timezoneForWorkArea(area) {
  return WORK_AREA_TIMEZONE[area] || DEFAULT_TIMEZONE;
}

// Matches the Google Calendar colorId mapping used server-side, so the UI
// can show a small swatch next to a job/worker's area that looks like the
// color its calendar invite will actually get.
export const WORK_AREA_SWATCH = {
  Adelaide: "#1f9d55", // green
  Perth: "#d5b60a", // yellow
  Brisbane: "#7c5cff", // purple
  NSW: "#d5791f", // orange
  Auckland: "#3457d5", // blue
};

// Keep in sync with server/src/utils/workAreas.js - which country/currency
// each work area's money is actually in, so the Jobs page/JobsChart never
// silently blend a New Zealand job's dollars into an Australian total, and
// label NZD figures as such instead of a bare "$" that implies AUD.
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

export function countryForWorkArea(area) {
  return WORK_AREA_COUNTRY[area] || "Australia";
}

export function currencyForWorkArea(area) {
  return WORK_AREA_CURRENCY[area] || "AUD";
}
