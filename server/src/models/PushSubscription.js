import mongoose from "mongoose";

const { Schema } = mongoose;

// One browser/device that has turned on push notifications (see
// routes/push.js and client/src/components/PushNotifications.jsx). The
// `endpoint` is the push service's unique URL for that device, so it's the
// natural identity - re-subscribing the same device just updates the row.
const PushSubscriptionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("PushSubscription", PushSubscriptionSchema);
