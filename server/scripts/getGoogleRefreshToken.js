/**
 * One-time helper: run this once to get a Google OAuth2 refresh token for
 * the business's Google account, then paste it into server/.env as
 * GOOGLE_REFRESH_TOKEN. After that, the app can create Calendar events
 * (with workers invited as attendees), read the fortnightly availability
 * Google Sheet, and send the "roll out to all workers" emails - all
 * without asking anyone to sign in again, since a refresh token doesn't
 * expire unless revoked. Skip whichever features you don't need by
 * removing their scope below before running this.
 *
 * Usage:
 *   1. In Google Cloud Console: create a project, enable the "Google
 *      Calendar API", "Google Sheets API", "Gmail API" and "Google Forms
 *      API" (skip whichever you don't need to match the scopes below), and
 *      create an OAuth client ID of type "Desktop app".
 *   2. Put its client ID/secret into server/.env as GOOGLE_CLIENT_ID and
 *      GOOGLE_CLIENT_SECRET.
 *   3. Nothing to add for the redirect URI - Desktop app clients don't show
 *      that field in Cloud Console at all. Google automatically allows any
 *      loopback address/port (127.0.0.1:*) for this client type, which is
 *      exactly what this script uses below.
 *   4. Run: npm run get-google-token
 *   5. Open the printed URL, sign in with the Google account whose
 *      calendar should receive job invites, approve access.
 *   6. Copy the GOOGLE_REFRESH_TOKEN line it prints into server/.env.
 *
 * Re-running this script later (e.g. to add the Sheets scope to a refresh
 * token you generated before that scope existed here) replaces the old
 * refresh token with a new one that has whatever scopes are listed below
 * at the time - just paste the new value over the old GOOGLE_REFRESH_TOKEN.
 */
import "dotenv/config";
import http from "node:http";
import { google } from "googleapis";

const PORT = 5050;
// Google's docs specifically recommend the IP literal 127.0.0.1 over the
// hostname "localhost" for this loopback flow - some setups resolve
// "localhost" to ::1 (IPv6) instead, which then doesn't match what's
// actually listening below and Google rejects it as a mismatch.
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env first (see the comment at the top of this file, or README.md)."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: [
    "https://www.googleapis.com/auth/calendar.events",
    // Read-only access to the linked "Form responses" Google Sheet - only
    // needed for the ORIGINAL, hand-made availability form (see
    // services/availabilitySync.js); any fortnight rolled out automatically
    // (see services/formManager.js) is read via the Forms API scopes below
    // instead, no spreadsheet involved. Harmless to leave granted either way.
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    // Lets the app send email AS this Google account (see
    // services/mailer.js) - used by the Workers page's "Roll out to all
    // workers" button to email everyone the new fortnight's form link.
    "https://www.googleapis.com/auth/gmail.send",
    // Lets the app CREATE the next fortnight's Google Form itself (see
    // services/formManager.js) - this is what makes "Roll out to all
    // workers" fully automatic instead of needing you to duplicate the
    // form by hand first.
    "https://www.googleapis.com/auth/forms.body",
    // Lets the app read answers back from a form it created itself (see
    // services/availabilitySync.js's Forms-API sync path).
    "https://www.googleapis.com/auth/forms.responses.readonly",
  ],
});

console.log("\n1. Open this URL in your browser and approve access:\n");
console.log(authUrl);
console.log(`\n2. Waiting for the sign-in to complete (listening on ${REDIRECT_URI})...\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>All set</h1>You can close this tab and go back to the terminal.");
  server.close();

  if (!code) {
    console.error("No authorization code came back from Google. Try again.");
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      console.error(
        "\nGoogle didn't return a refresh token. This usually means this account already " +
          "granted access before - go to https://myaccount.google.com/permissions, remove " +
          "access for this app, and run this script again."
      );
      process.exit(1);
    }
    console.log("\nAdd this line to server/.env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (err) {
    console.error("Failed to exchange the code for tokens:", err.message);
  } finally {
    process.exit(0);
  }
});

server.listen(PORT);
