import User from "../models/User.js";
import { verifyToken } from "../services/auth.js";

/**
 * Protects a route: requires a valid `Authorization: Bearer <token>` header
 * (see services/auth.js for what "valid" means - signed by this server,
 * not expired, and still pointing at an account that exists). On success,
 * attaches the logged-in user as `req.user` (a plain object - the
 * passwordHash is left off deliberately, see below) and calls next();
 * otherwise responds 401 without reaching the route handler at all.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;

    if (!payload) {
      return res.status(401).json({ error: "Please log in to continue." });
    }

    const user = await User.findById(payload.sub).select("-passwordHash").lean();
    if (!user) {
      return res.status(401).json({ error: "Your account no longer exists - please log in again." });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
