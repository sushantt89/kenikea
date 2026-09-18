import { google } from "googleapis";

/**
 * Sends plain-text emails via the Gmail API, using the business's own
 * Google account - the SAME OAuth2 credentials already used for Calendar
 * (services/googleCalendar.js) and the availability sync
 * (services/availabilitySync.js), just with the extra
 * https://www.googleapis.com/auth/gmail.send scope added to the refresh
 * token (see server/scripts/getGoogleRefreshToken.js - re-run it once to
 * pick up this scope if your existing token predates it).
 *
 * Gmail's API sends "as" whichever account owns the OAuth token - there's
 * no separate "from" address to configure, and no SMTP password/app
 * password to manage.
 *
 * If the required env vars aren't set, sendEmail()/isConfigured() behave
 * like the other Google integrations in this app: a harmless "not
 * configured" result instead of throwing.
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

  cachedClient = google.gmail({ version: "v1", auth: oauth2Client });
  return cachedClient;
}

// Gmail's API wants the raw RFC 2822 message base64url-encoded (base64,
// then + -> -, / -> _, trailing = stripped) - there's no higher-level
// "just send plain text" helper in googleapis, so this builds the tiny
// MIME message by hand rather than pulling in a whole mail library for
// one header block.
function buildRawMessage({ to, subject, body }) {
  const lines = [
    `To: ${to}`,
    "Content-Type: text/plain; charset=utf-8",
    "MIME-Version: 1.0",
    `Subject: ${subject}`,
    "",
    body,
  ];
  const message = lines.join("\r\n");
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * @param {{to: string, subject: string, body: string}} opts
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendEmail({ to, subject, body }) {
  if (!isConfigured()) {
    return {
      sent: false,
      reason:
        "Email sending isn't configured - GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN must be set (see README).",
    };
  }
  if (!to) {
    return { sent: false, reason: "No email address given." };
  }

  try {
    const gmail = getClient();
    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: buildRawMessage({ to, subject, body }) },
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

export { isConfigured };
