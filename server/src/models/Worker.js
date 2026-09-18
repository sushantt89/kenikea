import mongoose from "mongoose";
import { WORK_AREAS } from "../utils/workAreas.js";

const { Schema } = mongoose;

const WorkerSchema = new Schema(
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
    location: {
      type: String,
      required: [true, "Location is required"],
      trim: true,
    },
    // Optional precise coordinates. If both are provided the assignment
    // engine will use real distance instead of text matching.
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // Which of the business's work areas this worker is based in - purely
    // informational/organisational (unlike Job.workArea, this does NOT
    // drive the calendar color - see utils/workAreas.js for why).
    workArea: {
      type: String,
      enum: [...WORK_AREAS, null],
      default: null,
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other", "Prefer not to say"],
      default: "Prefer not to say",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    // LEGACY/unused - this used to be a plain on/off roster toggle that
    // hard-excluded a worker from the assignment engine (see
    // services/assignment.js). It's no longer shown anywhere in the UI
    // (removed from WorkerForm.jsx) and no longer read by the assignment
    // engine, which now checks the day-by-day fortnightly answers below
    // instead (see services/fortnightAvailability.js) - kept in the schema
    // only so existing documents/data aren't disturbed.
    availability: {
      type: Boolean,
      default: true,
    },
    // Day-by-day answers from the team's fortnightly Google Form ("Bi-weekly
    // Schedule Update"), synced in by services/availabilitySync.js - see
    // that file for the sync itself. Each entry is one calendar date this
    // worker has answered for, in their own free-text words (e.g.
    // "8am-5pm" or "Not available"). Purely informational/for the admin to
    // see at a glance - it does NOT feed the assignment engine, unlike the
    // plain `availability` toggle above.
    formAvailability: {
      type: [
        {
          date: { type: Date, required: true },
          text: { type: String, default: "" },
        },
      ],
      default: [],
    },
    formAvailabilitySyncedAt: { type: Date, default: null },
    skillLevel: {
      type: Number,
      min: 1,
      max: 5,
      required: [true, "Skill level (1-5) is required"],
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },
  },
  { timestamps: true }
);

export default mongoose.model("Worker", WorkerSchema);
