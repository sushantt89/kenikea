// A scraped job's title has its IKEA "Job <id>" number baked directly into
// the string - either as a "<title> (Job <id>)" suffix, or as the whole
// title ("Job <id>") when no better title text was found (see
// services/scraper.js's draftFromBeehiiveHtml). There's no separate stored
// jobId field, so this pulls it back out of the title whenever a display
// needs it - used to build the "WorkerA + WorkerB (12345) - Customer Name"
// format shown as a job's title everywhere it's displayed (see
// googleCalendar.js's createAssignmentEvent, and the client's equivalent
// client/src/utils/jobTitle.js for the Jobs list - kept in sync by hand
// since client/server don't share code in this repo).
//
// The job's own scraped/typed title text (e.g. "PAX wardrobe assembly",
// "Assembly Rectification") is deliberately NOT part of that display
// title anymore - it rarely helps tell one job apart from another at a
// glance, whereas who's working it and which customer it's for does. The
// raw title text itself is untouched on Job.title (still shown/edited via
// JobDraftForm's "Title" field, still searchable) - only the DISPLAY
// string built by formatAssignedTitle() below drops it.
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
 * "WorkerA + WorkerB (12345) - Customer Name (Customer Phone)" - the
 * display title used for a job everywhere its title is shown (the Jobs list, a calendar event summary).
 * Leads with whoever's actually being shown (the assigned team, or - for one specific calendar event - just that event's invitee(s), which isn't always the whole team), falling back to "Unassigned"
 * when there's nobody yet; keeps the IKEA "(Job <id>)" tag pulled out of
 * the stored title; and ends with the CUSTOMER's name and phone number
 * (never their email - that stays admin-only) when on file, since for
 * this business who's doing a job, which customer it's for, and how to
 * reach them identify it far better than its own generic scraped
 * description ever did.
 * Falls back to the plain stored title only when there's truly nothing to
 * build a useful display from - no job id, no customer name/phone, nobody
 * assigned - e.g. a bare manually-created job with no customer entered
 * yet.
 * @param {object} [customer] - job.customer ({name, phone, email}) -
 *   only name and phone are ever used here.
 */
export function formatAssignedTitle(title, workerNames, customer) {
  const names = (workerNames || []).filter(Boolean);
  const { jobId } = splitJobTitle(title);
  const customerName = (customer?.name || "").trim();
  const customerPhone = (customer?.phone || "").trim();
  const customerPart = customerName
    ? customerPhone
      ? `${customerName} (${customerPhone})`
      : customerName
    : customerPhone;

  if (!jobId && !customerPart && names.length === 0) return title || "";

  const who = names.length > 0 ? names.join(" + ") : "Unassigned";
  const idPart = jobId ? ` (${jobId})` : "";
  const lead = `${who}${idPart}`;
  return customerPart ? `${lead} - ${customerPart}` : lead;
}
