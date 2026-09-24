import { Router } from "express";
import Worker from "../models/Worker.js";
import Job from "../models/Job.js";
import { fillCoordinatesFromLocation, refreshCoordinatesOnUpdate } from "../services/geocode.js";
import { syncAssignmentEvents, deleteAssignmentEvent } from "../services/googleCalendar.js";
import { syncAvailabilityFromForm } from "../services/availabilitySync.js";
import { getOrCreateRollout } from "../models/FormRollout.js";
import { sendEmail } from "../services/mailer.js";
import { createFortnightForm, isConfigured as formCreationConfigured } from "../services/formManager.js";
import { withParsedAvailability } from "../services/fortnightAvailability.js";
import { WORK_AREAS } from "../utils/workAreas.js";

const router = Router();

// GET /api/workers - list all workers, with their current active job count
router.get("/", async (req, res, next) => {
  try {
    const workers = await Worker.find().sort({ createdAt: -1 }).lean();
    const activeJobs = await Job.find({ status: "Assigned" }).lean();

    const countByWorker = new Map();
    for (const job of activeJobs) {
      for (const a of job.assignedWorkers || []) {
        const key = String(a.worker);
        countByWorker.set(key, (countByWorker.get(key) || 0) + 1);
      }
    }

    const withCounts = workers.map((w) => ({
      ...w,
      formAvailability: withParsedAvailability(w.formAvailability),
      activeJobCount: countByWorker.get(String(w._id)) || 0,
    }));

    res.json(withCounts);
  } catch (err) {
    next(err);
  }
});

router.post("/sync-availability", async (req, res, next) => {
  try {
    const rollout = await getOrCreateRollout();
    const result = await syncAvailabilityFromForm(rollout);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/workers/rollout-status - the current fortnight's form link and
// when it was last rolled out, for the Workers page's reminder banner (see
// models/FormRollout.js).
router.get("/rollout-status", async (req, res, next) => {
  try {
    const rollout = await getOrCreateRollout();
    res.json({ formUrl: rollout.formUrl, lastRolledOutAt: rollout.lastRolledOutAt });
  } catch (err) {
    next(err);
  }
});

// PUT /api/workers/rollout-status - update the form link (paste in the
// freshly duplicated form's URL for the next fortnight) without sending
// anything yet - see POST /roll-out below for the actual email step.
router.put("/rollout-status", async (req, res, next) => {
  try {
    const rollout = await getOrCreateRollout();
    rollout.formUrl = String(req.body.formUrl || "").trim();
    await rollout.save();
    res.json({ formUrl: rollout.formUrl, lastRolledOutAt: rollout.lastRolledOutAt });
  } catch (err) {
    next(err);
  }
});

// POST /api/workers/roll-out - the one-click version of the whole
// fortnight handover: when automatic form creation is configured (see
// services/formManager.js), this builds the NEXT fortnight's Google Form
// itself first and points FormRollout at it; either way, it then emails
// every worker with an email address the current form link and records
// this as the new "last rolled out" moment. Uses the same "not configured"
// pattern as the other Google integrations if a step isn't set up yet -
// this is NOT the availability sync itself (see POST /sync-availability
// above), just the "please go fill it in" nudge to the team.
router.post("/roll-out", async (req, res, next) => {
  try {
    const rollout = await getOrCreateRollout();
    let periodStart;
    let periodEnd;

    if (formCreationConfigured()) {
      const created = await createFortnightForm();
      if (!created.created) {
        return res.status(502).json({ error: `Could not create the next fortnight's form: ${created.reason}` });
      }
      rollout.formId = created.formId;
      rollout.formUrl = created.formUrl;
      rollout.questionMap = created.questionMap;
      periodStart = created.periodStart;
      periodEnd = created.periodEnd;
      await rollout.save();
    } else if (!rollout.formUrl) {
      return res.status(400).json({
        error:
          "Set the current fortnight's form link above before rolling it out (or set up automatic form creation - see README).",
      });
    } else {
      // Falling back to the manually-pasted link - still work out a
      // friendly Monday-Sunday x2 range for the email body, same as
      // createFortnightForm() would have.
      const today = new Date();
      const dayOfWeek = today.getDay();
      const daysUntilMonday = dayOfWeek === 1 ? 0 : (8 - dayOfWeek) % 7;
      periodStart = new Date(today);
      periodStart.setDate(periodStart.getDate() + daysUntilMonday);
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 13);
    }

    const workers = await Worker.find({ email: { $ne: "" } });
    if (workers.length === 0) {
      return res.status(400).json({ error: "No workers with an email address to send to." });
    }

    const fmt = (d) => d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
    const subject = "Please update your availability for the next fortnight";
    const bodyFor = (worker) =>
      [
        `Hi ${worker.name || "there"},`,
        "",
        `Please fill in your availability for the next fortnight (${fmt(periodStart)} - ${fmt(periodEnd)}):`,
        "",
        rollout.formUrl,
        "",
        "Thanks!",
      ].join("\n");

    const results = await Promise.all(
      workers.map(async (worker) => ({
        worker: worker.name,
        email: worker.email,
        ...(await sendEmail({ to: worker.email, subject, body: bodyFor(worker) })),
      }))
    );

    rollout.lastRolledOutAt = new Date();
    await rollout.save();

    const sent = results.filter((r) => r.sent);
    const failed = results.filter((r) => !r.sent);
    res.json({
      sent: sent.length,
      failed: failed.map((f) => ({ worker: f.worker, email: f.email, reason: f.reason })),
      lastRolledOutAt: rollout.lastRolledOutAt,
      formUrl: rollout.formUrl,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/workers/:id
router.get("/:id", async (req, res, next) => {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    const json = worker.toObject();
    json.formAvailability = withParsedAvailability(json.formAvailability);
    res.json(json);
  } catch (err) {
    next(err);
  }
});

// POST /api/workers - create
router.post("/", async (req, res, next) => {
  try {
    const data = await fillCoordinatesFromLocation(sanitizeBody(req.body));
    const worker = await Worker.create(data);
    res.status(201).json(worker);
  } catch (err) {
    next(err);
  }
});

// PUT /api/workers/:id - update
router.put("/:id", async (req, res, next) => {
  try {
    const existing = await Worker.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ error: "Worker not found" });

    const data = await refreshCoordinatesOnUpdate(existing, sanitizeBody(req.body));
    const worker = await Worker.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    });
    res.json(worker);
  } catch (err) {
    next(err);
  }
});

// PUT /api/workers/:id/availability - manually correct a worker's
// fortnight availability text from the "Click to see" popup
// (FortnightAvailability.jsx), without waiting on the next Google Form
// sync to overwrite it. Body: { entries: [{ date, text }] } - replaces
// the worker's ENTIRE formAvailability array with exactly what's given
// (the popup always edits the full list it's currently showing, so a
// partial/merge update isn't needed). Deliberately leaves
// formAvailabilitySyncedAt untouched - this is a manual correction, not a
// sync, so the "Last synced ..." timestamp shown in the popup should keep
// reflecting when the form was actually last pulled from.
router.put("/:id/availability", async (req, res, next) => {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: "Worker not found" });

    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    const cleaned = [];
    for (const e of entries) {
      const date = new Date(e?.date);
      if (Number.isNaN(date.getTime())) {
        return res.status(400).json({ error: "One of the availability entries has an invalid date." });
      }
      cleaned.push({ date, text: String(e?.text || "").trim() });
    }

    worker.formAvailability = cleaned;
    await worker.save();

    res.json({
      formAvailability: withParsedAvailability(worker.formAvailability),
      formAvailabilitySyncedAt: worker.formAvailabilitySyncedAt,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workers/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const worker = await Worker.findByIdAndDelete(req.params.id);
    if (!worker) return res.status(404).json({ error: "Worker not found" });

    // Pull this worker off every job's team so nothing is left dangling -
    // a job can have more than one worker now (see Job.assignedWorkers), so
    // this only touches jobs that actually had them on the team, and only
    // drops that one entry rather than clearing the whole team.
    const affectedJobs = await Job.find({ "assignedWorkers.worker": worker._id });
    for (const job of affectedJobs) {
      job.assignedWorkers = job.assignedWorkers.filter((a) => String(a.worker) !== String(worker._id));

      if (job.assignedWorkers.length === 0) {
        // No one left on the team - back to Unassigned, and cancel any
        // calendar invite(s) (nothing left to invite anyone to).
        for (const ev of job.googleCalendar?.events || []) {
          if (ev.eventId) await deleteAssignmentEvent(ev.eventId);
        }
        job.status = "Unassigned";
        job.assignedAt = null;
        job.googleCalendar = { events: [] };
        await job.save();
      } else {
        // Other workers are still on the team - resync the invite(s) so
        // they no longer include the worker who was just deleted (also
        // saves the job - see syncAssignmentEvents).
        const remaining = await Worker.find({ _id: { $in: job.assignedWorkers.map((a) => a.worker) } });
        await syncAssignmentEvents(job, remaining);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function sanitizeBody(body) {
  const {
    name,
    email,
    location,
    lat,
    lng,
    workArea,
    gender,
    phone,
    availability,
    skillLevel,
    priority,
  } = body;

  const out = { name, email, location, gender, phone, availability, skillLevel, priority };
  if (lat !== undefined && lat !== "") out.lat = Number(lat);
  if (lng !== undefined && lng !== "") out.lng = Number(lng);
  if (workArea !== undefined) out.workArea = WORK_AREAS.includes(workArea) ? workArea : null;
  return out;
}

export default router;
