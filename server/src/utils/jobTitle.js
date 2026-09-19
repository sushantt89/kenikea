// A scraped job's title has its IKEA "Job <id>" number baked directly into
// the string - either as a "<title> (Job <id>)" suffix, or as the whole
// title ("Job <id>") when no better title text was found (see
// services/scraper.js's draftFromBeehiiveHtml). There's no separate stored
// jobId field, so this pulls it back out of the title whenever a display
// needs the id and the rest of the title separately - used to build the
// "WorkerA + WorkerB (12345) - Title" format shown once a job has an
// assigned team (see googleCalendar.js's createAssignmentEvent, and the
// client's equivalent client/src/utils/jobTitle.js for the Jobs list -
// kept in sync by hand since client/server don't share code in this repo).
const JOB_ID_SUFFIX = /\s*\(Job\s+(\d+)\)\s*$/i;
const JOB_ID_ONLY = /^Job\s+(\d+)$/i;

/**
 * Splits a job's title into its embedded IKEA job id (if any) and the rest
 * of the title with that id removed. A manually-created job (no scraped
 * id, see JobDraftForm.jsx's "+ Create a job manually") or any title that
 * doesn't match either pattern just comes back with an empty jobId and the
 * title unchanged.
 */
export function splitJobTitle(title) {
  const raw = title || "";

  const suffixMatch = raw.match(JOB_ID_SUFFIX);
  if (suffixMatch) {
    return { jobId: suffixMatch[1], cleanTitle: raw.slice(0, suffixMatch.index).trim() };
  }

  const onlyMatch = raw.match(JOB_ID_ONLY);
  if (onlyMatch) {
    return { jobId: onlyMatch[1], cleanTitle: "" };
  }

  return { jobId: "", cleanTitle: raw };
}

/**
 * "WorkerA + WorkerB (12345) - Title" - the display format used once a job
 * has one or more workers to show (an assigned team, or whoever's invited
 * to a specific calendar event). Falls back to the plain title unchanged
 * when there's nobody to lead with, so an unassigned job's title is
 * untouched.
 */
export function formatAssignedTitle(title, workerNames) {
  const names = (workerNames || []).filter(Boolean);
  if (names.length === 0) return title || "";

  const { jobId, cleanTitle } = splitJobTitle(title);
  const who = names.join(" + ");
  const idPart = jobId ? ` (${jobId})` : "";
  return cleanTitle ? `${who}${idPart} - ${cleanTitle}` : `${who}${idPart}`;
}
