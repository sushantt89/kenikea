import mongoose from "mongoose";

const { Schema } = mongoose;

// A single, singleton-style document tracking the team's fortnightly
// availability form - just enough state for the Workers page to show
// "last rolled out X days ago" / "next one due in Y days", and to know
// which form to email out / read answers back from when the admin clicks
// "Roll out to all workers".
//
// There's always at most one of these - see getOrCreate() below, which
// every route uses instead of Model.find()/create() directly.
const FormRolloutSchema = new Schema(
  {
    // The current fortnight's Google Form link. When formId/questionMap
    // below are set, this was created automatically by
    // services/formManager.js and kept in lockstep with them - don't edit
    // it by hand in that case. When they're NOT set (the original,
    // hand-made form, or automatic creation isn't configured yet), this is
    // a plain manually-pasted fallback link - see README > Worker
    // availability sync.
    formUrl: { type: String, default: "", trim: true },
    // Set only for a form this app created itself via the Google Forms API
    // (see services/formManager.js's createFortnightForm) - lets
    // availabilitySync.js read answers straight from the Forms API instead
    // of needing a linked Google Sheet at all. Null for the original,
    // hand-made form (which still goes through the Sheets-based sync).
    formId: { type: String, default: null },
    // Maps each question's Forms-API questionId back to what it actually
    // is (email/name/location, or one specific calendar date) - only
    // meaningful alongside formId above. Kept as a loose object rather
    // than its own strict sub-schema since it's write-once per form and
    // only ever read back by availabilitySync.js, never edited by hand.
    questionMap: { type: Schema.Types.Mixed, default: null },
    // When "Roll out to all workers" was last clicked - drives the "next
    // one due in N days" reminder on the Workers page (14 days later).
    lastRolledOutAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const FormRollout = mongoose.model("FormRollout", FormRolloutSchema);

export async function getOrCreateRollout() {
  let doc = await FormRollout.findOne();
  if (!doc) doc = await FormRollout.create({});
  return doc;
}

export default FormRollout;
