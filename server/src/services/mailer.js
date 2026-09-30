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
 * Gmail's API sends "as" whichever account owns the OAuth token by
 * default - there's no separate "from" address to configure, and no
 * SMTP password/app password to manage.
 *
 * OPTIONAL MAIL_FROM env var: to send as a different address without a
 * second OAuth token, add that address as a verified "Send mail as"
 * alias on the SAME Gmail account this refresh token belongs to (Gmail
 * Settings -> See all settings -> Accounts and Import -> Send mail as ->
 * Add another email address; the alias owner clicks a one-time
 * verification link Gmail emails them). Once verified, set MAIL_FROM to
 * that address - either bare ("wyelee.my@gmail.com") or with a display
 * name ("WyeLee <wyelee.my@gmail.com>") - and every email this app sends
 * goes out From that address instead, using this same refresh token.
 * Leave MAIL_FROM unset to keep the old default (the token account's own
 * address). Sending will fail if MAIL_FROM is set to an address that
 * ISN'T yet a verified alias on this account - verify it first.
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
    // Only added when MAIL_FROM is set - see the file header comment.
    // Omitting the header entirely (rather than sending an empty one)
    // keeps the old default behavior for everyone who hasn't set it:
    // Gmail fills in the token account's own address on its own.
    ...(process.env.MAIL_FROM ? [`From: ${process.env.MAIL_FROM}`] : []),
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
