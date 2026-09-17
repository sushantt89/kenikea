import { Router } from "express";
import Worker from "../models/Worker.js";
import Job from "../models/Job.js";
import { fillCoordinatesFromLocation, refreshCoordinatesOnUpdate } from "../services/geocode.js";
import { syncAssignmentEvents, deleteAssignmentEvent } from "../services/googleCalendar.js";
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
      activeJobCount: countByWorker.get(String(w._id)) || 0,
    }));

    res.json(withCounts);
  } catch (err) {
    next(err);
  }
});

// GET /api/workers/:id
router.get("/:id", async (req, res, next) => {
  try {
    const worker = await Worker.findById(req.params.id);
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    res.json(worker);
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
