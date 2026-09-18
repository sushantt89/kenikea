import mongoose from "mongoose";

const { Schema } = mongoose;

// A login account for someone using this app (the business owner, office
// staff, etc.) - separate from Worker, which is the roster of people jobs
// get assigned to. A worker doesn't need a login; a User does.
const UserSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      trim: true,
      lowercase: true,
      unique: true,
      match: [/^\S+@\S+\.\S+$/, "Email is not valid"],
    },
    // Never the plain password - see services/auth.js (hashPassword/
    // verifyPassword, Node's built-in crypto.scrypt).
    passwordHash: {
      type: String,
      required: true,
    },
    // "Forgot password" support (see routes/auth.js POST /forgot-password
    // and /reset-password, services/auth.js generateResetToken/
    // verifyResetToken). Only ever a HASH of the token that was emailed -
    // never the raw token itself - same reasoning as passwordHash above: a
    // database leak alone shouldn't be enough to let someone reset an
    // account's password. null/null means no reset is currently pending.
    resetTokenHash: {
      type: String,
      default: null,
    },
    resetTokenExpires: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("User", UserSchema);
