// Two minimal static pages required by Google's OAuth consent screen once
// the app is published to production (see README's "Switching the
// connected Google account" section) - a homepage and a privacy policy,
// both reachable at whatever domain you point at this server. Kept as
// plain server-rendered HTML (not part of the React app) so they're always
// reachable at a stable URL regardless of the client build, and so Google
// can crawl/display them without needing JS to render.
//
// The homepage doesn't need its own route - the app's own root ("/") is
// already a fine "homepage" for the consent screen (it explains what the
// app is via the login screen). Only the privacy policy needed writing
// from scratch; see index.js for where this is wired in (must be
// registered BEFORE the SPA catch-all route, or the catch-all would
// swallow it and serve index.html instead).

const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1c2130; line-height: 1.6; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2 { font-size: 1.1rem; margin-top: 28px; }
  p, li { color: #333; }
  .updated { color: #667085; font-size: 0.9rem; margin-bottom: 24px; }
`;

// Edit BUSINESS_NAME and CONTACT_EMAIL to match your actual business - these
// two are the only placeholders in here.
const BUSINESS_NAME = "Ken Ikea";
const CONTACT_EMAIL = "sushantstech07@gmail.com";

export const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Privacy Policy - ${BUSINESS_NAME} Worker Assignment</title>
<style>${STYLE}</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: ${new Date().toISOString().slice(0, 10)}</p>

  <p>
    This is an internal scheduling tool used by ${BUSINESS_NAME} to assign
    assembly jobs to workers. It is not a public product and is not
    available for anyone outside the business to sign up for or use.
  </p>

  <h2>What information this app stores</h2>
  <ul>
    <li><strong>Worker information:</strong> name, email, phone number, location, work area, skill level, and day-by-day availability.</li>
    <li><strong>Customer information:</strong> name, phone number, and email address, where provided on a job, solely so a job can be scheduled and assigned correctly.</li>
    <li><strong>Job information:</strong> job details, schedule, location, and payment records related to completed work.</li>
  </ul>

  <h2>How this app uses Google account access</h2>
  <p>
    This app connects to a single Google account belonging to the business
    to:
  </p>
  <ul>
    <li>Send emails on the business's behalf - fortnight availability form links to workers, and account password-reset emails.</li>
    <li>Create Google Calendar events when a job is assigned, so the assigned worker(s) receive a calendar invite for the job.</li>
  </ul>
  <p>
    This app does not read the connected account's existing emails or
    calendar events beyond what it created itself, and does not access any
    other Google account without that account's own sign-in and consent.
  </p>

  <h2>Data sharing</h2>
  <p>
    Information stored in this app is used only to run ${BUSINESS_NAME}'s
    own job scheduling. It is not sold, rented, or shared with any third
    party, other than the Google APIs described above, which are used only
    to send the emails and calendar invites this app itself creates.
  </p>

  <h2>Contact</h2>
  <p>
    Questions about this privacy policy or the data this app stores can be
    sent to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
  </p>
</body>
</html>`;
