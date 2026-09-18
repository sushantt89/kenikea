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
 * This is only ever needed for the ORIGINAL, hand-made form's free-text
 * answers (read via the Sheets-based fallback in availabilitySync.js). A
 * form this app creates itself asks for Start/End time with Google's own
 * native time-of-day picker instead (see formManager.js) - those answers
 * always carry an explicit, unambiguous 24-hour time, so none of the
 * guesswork below ever applies to them.
 *
 * The trickiest part here is a bare-number range with no am/pm given, e.g.
 * "8-5" or "8-11" - there's no fixed cut-off hour anymore (the business
 * runs a full 24-hour day, not just until 5pm), so the only sensible rule
 * left is: a bare end hour is read as PM unless that would put it before
 * the start time, in which case it's read as AM instead - i.e. "8-5" is
 * 8am-5pm (5am would be before 8am), and "8-11" is now read as 8am-11pm
 * (11am and 11pm are both after 8am, so PM wins). See
 * resolveAmbiguousEndMinutes() below.
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
 * Resolves a bare (no am/pm stated) end hour against the already-resolved
 * start time: picks whichever of the AM/PM readings (a) isn't earlier than
 * the start time and (b) doesn't run past the 5pm cap, preferring PM when
 * both qualify (an afternoon finish - "8-5", "9-3" - is by far the common
 * case for a work day). Falls back to the only reading that qualifies when
 * just one does (e.g. "8-11" -> 11am, since 11pm blows the cap). Returns
 * null when NEITHER reading makes sense (a contradictory range like
 * "10-9") so the caller can fail open rather than guess.
 */
function resolveAmbiguousEndMinutes(endHour12, endMinute, startTotalMinutes) {
  const pmMinutes = to24Hour(endHour12, true) * 60 + endMinute;
  const amMinutes = to24Hour(endHour12, false) * 60 + endMinute;
  if (pmMinutes >= startTotalMinutes) return pmMinutes;
  if (amMinutes >= startTotalMinutes) return amMinutes;
  return null; // neither reading is after the start time - a contradictory range like "10-9"
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

  // A work day always starts in the morning unless the worker said
  // otherwise - only an explicit "pm" on the start side overrides that.
  const startTotalMinutes = to24Hour(startHour12, startMarker === "p") * 60 + startMinute;

  let endTotalMinutes;
  if (endMarker) {
    endTotalMinutes = to24Hour(endHour12, endMarker === "p") * 60 + endMinute;
  } else {
    endTotalMinutes = resolveAmbiguousEndMinutes(endHour12, endMinute, startTotalMinutes);
    if (endTotalMinutes == null) return { kind: "unknown" };
  }

  if (endTotalMinutes <= startTotalMinutes) return { kind: "unknown" };

  return { kind: "window", startMinutes: startTotalMinutes, endMinutes: endTotalMinutes };
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
 * @param {{formAvailability?: {date: Date|string, text: string}[]}} worker
 * @param {{scheduledStart?: Date|string, durationMinutes?: number, workArea?: string}} job
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkFortnightAvailability(worker, job) {
  if (!job?.scheduledStart) return { ok: true };
  const start = new Date(job.scheduledStart);
  if (Number.isNaN(start.getTime())) return { ok: true };

  const timeZone = timezoneForWorkArea(job.workArea);
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
