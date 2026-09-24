import { google } from "googleapis";
import { WORK_AREAS } from "../utils/workAreas.js";

/**
 * Creates the team's fortnightly "Bi-weekly Schedule Update" Google Form
 * from scratch via the Google Forms API, so "Roll out to all workers" can
 * build the NEXT fortnight's form itself instead of you duplicating it by
 * hand in Google Forms every two weeks.
 *
 * The Forms API has no "duplicate this form" call, so rather than trying
 * to copy the existing form, this recreates the same fixed structure
 * (Email, Name, Work area, then ONE free-text availability question per
 * day of the fortnight) with fresh dates each time - see
 * buildQuestionRequests() below. A worker types something like "8-5",
 * "8:30am-5pm", or "Not available" for each day - the exact same free-text
 * shape the ORIGINAL, hand-made form has always used - and
 * services/fortnightAvailability.js's parseAvailabilityText() does the
 * guessing when am/pm isn't stated (see that file for the full rules).
 * This used to be two strict dropdown questions per day (Start time/End
 * time) specifically to avoid needing that guesswork, but that made the
 * form twice as long to fill in for comparatively little benefit, since
 * the guesser already has to exist anyway for the original form.
 *
 * The "Work area" question is a DROPDOWN using the exact same options as
 * the website's own work-area picker (see utils/workAreas.js's
 * WORK_AREAS) - not free text - so the answer can be trusted to match one
 * of those five areas exactly. availabilitySync.js writes it straight into
 * Worker.workArea on sync, which is what fortnightAvailability.js's
 * checkFortnightAvailability() uses to decide WHICH timezone that same
 * worker's day-by-day hours are in ("8-11" from an NSW worker means
 * 8-11am Sydney time, not wherever the job or the server happens to be) -
 * see that file's header comment for the full reasoning.
 *
 * Needs the same Google account/refresh token as Calendar/Sheets/Gmail,
 * with two more scopes added:
 *   - https://www.googleapis.com/auth/forms.body (create/edit forms)
 *   - https://www.googleapis.com/auth/forms.responses.readonly (read
 *     answers back - see availabilitySync.js)
 * See server/scripts/getGoogleRefreshToken.js, which already requests
 * both. isConfigured() below just checks the shared client id/secret/
 * refresh token - Google will reject the actual API calls if the scopes
 * themselves weren't granted, and that error is surfaced back to the
 * caller rather than thrown, same as the rest of this app's Google
 * integrations.
 */

let cachedClient = null;

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN
  );
}

function getClient() {
  if (cachedClient) return cachedClient;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  cachedClient = google.forms({ version: "v1", auth: oauth2Client });
  return cachedClient;
}

/**
 * The Monday that starts the NEXT fortnight - today's date if today is
 * already Monday, otherwise the coming Monday. Matches the real form's own
 * Monday-Sunday x2 layout (confirmed against the original form).
 */
export function nextFortnightStart(from = new Date()) {
  // Everything here works in UTC calendar-date arithmetic on purpose - NOT
  // .getDay()/.setHours()/.setDate(), which all operate in the machine's
  // LOCAL timezone. That was a real bug: a rollout created from a machine
  // whose OS timezone isn't UTC produced day dates with a leftover,
  // non-midnight time-of-day component once serialized, which then never
  // matched the exact-UTC-midnight keys checkFortnightAvailability() looks
  // up by (see fortnightAvailability.js) - silently failing every
  // exclusion check open, for every day, for every worker, regardless of
  // what they actually answered.
  const dayOfWeek = from.getUTCDay(); // 0 (Sun) - 6 (Sat)
  const daysUntilMonday = dayOfWeek === 1 ? 0 : (8 - dayOfWeek) % 7;
  return addUtcDays(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())), daysUntilMonday);
}

// Adds `days` whole calendar days to `date`, entirely in UTC - safe to use
// on any Date regardless of the machine's local timezone (see
// nextFortnightStart() above for why that distinction matters here).
function addUtcDays(date, days) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatDateHeader(date) {
  // "14/9/2026" - day/month not zero-padded, matching the real form. Reads
  // UTC components - see nextFortnightStart()'s comment for why.
  return `${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}`;
}

// `required` defaults to true (Email/Name/Work area all need an answer to
// be usable at all) but the day-by-day availability questions pass false -
// see buildQuestionRequests below and the file header for why a worker can
// now just skip a day instead of typing "Not available".
function shortAnswerQuestion(title, index, description, required = true) {
  return {
    createItem: {
      item: {
        title,
        ...(description ? { description } : {}),
        questionItem: { question: { required, textQuestion: { paragraph: false } } },
      },
      location: { index },
    },
  };
}

// A single-choice dropdown question, used only for "Work area" below - a
// closed list (matching the website's own WORK_AREAS, see
// utils/workAreas.js) rather than free text, since the answer has to match
// one of those five areas exactly to be usable as a timezone lookup key
// (see the file header comment).
function dropDownQuestion(title, options, index, description) {
  return {
    createItem: {
      item: {
        title,
        ...(description ? { description } : {}),
        questionItem: {
          question: {
            required: true,
            choiceQuestion: { type: "DROP_DOWN", options: options.map((value) => ({ value })) },
          },
        },
      },
      location: { index },
    },
  };
}

// Shown under each day's question, so a worker knows what format is
// expected without needing to be told separately - see
// fortnightAvailability.js's parseAvailabilityText() for exactly what this
// accepts (it's more forgiving than this one example line lets on: "to"/
// "until" instead of "-", missing minutes, etc. all work too). Leaving the
// field blank works too now (see buildQuestionRequests below) - stated
// here so a worker skipping a day knows that's a real, supported answer
// rather than something they forgot to fill in.
const DAY_HINT = 'e.g. "8-5" or "8:30am-5pm" - leave blank if not available that day';

/**
 * Builds the 17 fixed questions (Email, Name, Work area, then one
 * free-text availability question per day of the 14-day fortnight
 * starting at `periodStart`) as Forms API createItem requests, in order.
 * Email/Name/Work area stay required (each is needed to even match and
 * interpret a response - see availabilitySync.js), but the 14 day
 * questions are deliberately NOT required: a worker who's simply not
 * available that day can leave it blank instead of having to type "Not
 * available" fourteen times - availabilitySync.js treats a blank day
 * answer as exactly that (see applyAnswersToWorker there).
 */
function buildQuestionRequests(periodStart) {
  const requests = [
    shortAnswerQuestion("Email", 0),
    shortAnswerQuestion("Name", 1),
    dropDownQuestion(
      "Work area",
      WORK_AREAS,
      2,
      "Which area are you currently based in?"
    ),
  ];
  let index = 3;
  for (let i = 0; i < 14; i++) {
    const date = addUtcDays(periodStart, i);
    const label = `${DAY_NAMES[date.getUTCDay()]} (${formatDateHeader(date)})`;
    requests.push(shortAnswerQuestion(label, index++, DAY_HINT, false));
  }
  return requests;
}

/**
 * Creates a brand new form for the fortnight starting at `periodStart`
 * (defaults to nextFortnightStart()).
 * @returns {Promise<{created: boolean, reason?: string, formId?: string, formUrl?: string, periodStart?: Date, periodEnd?: Date, questionMap?: object}>}
 *   questionMap.days[] is {date, questionId} per day - availabilitySync.js
 *   reads that one free-text answer straight into Worker.formAvailability,
 *   same shape it's always stored ("8-5" / "Not available" / etc, see
 *   fortnightAvailability.js for how that gets parsed). questionMap.workArea
 *   is the "Work area" dropdown's questionId - availabilitySync.js reads
 *   that answer straight into Worker.workArea.
 */
export async function createFortnightForm(periodStart = nextFortnightStart()) {
  if (!isConfigured()) {
    return {
      created: false,
      reason:
        "Automatic form creation isn't configured - GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN must be set, with the Forms API scopes granted (see README).",
    };
  }

  const periodEnd = addUtcDays(periodStart, 13);
  const fmt = (d) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const title = `Bi-weekly Schedule Update (${fmt(periodStart)} - ${fmt(periodEnd)})`;

  try {
    const forms = getClient();

    // Forms API quirk: forms.create only accepts a title at creation time -
    // the description and every question are added afterwards via
    // batchUpdate.
    const { data: created } = await forms.forms.create({
      requestBody: { info: { title, documentTitle: title } },
    });

    const requests = [
      {
        updateFormInfo: {
          info: {
            description:
              "A scheduling form requesting your availability for the next two weeks, for job planning and assignment. Pick your work area first (this sets which timezone your hours are read in), then for each day write your available hours (e.g. \"8-5\" or \"8:30am-5pm\") - or just leave a day blank if you're not free that day at all. Let us know as early as possible about any changes.",
          },
          updateMask: "description",
        },
      },
      ...buildQuestionRequests(periodStart),
    ];

    // includeFormInResponse gives back the full, updated form (with each
    // new question's assigned questionId) in one round trip, instead of a
    // second forms.get() call just to read those ids back.
    const { data: updated } = await forms.forms.batchUpdate({
      formId: created.formId,
      requestBody: { requests, includeFormInResponse: true },
    });

    const items = updated.form?.items || [];
    // items[0..2] are Email/Name/Location, items[3..16] are the 14 daily
    // availability questions, in the same order buildQuestionRequests()
    // created them in - matched back up by position rather than by title,
    // so this can't be thrown off by two days ever sharing a title.
    const questionMap = {
      email: items[0]?.questionItem?.question?.questionId,
      name: items[1]?.questionItem?.question?.questionId,
      workArea: items[2]?.questionItem?.question?.questionId,
      days: [],
    };
    for (let i = 0; i < 14; i++) {
      const date = addUtcDays(periodStart, i);
      const dayItem = items[3 + i];
      questionMap.days.push({
        date: date.toISOString(),
        questionId: dayItem?.questionItem?.question?.questionId,
      });
    }

    return {
      created: true,
      formId: created.formId,
      formUrl: created.responderUri,
      periodStart,
      periodEnd,
      questionMap,
    };
  } catch (err) {
    return { created: false, reason: err.message };
  }
}

/**
 * Reads every response currently on `formId` via the Forms API directly -
 * no linked Google Sheet involved at all. Used for any form this app
 * created itself (see createFortnightForm above); the ORIGINAL,
 * hand-made form still goes through the Sheets-based path in
 * availabilitySync.js, since it has no Forms-API questionMap to read by.
 * @returns {Promise<{ok: boolean, reason?: string, responses?: Array<{email: string, name: string, answers: {questionId: string}[]}>}>}
 */
export async function listFormResponses(formId) {
  if (!isConfigured()) {
    return { ok: false, reason: "Google API credentials aren't configured." };
  }
  try {
    const forms = getClient();
    const { data } = await forms.forms.responses.list({ formId });
    return { ok: true, responses: data.responses || [] };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export { isConfigured };
