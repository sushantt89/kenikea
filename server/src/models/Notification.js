import mongoose from "mongoose";
import { sendPush } from "../services/push.js";

const { Schema } = mongoose;

// A single "needs your attention" alert shown via the bell icon in the
// navbar (see client/src/components/NotificationBell.jsx). Two things
// create these today:
//   - services/declineSync.js's checkCalendarDeclines(), type
//     "worker-declined" - a worker clicked "No" on their calendar invite
//     and the job needs reassigning.
//   - services/availabilitySync.js's checkNewAvailabilitySubmissions(),
//     type "availability-submitted" - someone just submitted the
//     fortnightly availability form.
const NotificationSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["worker-declined", "availability-submitted"],
      default: "worker-declined",
    },
    // Fully-formed, ready to show as-is - see declineSync.js.
    message: {
      type: String,
      required: true,
    },
    // Which job (if any) clicking this notification should jump to - see
    // client/src/pages/Jobs.jsx's "focus" query param handling.
    job: { type: Schema.Types.ObjectId, ref: "Job", default: null },
    worker: { type: Schema.Types.ObjectId, ref: "Worker", default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Every newly created notification is also pushed to phones/desktops that
// turned push on in Settings (see services/push.js) - hooked here, on the
// model, so it fires no matter which service created the notification.
// Fire-and-forget: sendPush() never throws.
NotificationSchema.pre("save", function () {
  this.$locals.wasNew = this.isNew;
});
NotificationSchema.post("save", function (doc) {
  if (!doc.$locals.wasNew) return;
  let url = "/";
  if (doc.job) url = `/jobs?focus=${doc.job}`;
  else if (doc.worker) url = `/workers?focus=${doc.worker}`;
  sendPush({ title: "Worker Assignment", body: doc.message, url, tag: String(doc._id) });
});

export default mongoose.model("Notification", NotificationSchema);
