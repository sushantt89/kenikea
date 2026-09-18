import crypto from "crypto";
import User from "../models/User.js";

/**
 * Login accounts, password hashing, and session tokens - all built on
 * Node's own built-in `crypto` module rather than adding bcrypt/jsonwebtoken
 * as dependencies. This app already avoids adding a dependency where a
 * built-in does the job well enough (see the dependency-free bar chart on
 * the Jobs page) - the same reasoning applies here, and it means login
 * works the moment you `npm install` with nothing new to fetch.
 *
 * PASSWORDS: hashed with scrypt (a slow, memory-hard KDF designed
 * specifically to resist brute-forcing password hashes - this is the same
 * category of algorithm as bcrypt, just the one Node ships built in),
 * salted per-password, compared with a constant-time check.
 *
 * SESSION TOKENS: a small hand-rolled equivalent of a JWT - a base64url
 * JSON payload (who + when it expires) plus an HMAC-SHA256 signature over
 * that payload, using a server-side secret (AUTH_SECRET). Anyone holding a
 * valid token can prove it was issued by this server and hasn't expired,
 * without the server needing to keep any session state - same idea as a
 * JWT, just without pulling in a library to do it. It is NOT encrypted
 * (don't put secrets in the payload - it only carries a user id/email), and
 * it can't be revoked before it expires (kept short - 7 days - for that
 * reason). That's an acceptable tradeoff for a small internal tool; a
 * bigger deployment might want real JWTs with a revocation list instead.
 */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_KEYLEN = 64;

function getSecret() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set in server/.env - generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` and paste it in. See README > Login & user accounts."
    );
  }
  return secret;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || "").split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);

  // Buffers of different lengths would throw in timingSafeEqual - a
  // mismatched length just means "wrong", not an error.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function sign(payloadBuf) {
  return crypto.createHmac("sha256", getSecret()).update(payloadBuf).digest();
}

export function createToken(user) {
  const payload = {
    sub: String(user._id),
    email: user.email,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const signature = sign(payloadBuf);
  return `${payloadBuf.toString("base64url")}.${signature.toString("base64url")}`;
}

/** Returns the decoded payload if `token` is validly signed and not expired, else null. */
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  try {
    const [payloadPart, signaturePart] = parts;
    const payloadBuf = Buffer.from(payloadPart, "base64url");
    const expectedSignature = sign(payloadBuf);
    const actualSignature = Buffer.from(signaturePart, "base64url");

    if (actualSignature.length !== expectedSignature.length) return null;
    if (!crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;

    const payload = JSON.parse(payloadBuf.toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// "Forgot password" tokens - deliberately separate from the session
// tokens above (those prove "you're logged in as X"; these prove "you
// clicked the reset link that was just emailed to X's inbox", nothing
// more). A reset token is high-entropy random bytes, not a low-entropy
// user-chosen password, so a plain fast SHA-256 hash (rather than the
// slow, memory-hard scrypt used for passwords above) is the right tool
// here - there's no realistic brute-force risk to defend against, only
// "don't store the raw, usable token in the database".
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Starts a password reset: a random raw token (only ever emailed to the
 * user, never stored) plus the hash of it that DOES get stored on the
 * User doc (see routes/auth.js POST /forgot-password), and an expiry.
 */
export function generateResetToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashResetToken(token), expires: new Date(Date.now() + RESET_TOKEN_TTL_MS) };
}

/**
 * True if `token` (the raw value from the reset link) matches `user`'s
 * currently-pending reset token and it hasn't expired yet. Constant-time
 * comparison for the same reason verifyPassword() above uses one - no
 * reason to let response timing leak how close a guess was.
 */
export function verifyResetToken(user, token) {
  if (!user?.resetTokenHash || !user?.resetTokenExpires) return false;
  if (user.resetTokenExpires.getTime() < Date.now()) return false;
  if (!token) return false;

  const expected = Buffer.from(user.resetTokenHash, "hex");
  const actual = Buffer.from(hashResetToken(token), "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Runs once at server startup. If no user accounts exist yet (a fresh
 * database), creates one so there's a way to log in at all - there's no
 * public sign-up page by design (see routes/auth.js: adding a user
 * requires already being logged in), so without this the app would lock
 * everyone out on first run.
 */
export async function ensureDefaultAdmin() {
  const count = await User.countDocuments();
  if (count > 0) return;

  const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
  const generatedPassword = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");

  await User.create({ name: "Admin", email, passwordHash: hashPassword(password) });

  console.log("[auth] No user accounts existed yet - created a default one so you can log in:");
  console.log(`[auth]   email:    ${email}`);
  console.log(
    generatedPassword
      ? `[auth]   password: ${password}  (generated - set ADMIN_PASSWORD in server/.env to control this, and please change it via Settings after your first login)`
      : "[auth]   password: (the value of ADMIN_PASSWORD in server/.env)"
  );
}
