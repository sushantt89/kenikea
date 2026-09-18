import { google } from "googleapis";
import Worker from "../models/Worker.js";
import { listFormResponses } from "./formManager.js";

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
 * @param {{date: Date, text: string}[]} dayAnswers
 */
function applyAnswersToWorker(workerByEmail, unmatchedEmails, touchedWorkers, email, dayAnswers) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return;

  const worker = workerByEmail.get(normalizedEmail);
  if (!worker) {
    unmatchedEmails.add(normalizedEmail);
    return;
  }

  for (const { date, text } of dayAnswers) {
    if (!text) continue;
    const existing = worker.formAvailability.find((e) => e.date.getTime() === date.getTime());
    if (existing) {
      existing.text = text;
    } else {
      worker.formAvailability.push({ date, text });
    }
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

  // Each day is answered as two dropdowns (Start time / End time - see
  // formManager.js's buildQuestionRequests), combined here into the same
  // single free-text shape Worker.formAvailability has always stored
  // ("8:00 AM - 5:00 PM" / "Not available") - both dropdown values always
  // carry an explicit AM/PM, so fortnightAvailability.js's parser reads
  // this combined string with zero ambiguity (unlike the ORIGINAL hand-made
  // form's free-text answers, read via syncFromSheet below, where a bare
  // "8-5" style answer needs guesswork).
  const combineDayAnswer = (response, day) => {
    const start = answerText(response, day.startQuestionId);
    if (!start) return "";
    if (start === "Not available") return "Not available";
    const end = answerText(response, day.endQuestionId);
    return end ? `${start} - ${end}` : start;
  };

  for (const response of result.responses) {
    const email = answerText(response, questionMap.email);
    const dayAnswers = (questionMap.days || []).map((d) => ({
      date: new Date(d.date),
      text: combineDayAnswer(response, d),
    }));
    applyAnswersToWorker(workerByEmail, unmatchedEmails, touchedWorkers, email, dayAnswers);
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

export { sheetIsConfigured as isConfigured };
