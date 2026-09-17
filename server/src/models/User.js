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
  },
  { timestamps: true }
);

export default mongoose.model("User", UserSchema);
