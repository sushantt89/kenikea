import { google } from "googleapis";
import Worker from "../models/Worker.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { getOrCreateRollout } from "../models/FormRollout.js";
import { listFormResponses } from "./formManager.js";
import { sendEmail } from "./mailer.js";
import { WORK_AREAS } from "../utils/workAreas.js";

/**
 * Pulls the team's fortnightly availability into each Worker document, so
 * the admin can see everyone's day-by-day answers inside this app instead
 * of only in Google Forms/Sheets.
 *
 * There are two ways this reads the answers, depending on which form is
 * currently active (see models/FormRollout.js):
 *   - A form this app created itself (services/formManager.js, via the
 *     Workers page's "Roll out to all workers" button) has a `formId` and
 *     `questionMap` on the FormRollout doc - answers are read straight from
 *     the Google Forms API (syncFromFormsApi below), no spreadsheet
 *     involved at all.
 *   - The ORIGINAL, hand-made form has neither of those, so it falls back
 *     to reading the linked Google Sheet directly (syncFromSheet below) -
 *     see README > Worker availability sync for how that's set up.
 *
 * Either way, this does NOT touch the plain Worker.availability boolean
 * (the assignment engine's on/off roster toggle) - it only fills
 * Worker.formAvailability, which is purely informational. Matching a
 * response to a Worker is always by email (case-insensitive); a response
 * from an email that isn't already a Worker in this app is reported back
 * as "unmatched" rather than silently ignored or auto-creating a worker.
 *
 * The form this app creates itself (not the original hand-made one) also
 * asks a "Work area" dropdown question (see formManager.js) - THAT answer
 * DOES get written straight into Worker.workArea (not just informational),
 * since fortnightAvailability.js's checkFortnightAvailability() uses a
 * worker's own workArea to know which timezone their day-by-day hours are
 * in. The original hand-made form has no equivalent question, so a worker
 * who only ever answers that one keeps whatever workArea was last set by
 * hand on the Workers page.
 */

let cachedSheetsClient = null;

function sheetIsConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN &&
      process.env.GOOGLE_AVAILABILITY_SHEET_ID
  );
}

function getSheetsClient() {
  if (cachedSheetsClient) return cachedSheetsClient;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  cachedSheetsClient = google.sheets({ version: "v4", auth: oauth2Client });
  return cachedSheetsClient;
}

// Matches a question title like "Monday (14/9/2026)" or "Monday (14/09/2026)"
// and pulls out the date - the day-of-week word itself is ignored (only
// used by whoever wrote the form question), the "(D/M/YYYY)" part is the
// actual date.
const DATE_HEADER_PATTERN = /\((\d{1,2})\/(\d{1,2})\/(\d{4})\)\s*$/;

function parseDateHeader(header) {
  if (!header) return null;
  const m = header.match(DATE_HEADER_PATTERN);
  if (!m) return null;
  const [, dayStr, monthStr, yearStr] = m;
  const day = Number(dayStr);
  const month = Number(monthStr);
  const year = Number(yearStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function findColumnIndex(headerRow, matcher) {
  return headerRow.findIndex((h) => matcher(String(h || "").trim().toLowerCase()));
}

// True if `a` and `b` are the same UTC calendar day, regardless of
// whatever time-of-day component either one carries. Matching this way
// (rather than an exact getTime() equality) is what heals a real historical
// bug: formManager.js's day dates used to pick up a stray, non-midnight
// time-of-day component depending on the machine's local timezone (see
// fortnightAvailability.js's checkFortnightAvailability comment for the
// full story) - an exact-millisecond match would never find that old entry
// again, leaving it sitting alongside a fresh one forever instead of being
// replaced, which is exactly why the same day could show up twice in the
// "Click to see" popup (see FortnightAvailability.jsx, which just renders
// every entry in the array with no deduplication of its own).
function sameCalendarDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Applies one response's day-by-day answers to whichever Worker matches
 * `email` (case-insensitive), shared by both sync paths below. Mutates
 * `touchedWorkers`/`unmatchedEmails` (both passed in by the caller) rather
 * than returning anything, since both callers just save every touched
 * worker once at the end.
 * @param {Map<string, object>} workerByEmail
 * @param {Set<string>} unmatchedEmails
 * @param {Map<string, object>} touchedWorkers
 * @param {string} email
 * @param {{date: Date, text: string}[]} dayAnswers - `text` empty/blank
 *   means the worker submitted the form but left that day's (no longer
 *   required) question blank - stored as "Not available" (see the loop
 *   body below), not skipped
 * @param {string} [workAreaAnswer] - the "Work area" dropdown answer, when
 *   this response has one (see the file header) - only the app-created
 *   form's sync path passes this; the original hand-made form has no such
 *   question, so its sync leaves a worker's existing workArea untouched.
 */
function applyAnswersToWorker(workerByEmail, unmatchedEmails, touchedWorkers, email, dayAnswers, workAreaAnswer) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return;

  const worker = workerByEmail.get(normalizedEmail);
  if (!worker) {
    unmatchedEmails.add(normalizedEmail);
    return;
  }

  // Keep it exact-match only against the fixed WORK_AREAS list - a
  // dropdown answer should always be one of those five values, but this
  // guards against a stray/blank answer ever writing garbage into
  // Worker.workArea (which also drives Google Calendar's event color and
  // the assignment engine's hard area match - see utils/workAreas.js and
  // services/assignment.js).
  if (workAreaAnswer && WORK_AREAS.includes(workAreaAnswer)) {
    worker.workArea = workAreaAnswer;
  }

  for (const { date, text } of dayAnswers) {
    // The day questions are no longer required (see formManager.js), so a
    // blank answer means the worker actually submitted the form and just
    // skipped that one day - treated here as an explicit "Not available"
    // rather than "no answer" (which is what a genuinely MISSING day, from
    // a worker who hasn't responded to this fortnight's form at all,
    // still correctly falls open on - see checkFortnightAvailability()'s
    // "no submitted answer for this day" case in fortnightAvailability.js,
    // which only applies when there's no entry here at all).
    const effectiveText = text || "Not available";
    // Collapse EVERY entry for that calendar day (there can be more than
    // one left over from the bug described above) down to just this one
    // fresh answer, rather than only patching the text of a single exact
    // match - this is what actually removes an existing duplicate instead
    // of leaving it stranded next to the new entry.
    worker.formAvailability = worker.formAvailability.filter((e) => !sameCalendarDay(new Date(e.date), date));
    worker.formAvailability.push({ date, text: effectiveText });
  }

  // Keep it sorted by date, and only entries from roughly the last 3 weeks
  // - anything older is just clutter from a previous fortnight by now.
  const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
  worker.formAvailability = worker.formAvailability
    .filter((e) => e.date.getTime() >= cutoff)
    .sort((a, b) => a.date - b.date);

  worker.formAvailabilitySyncedAt = new Date();
  touchedWorkers.set(String(worker._id), worker);
}

/**
 * Reads answers directly from the Google Forms API for a form this app
 * created itself (see services/formManager.js + FormRollout.questionMap).
 */
async function syncFromFormsApi(rollout) {
  const result = await listFormResponses(rollout.formId);
  if (!result.ok) {
    return { synced: false, reason: `Could not read the form's responses: ${result.reason}` };
  }

  const { questionMap } = rollout;
  const workers = await Worker.find();
  const workerByEmail = new Map(workers.map((w) => [w.email.toLowerCase(), w]));
  const touchedWorkers = new Map();
  const unmatchedEmails = new Set();

  const answerText = (response, questionId) =>
    questionId ? response.answers?.[questionId]?.textAnswers?.answers?.[0]?.value?.trim() || "" : "";

  // Each day is now just one free-text question (see formManager.js's
  // buildQuestionRequests) - read straight through, same as the ORIGINAL
  // hand-made form's answers below in syncFromSheet. A bare "8-5" style
  // answer with no am/pm stated gets resolved by
  // fortnightAvailability.js's parseAvailabilityText() when it's actually
  // used, not here - this just stores whatever the worker typed. The
  // dropdown "Work area" answer, unlike the days, IS applied here (see
  // applyAnswersToWorker) rather than left for later.
  for (const response of result.responses) {
    const email = answerText(response, questionMap.email);
    const workArea = answerText(response, questionMap.workArea);
    const dayAnswers = (questionMap.days || []).map((d) => ({
      date: new Date(d.date),
      text: answerText(response, d.questionId),
    }));
    applyAnswersToWorker(workerByEmail, unmatchedEmails, touchedWorkers, email, dayAnswers, workArea);
  }

  for (const worker of touchedWorkers.values()) {
    await worker.save();
  }

  return {
    synced: true,
    updatedWorkers: touchedWorkers.size,
    unmatchedEmails: [...unmatchedEmails],
    datesFound: (questionMap.days || []).map((d) => new Date(d.date).toLocaleDateString("en-AU")),
  };
}

/**
 * Reads response rows from the linked Google Sheet, for the ORIGINAL
 * hand-made form (no Forms-API questionMap available for it). See the file
 * header and README > Worker availability sync for the required env vars.
 */
async function syncFromSheet() {
  if (!sheetIsConfigured()) {
    return {
      synced: false,
      reason:
        "Google Sheets availability sync isn't configured yet - set GOOGLE_AVAILABILITY_SHEET_ID (and make sure the Google OAuth refresh token includes Sheets read access) in server/.env. See README.",
    };
  }

  const range = process.env.GOOGLE_AVAILABILITY_SHEET_RANGE || "Form Responses 1";

  let rows;
  try {
    const sheets = getSheetsClient();
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_AVAILABILITY_SHEET_ID,
      range,
    });
    rows = data.values || [];
  } catch (err) {
    return { synced: false, reason: `Could not read the availability spreadsheet: ${err.message}` };
  }

  if (rows.length < 2) {
    return { synced: false, reason: "The availability spreadsheet has no response rows yet." };
  }

  const [headerRow, ...dataRows] = rows;

  const emailCol = findColumnIndex(headerRow, (h) => h.includes("email"));
  if (emailCol === -1) {
    return { synced: false, reason: 'Could not find an "Email" column in the spreadsheet header row.' };
  }

  const dateColumns = headerRow
    .map((header, index) => ({ index, date: parseDateHeader(header) }))
    .filter((c) => c.date);

  if (dateColumns.length === 0) {
    return {
      synced: false,
      reason: 'None of the spreadsheet\'s columns matched the expected "Day (D/M/YYYY)" format.',
    };
  }

  const workers = await Worker.find();
  const workerByEmail = new Map(workers.map((w) => [w.email.toLowerCase(), w]));
  const touchedWorkers = new Map();
  const unmatchedEmails = new Set();

  for (const row of dataRows) {
    const dayAnswers = dateColumns.map(({ index, date }) => ({ date, text: String(row[index] ?? "").trim() }));
    applyAnswersToWorker(workerByEmail, unmatchedEmails, touchedWorkers, row[emailCol], dayAnswers);
  }

  for (const worker of touchedWorkers.values()) {
    await worker.save();
  }

  return {
    synced: true,
    updatedWorkers: touchedWorkers.size,
    unmatchedEmails: [...unmatchedEmails],
    datesFound: dateColumns.map((c) => headerRow[c.index]),
  };
}

/**
 * Picks the right sync path for whichever form is currently active (see
 * the file header) and runs it.
 * @param {object} rollout - the FormRollout document (see
 *   models/FormRollout.js's getOrCreateRollout()) - callers fetch this
 *   once and pass it in rather than this module reaching for it itself.
 * @returns {Promise<{synced: boolean, reason?: string, updatedWorkers?: number, unmatchedEmails?: string[], datesFound?: string[]}>}
 */
export async function syncAvailabilityFromForm(rollout) {
  if (rollout?.formId && rollout?.questionMap) {
    return syncFromFormsApi(rollout);
  }
  return syncFromSheet();
}

/**
 * Notifies (bell icon + email - see models/Notification.js and
 * services/declineSync.js's checkCalendarDeclines() for the identical
 * pattern) about any fortnightly-form response that hasn't been seen yet.
 *
 * This does NOT touch Worker.formAvailability/workArea at all - actually
 * pulling a submission's answers into the app stays the separate,
 * deliberate "Sync availability" button (syncAvailabilityFromForm above).
 * This is purely a "someone just submitted" heads-up so it's noticed
 * sooner rather than only whenever someone next happens to click that
 * button.
 *
 * Like checkCalendarDeclines(), this runs as a side effect of a page
 * load/notification-bell poll (see routes/notifications.js and
 * routes/workers.js) rather than on any kind of timer - there's no
 * background process in this app.
 */
export async function checkNewAvailabilitySubmissions() {
  const rollout = await getOrCreateRollout();
  if (rollout.formId && rollout.questionMap) {
    await checkNewFormsApiSubmissions(rollout);
  } else {
    await checkNewSheetSubmissions(rollout);
  }
}

async function notifySubmission(name, email) {
  const label = (name || "").trim() || (email || "").trim() || "Someone";
  const message = `${label} submitted their fortnightly availability form.`;

  const normalizedEmail = String(email || "").trim().toLowerCase();
  const worker = normalizedEmail ? await Worker.findOne({ email: normalizedEmail }) : null;

  await Notification.create({
    type: "availability-submitted",
    message,
    worker: worker ? worker._id : null,
  });

  const admins = await User.find({}, "email");
  await Promise.all(
    admins
      .filter((u) => u.email)
      .map((u) =>
        sendEmail({
          to: u.email,
          subject: "New availability submission",
          body: `${message}\n\nOpen the app and click "Sync availability" on the Workers page to pull it in.`,
        })
      )
  );
}

/**
 * The Forms-API path's half of checkNewAvailabilitySubmissions() - keys
 * off each response's own Google-assigned responseId (see
 * models/FormRollout.js's notifiedResponseIds/
 * availabilityNotificationsInitialized fields for how "already seen" is
 * tracked, and why the very first run never notifies for anything).
 */
async function checkNewFormsApiSubmissions(rollout) {
  const result = await listFormResponses(rollout.formId);
  if (!result.ok) return; // best-effort - a read failure just means no notification this time, not an error worth surfacing here

  const responseIds = result.responses.map((r) => r.responseId).filter(Boolean);

  if (!rollout.availabilityNotificationsInitialized) {
    rollout.notifiedResponseIds = responseIds;
    rollout.availabilityNotificationsInitialized = true;
    await rollout.save();
    return;
  }

  const alreadyNotified = new Set(rollout.notifiedResponseIds || []);
  const newResponses = result.responses.filter((r) => r.responseId && !alreadyNotified.has(r.responseId));
  if (newResponses.length === 0) return;

  const { questionMap } = rollout;
  const answerText = (response, questionId) =>
    questionId ? response.answers?.[questionId]?.textAnswers?.answers?.[0]?.value?.trim() || "" : "";

  for (const response of newResponses) {
    await notifySubmission(answerText(response, questionMap.name), answerText(response, questionMap.email));
  }

  rollout.notifiedResponseIds = [...alreadyNotified, ...newResponses.map((r) => r.responseId)];
  await rollout.save();
}

/**
 * The Sheets path's half of checkNewAvailabilitySubmissions(), for the
 * ORIGINAL hand-made form (no Forms-API responseId available for it at
 * all). Each response row has no id of its own, so its "Timestamp" column
 * (added automatically by Google Forms to every linked sheet) combined
 * with the respondent's email stands in as a good-enough unique key.
 */
async function checkNewSheetSubmissions(rollout) {
  if (!sheetIsConfigured()) return;

  const range = process.env.GOOGLE_AVAILABILITY_SHEET_RANGE || "Form Responses 1";
  let rows;
  try {
    const sheets = getSheetsClient();
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_AVAILABILITY_SHEET_ID,
      range,
    });
    rows = data.values || [];
  } catch {
    return; // best-effort, same as above
  }
  if (rows.length < 2) return;

  const [headerRow, ...dataRows] = rows;
  const emailCol = findColumnIndex(headerRow, (h) => h.includes("email"));
  if (emailCol === -1) return;
  const nameCol = findColumnIndex(headerRow, (h) => h.includes("name"));
  const timestampCol = findColumnIndex(headerRow, (h) => h.includes("timestamp"));

  const keys = dataRows.map((row, i) =>
    timestampCol !== -1 ? `${row[timestampCol]}|${row[emailCol]}` : `row-${i}|${row[emailCol]}`
  );

  if (!rollout.availabilityNotificationsInitialized) {
    rollout.notifiedResponseIds = keys;
    rollout.availabilityNotificationsInitialized = true;
    await rollout.save();
    return;
  }

  const alreadyNotified = new Set(rollout.notifiedResponseIds || []);
  let anyNew = false;
  for (let i = 0; i < dataRows.length; i++) {
    if (alreadyNotified.has(keys[i])) continue;
    anyNew = true;
    alreadyNotified.add(keys[i]);
    const row = dataRows[i];
    await notifySubmission(nameCol !== -1 ? row[nameCol] : "", row[emailCol]);
  }

  if (anyNew) {
    rollout.notifiedResponseIds = [...alreadyNotified];
    await rollout.save();
  }
}

export { sheetIsConfigured as isConfigured };
