import { zonedParts } from "../utils/timezone.js";
import { timezoneForWorkArea } from "../utils/workAreas.js";

/**
 * Turns a worker's free-text fortnightly-form answer for ONE day (e.g.
 * "8-5", "8 to 5", "8am-5pm", "Not available", "Available all day") into a
 * usable time window, so the assignment engine (services/assignment.js) can
 * check whether a job's scheduled time actually falls inside it - replacing
 * the old plain on/off `Worker.availability` checkbox, which is no longer
 * shown in the UI at all (see WorkerForm.jsx).
 *
 * Used for BOTH ways a worker's answer reaches this app: the ORIGINAL,
 * hand-made form's answers (read via the Sheets-based fallback in
 * availabilitySync.js) and the form this app creates itself each fortnight
 * (see formManager.js) - both ask the same free-text "8-5" style question
 * per day, so both need the same guesswork below.
 *
 * The trickiest part here is a bare-number range with no am/pm given, e.g.
 * "8-5" or "8-11". The business only ever schedules jobs from 8am to 6pm,
 * which actually removes almost all the ambiguity: within that window,
 * every bare hour number has exactly one sensible reading - 8, 9, 10 and
 * 11 can only mean morning (the business never starts before 8am), 12 can
 * only mean noon, and 1 through 6 can only mean afternoon (the business
 * never runs past 6pm) - see resolveBareHour() below. So "8-11" is 8am-
 * 11am (not 11pm - that would be well past closing), and "1-6" is 1pm-6pm
 * (not 1am - that would be well before opening). A bare "7" has no valid
 * reading either way (7am is before opening, 7pm is after closing) and, if
 * either side of a range comes out that way, or the two readings don't
 * form a real start-before-end window once resolved (e.g. "5-9" - 5 can
 * only be 5pm and 9 can only be 9am, and 9am isn't after 5pm), the whole
 * answer is treated as unparseable rather than guessed at - see the
 * "unknown" case below.
 *
 * None of the parsing in this function is timezone-aware by itself - it
 * just turns "8-11" into "8:00-11:00" as bare hour-of-day numbers. The
 * WORKER's own work area (see the "Work area" dropdown in formManager.js,
 * written to Worker.workArea by availabilitySync.js) is what says which
 * real timezone those numbers are in - see checkFortnightAvailability()
 * below, which is the one place that actually attaches a timezone to them.
 */

// Phrases meaning "not available at all that day" - matched against the
// WHOLE trimmed answer (not a substring test) so this doesn't misfire on
// something like "Free after 2pm, not before" which does contain "not".
const NOT_AVAILABLE_PATTERN =
  /^(no|nope|n\/a|na|nil|none|off|unavailable|not\s+available|can\W?t\s*(make\s*it)?|cannot\s*(make\s*it)?|busy(\s+all\s+day)?|-|x)\.?$/i;

// Phrases meaning "free the whole day, no time restriction".
const ALL_DAY_PATTERN = /^(yes|y|available|free|available\s+all\s+day|all\s+day|free\s+all\s+day)\.?$/i;

// Captures a "<start> - <end>" style range with an explicit connector
// (dash/en-dash/"to"/"until"/"through") between the two times, each side
// optionally carrying minutes (":30" or ".30") and/or an explicit am/pm
// marker. Requiring the connector (rather than just grabbing any two
// numbers in the text) avoids misreading unrelated digits as a time range.
const RANGE_PATTERN =
  /(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?\s*(?:-|–|—|to|until|through)\s*(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?m\.?)?/i;

function to24Hour(hour12, isPM) {
  const h = hour12 % 12;
  return isPM ? h + 12 : h;
}

/**
 * The one sensible 24-hour reading of a BARE hour number (no am/pm stated),
 * given the business only ever schedules 8am-6pm - see the file header for
 * the reasoning. Returns null for "7", the one number that's genuinely
 * outside the business day either way (7am/7pm), so the caller can fail
 * open rather than guess.
 */
function resolveBareHour(hour12) {
  if (hour12 >= 8 && hour12 <= 11) return hour12; // 8-11 -> 8:00-11:00 (am)
  if (hour12 === 12) return 12; // 12 -> 12:00 (noon)
  if (hour12 >= 1 && hour12 <= 6) return hour12 + 12; // 1-6 -> 13:00-18:00 (pm)
  return null;
}

/**
 * @param {string} rawText - one Worker.formAvailability entry's `text`
 * @returns {{kind: "unavailable"} | {kind: "all-day"} | {kind: "window", startMinutes: number, endMinutes: number} | {kind: "unknown"}}
 *   *Minutes fields are minutes-since-midnight in the business's own local
 *   wall-clock time (the work area's timezone - see
 *   checkFortnightAvailability below for how that's applied). "unknown"
 *   covers both an empty answer and free text this couldn't confidently
 *   parse - callers should fail OPEN on it (see the file-level rationale
 *   above and assignment.js's own hasTimeConflict, which follows the same
 *   philosophy: absence of a clear signal is never treated as evidence of
 *   unavailability).
 */
export function parseAvailabilityText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return { kind: "unknown" };
  if (NOT_AVAILABLE_PATTERN.test(text)) return { kind: "unavailable" };
  if (ALL_DAY_PATTERN.test(text)) return { kind: "all-day" };

  const m = text.match(RANGE_PATTERN);
  if (!m) return { kind: "unknown" };

  const startHour12 = Number(m[1]);
  const startMinute = Number(m[2] || 0);
  const startMarker = m[3] ? m[3][0].toLowerCase() : null; // "a" or "p", or null if not stated
  const endHour12 = Number(m[4]);
  const endMinute = Number(m[5] || 0);
  const endMarker = m[6] ? m[6][0].toLowerCase() : null;

  if (
    !Number.isFinite(startHour12) || startHour12 < 1 || startHour12 > 12 ||
    !Number.isFinite(endHour12) || endHour12 < 1 || endHour12 > 12 ||
    startMinute > 59 || endMinute > 59
  ) {
    return { kind: "unknown" };
  }

  // An explicit am/pm on either side is always honored as stated; a bare
  // side falls back to resolveBareHour()'s business-hours reading (and
  // "unknown" if that comes back null, i.e. a bare "7").
  let startHour24;
  if (startMarker) {
    startHour24 = to24Hour(startHour12, startMarker === "p");
  } else {
    startHour24 = resolveBareHour(startHour12);
    if (startHour24 == null) return { kind: "unknown" };
  }
  const startTotalMinutes = startHour24 * 60 + startMinute;

  let endHour24;
  if (endMarker) {
    endHour24 = to24Hour(endHour12, endMarker === "p");
  } else {
    endHour24 = resolveBareHour(endHour12);
    if (endHour24 == null) return { kind: "unknown" };
  }
  const endTotalMinutes = endHour24 * 60 + endMinute;

  if (endTotalMinutes <= startTotalMinutes) return { kind: "unknown" };

  return { kind: "window", startMinutes: startTotalMinutes, endMinutes: endTotalMinutes };
}

/**
 * A human-friendly interpretation of one day's raw free-text answer, e.g.
 * "8-5" -> "8am-5pm", "Not available" -> "Not available", "8-9" -> "8am-9am"
 * (see the file header for why that's morning, not evening). Returns null
 * when the answer couldn't be confidently parsed (parseAvailabilityText's
 * "unknown" case) - callers show the raw text on its own then, and can flag
 * it for the admin to ask the worker to clarify with an explicit am/pm.
 * @param {string} rawText
 * @returns {string | null}
 */
export function describeAvailabilityText(rawText) {
  const parsed = parseAvailabilityText(rawText);
  if (parsed.kind === "unavailable") return "Not available";
  if (parsed.kind === "all-day") return "Available all day";
  if (parsed.kind === "window") return `${formatMinutes(parsed.startMinutes)}-${formatMinutes(parsed.endMinutes)}`;
  return null;
}

/**
 * Maps a Worker.formAvailability array (real Mongoose subdocs or plain
 * [{date, text}] objects, e.g. from a .lean() query) to plain {date, text,
 * parsed} objects, `parsed` being describeAvailabilityText(text) above.
 * Shared by every place that sends formAvailability to the client (see
 * routes/workers.js and services/assignment.js's rankCandidates), so the
 * "Click to see" popup (FortnightAvailability.jsx) can show the resolved
 * am/pm reading next to whatever the worker actually typed, instead of
 * making the admin work it out by eye.
 * @param {{date: Date|string, text: string}[]} entries
 */
export function withParsedAvailability(entries) {
  return (entries || []).map((e) => ({
    date: e.date,
    text: e.text,
    parsed: describeAvailabilityText(e.text),
  }));
}

function formatMinutes(total) {
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const period = h24 >= 12 ? "pm" : "am";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * Checks whether `worker` is free for `job`'s scheduled time, per the
 * fortnightly form's day-by-day answers (Worker.formAvailability - see
 * services/availabilitySync.js for how that gets populated). Used by
 * services/assignment.js as a hard-exclusion rule, in place of the old
 * plain `Worker.availability` boolean.
 *
 * Fails OPEN (returns ok: true, i.e. does not exclude the worker) whenever
 * there's genuinely nothing to check against: no scheduled time on the
 * job, no submitted answer for that specific day, or an answer that
 * couldn't be confidently parsed. This mirrors hasTimeConflict()'s own
 * stated philosophy elsewhere in assignment.js - an unknown is never
 * treated as evidence of a conflict. A human can still see the raw text
 * for any day via the Availability column on the Workers page.
 *
 * The job's scheduled time and the worker's day-by-day text answer are
 * compared in the WORKER's own work area's timezone, not the job's -
 * Worker.workArea is what the "Work area" dropdown on the fortnightly form
 * writes (see availabilitySync.js), so a worker who picked NSW and wrote
 * "8-11" means 8-11am Sydney time, regardless of which area the job itself
 * is in. In practice these almost always agree anyway, since
 * services/assignment.js hard-excludes a candidate whose workArea doesn't
 * match the job's - but the comparison itself is scoped to the worker on
 * purpose, since it's THEIR answer being interpreted. Falls back to
 * DEFAULT_TIMEZONE (see utils/workAreas.js) when the worker has no
 * workArea set yet, same as every other work-area lookup in this app.
 *
 * @param {{formAvailability?: {date: Date|string, text: string}[], workArea?: string}} worker
 * @param {{scheduledStart?: Date|string, durationMinutes?: number}} job
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkFortnightAvailability(worker, job) {
  if (!job?.scheduledStart) return { ok: true };
  const start = new Date(job.scheduledStart);
  if (Number.isNaN(start.getTime())) return { ok: true };

  const timeZone = timezoneForWorkArea(worker?.workArea);
  const zoned = zonedParts(start, timeZone);

  // Matched by UTC calendar-DATE only (year/month/day), not by exact
  // millisecond equality against a UTC-midnight key. formAvailability
  // dates are *meant* to be stored as UTC-midnight-per-calendar-day (see
  // services/availabilitySync.js), but a real bug in
  // formManager.js's old nextFortnightStart()/day-loop (fixed, but only
  // for rollouts created from here on) used the machine's LOCAL timezone
  // instead of UTC, which left a stray, non-midnight time-of-day
  // component on every day date depending on whatever machine created the
  // rollout - e.g. "2026-09-24T14:30:00.000Z" instead of
  // "2026-09-24T00:00:00.000Z". An exact getTime() match against a clean
  // UTC-midnight key then NEVER found a hit, for any day, for any worker,
  // and this check silently failed open every single time regardless of
  // what was actually answered. The calendar-date components themselves
  // were always correct even on polluted data, so matching on those
  // instead is robust to both the fixed and any already-synced/leftover
  // data, with no re-rollout needed.
  const entries = worker?.formAvailability || [];
  const entry = entries.find((e) => {
    const d = new Date(e.date);
    return (
      d.getUTCFullYear() === zoned.year &&
      d.getUTCMonth() === zoned.month - 1 &&
      d.getUTCDate() === zoned.day
    );
  });
  if (!entry) return { ok: true }; // no submitted answer for this day - not evidence of unavailability

  const parsed = parseAvailabilityText(entry.text);
  if (parsed.kind === "unavailable") {
    return { ok: false, reason: `Not available that day (wrote "${entry.text}")` };
  }
  if (parsed.kind !== "window") {
    // "all-day" (explicitly free) or "unknown" (couldn't parse) - fail
    // open either way.
    return { ok: true };
  }

  const jobStartMinutes = zoned.hour * 60 + zoned.minute;
  const jobEndMinutes = jobStartMinutes + (job.durationMinutes ?? 60);

  if (jobStartMinutes < parsed.startMinutes || jobEndMinutes > parsed.endMinutes) {
    return {
      ok: false,
      reason: `Only free ${formatMinutes(parsed.startMinutes)}-${formatMinutes(parsed.endMinutes)} that day (wrote "${entry.text}"), job needs ${formatMinutes(jobStartMinutes)}-${formatMinutes(jobEndMinutes)}`,
    };
  }
  return { ok: true };
}
