import { Router } from "express";
import User from "../models/User.js";
import { hashPassword, verifyPassword, createToken, generateResetToken, verifyResetToken } from "../services/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { sendEmail } from "../services/mailer.js";

const router = Router();

function publicUser(u) {
  return { _id: u._id, name: u.name, email: u.email, createdAt: u.createdAt };
}

// POST /api/auth/login - the only unauthenticated route in this file.
// There's no public sign-up: new accounts are only created by someone
// who's already logged in, from the Settings page (see POST /users below).
router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are both required." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      // Deliberately the same message for "no such account" and "wrong
      // password" - confirming which one it was would let someone probe
      // for valid email addresses.
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    const token = createToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password - request a password reset link by
// email. Unauthenticated on purpose (that's the whole point - you're here
// because you're locked out). Always responds with the same generic
// message whether or not that email actually has an account, and takes
// the same amount of visible action either way (no early-return before
// the "send" step) - same "don't let this route be used to probe which
// emails have accounts" reasoning as /login's single wrong-email-or-
// password message above.
// The base URL the reset link should point at. CLIENT_ORIGIN is used when
// it's explicitly set (local dev, or any deployment that sets it
// on purpose - see .env.example), but the single-service Render setup
// documented in the README deliberately leaves it UNSET (frontend and API
// are the same origin there, so there's nothing to CORS-allow) - falling
// back to a hardcoded localhost default in that case would silently put a
// broken "http://localhost:5173/..." link in every password-reset email
// sent from production. The incoming request's own origin is the correct
// fallback instead: in that single-service setup it genuinely IS the
// real public URL (req.protocol needs app.set("trust proxy", 1) in
// index.js to correctly report "https" behind Render's proxy - see there).
function resolveClientOrigin(req) {
  if (process.env.CLIENT_ORIGIN) return process.env.CLIENT_ORIGIN;
  return `${req.protocol}://${req.get("host")}`;
}

router.post("/forgot-password", async (req, res, next) => {
  const generic = { message: "If an account exists for that email, we've sent a password reset link." };
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const user = email ? await User.findOne({ email }) : null;

    if (user) {
      const { token, tokenHash, expires } = generateResetToken();
      user.resetTokenHash = tokenHash;
      user.resetTokenExpires = expires;
      await user.save();

      const resetUrl = `${resolveClientOrigin(req)}/reset-password?email=${encodeURIComponent(
        user.email
      )}&token=${token}`;
      const result = await sendEmail({
        to: user.email,
        subject: "Reset your password",
        body: `Hi ${user.name},

Someone (hopefully you) asked to reset the password for this account.

Click the link below to choose a new one - it expires in 1 hour and only works once:
${resetUrl}

If you didn't ask for this, you can safely ignore this email - your password hasn't been changed.`,
      });
      // Still the generic response either way - only logged server-side,
      // so a misconfigured mailer doesn't fail silently forever but also
      // doesn't tell an outside caller anything about this email.
      if (!result.sent) console.error(`[auth] Couldn't send password reset email to ${user.email}:`, result.reason);
    }

    res.json(generic);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password - completes a reset started above.
// Body: { email, token, password }
router.post("/reset-password", async (req, res, next) => {
  try {
    const { email, token, password } = req.body || {};
    if (!email || !token || !password) {
      return res.status(400).json({ error: "Email, reset link, and new password are all required." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user || !verifyResetToken(user, token)) {
      // Deliberately generic - covers "no such account", "wrong/tampered
      // token", and "expired" alike, same reasoning as /login above.
      return res.status(400).json({ error: "This reset link is invalid or has expired - request a new one." });
    }

    user.passwordHash = hashPassword(password);
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    await user.save();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me - restores the logged-in user on a page refresh (the
// frontend calls this once on load if it has a saved token).
router.get("/me", requireAuth, async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// GET /api/auth/users - list accounts, for the Settings page.
router.get("/users", requireAuth, async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: 1 }).lean();
    res.json(users.map(publicUser));
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/users - add a new user account. Requires being logged in
// already (see the module comment above for why there's no public version
// of this).
router.post("/users", requireAuth, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: "Email is required." });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: "A user with that email already exists." });
    }

    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
    });
    res.status(201).json(publicUser(user));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/users/:id - remove a user account. You can't delete the
// account you're currently logged in as, so there's no way to accidentally
// lock everyone out via the UI.
router.delete("/users/:id", requireAuth, async (req, res, next) => {
  try {
    if (String(req.user._id) === req.params.id) {
      return res.status(400).json({ error: "You can't delete your own account while logged in as it." });
    }

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
