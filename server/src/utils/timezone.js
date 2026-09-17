/**
 * Timezone conversion helpers, hand-rolled from JavaScript's built-in Intl
 * API rather than pulling in a timezone-data package (moment-timezone,
 * date-fns-tz, luxon, ...) - Node's Intl.DateTimeFormat already ships with
 * the full IANA timezone database, including each zone's daylight-saving
 * rules, so nothing extra needs to be installed for this.
 */

const partsFormatterCache = new Map();

function getPartsFormatter(timeZone) {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock date/time a UTC instant reads as inside `timeZone`. */
export function zonedParts(date, timeZone) {
  const parts = getPartsFormatter(timeZone).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: map.hour === "24" ? 0 : Number(map.hour), // some engines print midnight as "24"
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Converts a *wall-clock* date/time meant in a specific IANA timezone (e.g.
 * "7:00am on 24 Aug 2026, Australia/Adelaide time") into the real UTC
 * instant it represents - correctly applying that zone's own DST rules for
 * that particular date, not just whatever its offset happens to be today.
 *
 * Standard technique: take a naive guess (treat the wall-clock numbers as
 * if they were already UTC), see what that guess actually reads as inside
 * the target zone, and correct by the difference. This is exact except
 * inside the ~1hr window right at a DST transition, where it can be off by
 * the DST delta - a small, known tradeoff for a business tool, same spirit
 * as the rest of this app's date parsing (see README > Timezones).
 *
 * @param {number} year
 * @param {number} month - 0-11, matches Date's own convention
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {string} timeZone - an IANA zone name, e.g. "Australia/Adelaide"
 */
export function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month, day, hour, minute, 0, 0);
  const seenInZone = zonedParts(new Date(guess), timeZone);
  const asIfUtc = Date.UTC(
    seenInZone.year,
    seenInZone.month - 1,
    seenInZone.day,
    seenInZone.hour,
    seenInZone.minute,
    seenInZone.second
  );
  const diff = asIfUtc - guess;
  return new Date(guess - diff);
}

/**
 * Formats a UTC instant for display inside `timeZone`, with that zone's own
 * current abbreviation appended (e.g. "ACST" or "ACDT" - Intl works out
 * which one applies for that particular date automatically).
 */
export function formatInZone(isoOrDate, timeZone, options = {}) {
  if (!isoOrDate) return null;
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...options,
  }).format(d);
}
