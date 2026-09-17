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
    availability: {
      type: Boolean,
      default: true,
    },
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
