import { google } from "googleapis";

/**
 * Creates the team's fortnightly "Bi-weekly Schedule Update" Google Form
 * from scratch via the Google Forms API, so "Roll out to all workers" can
 * build the NEXT fortnight's form itself instead of you duplicating it by
 * hand in Google Forms every two weeks.
 *
 * The Forms API has no "duplicate this form" call, so rather than trying
 * to copy the existing form, this recreates the same fixed structure
 * (Email, Name, Location, then a Start time + End time DROP_DOWN question
 * per day of the fortnight) with fresh dates each time - see
 * buildQuestionRequests() below. Each day is two dropdown questions
 * rather than one free-text box on purpose: every worker then answers in
 * exactly the same format ("8:00 AM" / "5:00 PM"), covering the full
 * 24-hour day (no 5pm-style cut-off), so
 * services/fortnightAvailability.js never has to guess what an
 * ambiguous bare number like "8-5" meant - it only has to guess for the
 * ORIGINAL, hand-made form's free-text answers (still read via the
 * Sheets-based fallback path in availabilitySync.js).
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

function shortAnswerQuestion(title, index) {
  return {
    createItem: {
      item: {
        title,
        questionItem: { question: { required: true, textQuestion: { paragraph: false } } },
      },
      location: { index },
    },
  };
}

function dropDownQuestion(title, options, index, required) {
  return {
    createItem: {
      item: {
        title,
        questionItem: {
          question: {
            required,
            choiceQuestion: { type: "DROP_DOWN", options: options.map((value) => ({ value })) },
          },
        },
      },
      location: { index },
    },
  };
}

// Every hour of the full 24-hour day (no 5pm-style cut-off - a job can be
// scheduled at any hour). "Not available" is prepended to the START list
// only - a worker who isn't in that day just picks it and skips End
// entirely (End is not required, see buildQuestionRequests).
const HOUR_OPTIONS = [
  "12:00 AM", "1:00 AM", "2:00 AM", "3:00 AM", "4:00 AM", "5:00 AM",
  "6:00 AM", "7:00 AM", "8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM",
  "12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM",
  "6:00 PM", "7:00 PM", "8:00 PM", "9:00 PM", "10:00 PM", "11:00 PM",
];
const START_TIME_OPTIONS = ["Not available", ...HOUR_OPTIONS];
const END_TIME_OPTIONS = HOUR_OPTIONS;

/**
 * Builds the 31 fixed questions (Email, Name, Location, then a Start/End
 * dropdown pair per day of the 14-day fortnight starting at `periodStart`)
 * as Forms API createItem requests, in order.
 */
function buildQuestionRequests(periodStart) {
  const requests = [
    shortAnswerQuestion("Email", 0),
    shortAnswerQuestion("Name", 1),
    shortAnswerQuestion("Location based (Suburb & city)", 2),
  ];
  let index = 3;
  for (let i = 0; i < 14; i++) {
    const date = addUtcDays(periodStart, i);
    const label = `${DAY_NAMES[date.getUTCDay()]} (${formatDateHeader(date)})`;
    requests.push(dropDownQuestion(`${label} - Start time`, START_TIME_OPTIONS, index++, true));
    requests.push(dropDownQuestion(`${label} - End time (leave if not available)`, END_TIME_OPTIONS, index++, false));
  }
  return requests;
}

/**
 * Creates a brand new form for the fortnight starting at `periodStart`
 * (defaults to nextFortnightStart()).
 * @returns {Promise<{created: boolean, reason?: string, formId?: string, formUrl?: string, periodStart?: Date, periodEnd?: Date, questionMap?: object}>}
 *   questionMap.days[] is {date, startQuestionId, endQuestionId} per day -
 *   availabilitySync.js reads both answers and combines them into one
 *   "8:00 AM - 5:00 PM" / "Not available" string, same shape
 *   Worker.formAvailability has always stored (see that file).
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
              "A scheduling form requesting your availability for the next two weeks, for job planning and assignment. For each day, pick a Start time and an End time - or pick \"Not available\" as your Start time if you're not free that day at all. Let us know as early as possible about any changes.",
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
    // items[0..2] are Email/Name/Location, items[3..30] are the 14
    // Start/End dropdown pairs, in the same order buildQuestionRequests()
    // created them in - matched back up by position rather than by title,
    // so this can't be thrown off by two days ever sharing a title.
    const questionMap = {
      email: items[0]?.questionItem?.question?.questionId,
      name: items[1]?.questionItem?.question?.questionId,
      location: items[2]?.questionItem?.question?.questionId,
      days: [],
    };
    for (let i = 0; i < 14; i++) {
      const date = addUtcDays(periodStart, i);
      const startItem = items[3 + i * 2];
      const endItem = items[3 + i * 2 + 1];
      questionMap.days.push({
        date: date.toISOString(),
        startQuestionId: startItem?.questionItem?.question?.questionId,
        endQuestionId: endItem?.questionItem?.question?.questionId,
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
