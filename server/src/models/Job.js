import mongoose from "mongoose";
import { WORK_AREAS } from "../utils/workAreas.js";

const { Schema } = mongoose;

const JobSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Blank for a manually-created job (see client's Home.jsx "+ Create a
    // job manually" button) - only a job scraped from a real link has one.
    sourceUrl: {
      type: String,
      default: "",
      trim: true,
    },
    location: {
      type: String,
      default: "",
      trim: true,
    },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    // Which of the business's work areas this job is in - auto-guessed from
    // the address (see services/scraper.js + utils/workAreas.js) but
    // editable by hand. Drives the Google Calendar event color for this
    // job (see services/googleCalendar.js) - deliberately the JOB's area,
    // not whichever worker(s) end up assigned.
    workArea: {
      type: String,
      enum: [...WORK_AREAS, null],
      default: null,
    },
    // Easy (under 1hr), Medium (1-3hrs), Difficult (over 3hrs) - doubles as
    // "required skill level" for the assignment engine (see
    // services/assignment.js, which maps a worker's 1-5 skillLevel onto
    // this same three-tier scale to score the match).
    difficulty: {
      type: String,
      enum: ["Easy", "Medium", "Difficult"],
      default: "Medium",
    },
    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },
    status: {
      type: String,
      enum: ["Unassigned", "Assigned", "Completed"],
      default: "Unassigned",
    },
    // A job can need more than one worker (see requiredWorkerCount() in
    // services/assignment.js - a job over 3 hours needs 2, one with an IKEA
    // payout over $500 needs 3). Each entry's `payout` is what that
    // specific worker is being paid for this job, entered by hand (it's
    // not automatically calculated - see the `pay` block below for the
    // one figure that IS calculated, which is the business/admin's cut).
    assignedWorkers: [
      {
        worker: { type: Schema.Types.ObjectId, ref: "Worker" },
        payout: { type: Number, default: null },
      },
    ],
    assignedAt: {
      type: Date,
      default: null,
    },
    // When the job should happen, and how long it's expected to take.
    // Used to build the Google Calendar event on assignment.
    scheduledStart: {
      type: Date,
      default: null,
    },
    durationMinutes: {
      type: Number,
      default: 60,
    },
    // Customer details, when the source job includes them (e.g. a
    // homeowner requesting an assembly/repair). Purely informational.
    customer: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
    },
    // The IKEA payout to the business for this job, in AUD - scraped when
    // available (see scraper.js) or entered by hand. Drives the `pay`
    // breakdown below; see services/pay.js for the formula.
    chargesTotal: { type: Number, default: null },
    // Snapshot of the ADMIN'S pay calculation at the rates that applied
    // when it was last computed (on save) - i.e. what the business itself
    // receives from the IKEA payout after GST and its share, NOT what any
    // individual worker is paid (that's assignedWorkers[].payout above,
    // entered by hand per worker). Snapshotted so a later change to the
    // business's GST rate or share doesn't silently rewrite the numbers on
    // jobs that already went out with a calendar invite. See
    // services/pay.js for the formula.
    pay: {
      gstRate: { type: Number, default: null },
      gstAmount: { type: Number, default: null },
      afterGst: { type: Number, default: null },
      adminShare: { type: Number, default: null },
      adminPay: { type: Number, default: null },
    },
    // Populated after Google Calendar event(s) are created for the
    // assignment, so they can be looked up/cancelled later. A job can end
    // up with MORE THAN ONE event: when every assigned worker is being
    // paid the same amount, one shared event invites the whole team; when
    // payouts differ, each worker gets their OWN personal event instead so
    // nobody can see a teammate's pay in a shared invite description (see
    // services/googleCalendar.js's syncAssignmentEvents). `workerId` is
    // null on a shared event's entry, or set to that one worker's id on a
    // personal event. No events exist at all until every assigned worker
    // has a payout entered.
    googleCalendar: {
      events: {
        type: [
          {
            eventId: { type: String },
            htmlLink: { type: String },
            workerId: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
          },
        ],
        default: [],
      },
    },
    // Set when the scraper produced a best-guess field so the UI can
    // flag it for the user to double check before saving.
    extraction: {
      confidence: { type: String, enum: ["high", "medium", "low"], default: "low" },
      notes: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Job", JobSchema);
