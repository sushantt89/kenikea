import { Router } from "express";
import User from "../models/User.js";
import { hashPassword, verifyPassword, createToken } from "../services/auth.js";
import { requireAuth } from "../middleware/auth.js";

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
