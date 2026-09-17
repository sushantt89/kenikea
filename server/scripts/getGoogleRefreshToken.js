/**
 * One-time helper: run this once to get a Google OAuth2 refresh token for
 * the business's Google account, then paste it into server/.env as
 * GOOGLE_REFRESH_TOKEN. After that, the app can create Calendar events
 * (with workers invited as attendees) without asking anyone to sign in
 * again - the refresh token doesn't expire unless revoked.
 *
 * Usage:
 *   1. In Google Cloud Console: create a project, enable the "Google
 *      Calendar API", and create an OAuth client ID of type "Desktop app".
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
  scope: ["https://www.googleapis.com/auth/calendar.events"],
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
