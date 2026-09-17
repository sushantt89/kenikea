// Mirrors server/src/utils/timezone.js - see that file for the full
// explanation of the Intl-based conversion trick. Duplicated rather than
// shared because the client and server are separate bundles/runtimes with
// no code path between them in this project; the browser's own
// Intl.DateTimeFormat has the same IANA timezone database Node does, so the
// logic works identically here.

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
    hour: map.hour === "24" ? 0 : Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Converts a wall-clock date/time meant in a specific IANA timezone into
 * the real UTC instant it represents. Used when saving the datetime-local
 * input in JobDraftForm - the numbers typed there are meant as the job's
 * own work-area time, not the browser's local time (see that component).
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
 * current abbreviation appended (e.g. "ACST"/"ACDT") so it's unambiguous
 * even to someone viewing from a different timezone than the job's.
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
