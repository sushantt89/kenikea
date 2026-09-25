import { Router } from "express";
import Job from "../models/Job.js";
import Worker from "../models/Worker.js";
import { scrapeJob, HttpError } from "../services/scraper.js";
import { rankCandidates, requiredWorkerCount } from "../services/assignment.js";
import { syncAssignmentEvents, deleteAssignmentEvent } from "../services/googleCalendar.js";
import { fillCoordinatesFromLocation, refreshCoordinatesOnUpdate } from "../services/geocode.js";
import { computePay } from "../services/pay.js";
import { WORK_AREAS } from "../utils/workAreas.js";

const router = Router();

const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const WORKER_POPULATE = "name email location workArea";

// A job counts as "old" once its own date - scheduledStart when it has
// one, otherwise when it was created - is more than 6 months in the past.
// Mirrors the same "job's own date" concept the Jobs page's period
// filters already use (see client/src/pages/Jobs.jsx's jobDate()).
function sixMonthsAgo() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d;
}

/**
 * Auto-archives every job whose own date is more than 6 months old and
 * isn't already archived. Run at the top of GET / (the Jobs list) so the
 * list is always current without needing a separate scheduled task/cron
 * process running alongside this single web service. Only ever flips
 * archived from false to true - a job archived this way (or by hand, see
 * POST /:id/archive below) stays archived until someone explicitly
 * unarchives it.
 */
async function archiveStaleJobs() {
  const cutoff = sixMonthsAgo();
  await Job.updateMany(
    {
      archived: { $ne: true },
      $or: [
        { scheduledStart: { $ne: null, $lt: cutoff } },
        { scheduledStart: null, createdAt: { $lt: cutoff } },
      ],
    },
    { $set: { archived: true, archivedAt: new Date() } }
  );
}

// GET /api/jobs - list all jobs, most recent first
router.get("/", async (req, res, next) => {
  try {
    await archiveStaleJobs();
    const jobs = await Job.find().sort({ createdAt: -1 }).populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json(jobs);
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id
router.get("/:id", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id).populate("assignedWorkers.worker", WORKER_POPULATE);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/scrape - fetch a link and return a best-guess draft.
// Nothing is saved to the database here; the frontend lets the user review
// and edit the draft before POSTing it to /api/jobs.
// Body: { url: string }
router.post("/scrape", async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });

    const draft = await scrapeJob(url);
    res.json(draft);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    next(err);
  }
});

// POST /api/jobs - save a (possibly user-edited) job draft
router.post("/", async (req, res, next) => {
  try {
    const data = attachPay(await fillCoordinatesFromLocation(sanitizeBody(req.body)));
    const job = await Job.create(data);
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id - edit a job's details
router.put("/:id", async (req, res, next) => {
  try {
    const existing = await Job.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ error: "Job not found" });

    const data = attachPay(await refreshCoordinatesOnUpdate(existing, sanitizeBody(req.body)));
    // NOT populated yet on purpose - regenerateCalendarEvent() below needs
    // assignedWorkers[].worker as plain ObjectIds (it does its own
    // Worker.find({_id: {$in: ...}})), same reason every other route that
    // calls it (assign-to, payout, ...) always does so before populating.
    const job = await Job.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    });

    // A job already assigned when it's edited (customer details, schedule,
    // work area, ...) had its calendar invite built from whatever the job
    // looked like at assignment time - without this, fixing a wrong/missing
    // customer email (or any other detail) after assigning a worker would
    // silently leave the existing invite stale, since nothing else here
    // regenerates it. syncAssignmentEvents() itself is a no-op when nobody's
    // assigned yet, so this is safe to call unconditionally, same as every
    // other route that touches an assigned job (assign-to, payout, ...).
    if (job.assignedWorkers.length > 0) {
      await regenerateCalendarEvent(job);
    }

    const populated = await job.populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json(populated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/jobs/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    for (const ev of job.googleCalendar?.events || []) {
      if (ev.eventId) await deleteAssignmentEvent(ev.eventId);
    }
    await job.deleteOne();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/jobs/:id/candidates - preview the ranked worker list WITHOUT assigning
router.get("/:id/candidates", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const result = await computeRanking(job);
    res.json({ ...result, requiredWorkers: requiredWorkerCount(job), currentTeamSize: job.assignedWorkers.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/assign - run the assignment engine and fill the
// WHOLE remaining team in one go (requiredWorkerCount() minus whoever's
// already on the job), not just a single worker - see assignment.js.
router.post("/:id/assign", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const needed = requiredWorkerCount(job) - job.assignedWorkers.length;
    if (needed <= 0) {
      return res.status(409).json({ error: "This job's team is already fully staffed." });
    }

    const result = await computeRanking(job);
    const picks = result.ranking.slice(0, needed);
    if (picks.length === 0) {
      return res.status(409).json({ error: "No eligible worker was found", ...result });
    }

    for (const pick of picks) {
      job.assignedWorkers.push({ worker: pick.workerId, payout: null });
    }
    job.status = "Assigned";
    job.assignedAt = new Date();
    await job.save();

    const calendarEvent = await regenerateCalendarEvent(job);

    const populated = await job.populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json({
      job: populated,
      ...result,
      assignedThisTime: picks.map((p) => ({ workerId: p.workerId, name: p.name })),
      calendarEvent,
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id/assign-to/:workerId - manual add, skips scoring. Adds
// this worker to the job's team (on top of anyone already assigned) rather
// than replacing it - a job can have more than one worker (see
// assignedWorkers on the Job model).
router.put("/:id/assign-to/:workerId", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const worker = await Worker.findById(req.params.workerId);
    if (!worker) return res.status(404).json({ error: "Worker not found" });

    const already = job.assignedWorkers.some((a) => String(a.worker) === String(worker._id));
    if (!already) {
      job.assignedWorkers.push({ worker: worker._id, payout: null });
    }
    job.status = "Assigned";
    if (!job.assignedAt) job.assignedAt = new Date();
    await job.save();

    const calendarEvent = await regenerateCalendarEvent(job);

    const populated = await job.populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json({ job: populated, calendarEvent });
  } catch (err) {
    next(err);
  }
});

// PUT /api/jobs/:id/payout/:workerId - set the manually-entered payout for
// one specific worker already on this job's team (see Job.assignedWorkers).
// Body: { payout: number | null }
router.put("/:id/payout/:workerId", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const entry = job.assignedWorkers.find((a) => String(a.worker) === req.params.workerId);
    if (!entry) return res.status(404).json({ error: "That worker is not assigned to this job." });

    const { payout } = req.body;
    entry.payout = payout === "" || payout === null || payout === undefined ? null : Number(payout);
    await job.save();

    // The event's description includes the pay breakdown, which just
    // changed - keep the calendar invite in sync.
    const calendarEvent = await regenerateCalendarEvent(job);

    const populated = await job.populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json({ job: populated, calendarEvent });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/unassign-worker/:workerId - remove ONE worker from the
// job's team, keeping the rest (see POST /:id/unassign below to clear the
// whole team at once).
router.post("/:id/unassign-worker/:workerId", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    job.assignedWorkers = job.assignedWorkers.filter((a) => String(a.worker) !== req.params.workerId);
    if (job.assignedWorkers.length === 0) {
      job.status = "Unassigned";
      job.assignedAt = null;
    }
    await job.save();

    const calendarEvent = await regenerateCalendarEvent(job);

    const populated = await job.populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json({ job: populated, calendarEvent });
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/unassign - clear the ENTIRE team and free everyone
// back up.
router.post("/:id/unassign", async (req, res, next) => {
  try {
    const job = await Job.findById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    for (const ev of job.googleCalendar?.events || []) {
      if (ev.eventId) await deleteAssignmentEvent(ev.eventId);
    }

    job.assignedWorkers = [];
    job.status = "Unassigned";
    job.assignedAt = null;
    job.googleCalendar = { events: [] };
    await job.save();

    const populated = await job.populate("assignedWorkers.worker", WORKER_POPULATE);
    res.json(populated);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/complete - mark done, frees up the worker's capacity
router.post("/:id/complete", async (req, res, next) => {
  try {
    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { status: "Completed" },
      { new: true }
    ).populate("assignedWorkers.worker", WORKER_POPULATE);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/archive - manually archive a job regardless of its
// age (the "Archive" button on every job's card) - see archiveStaleJobs()
// above for the automatic, 6-months-old version of this same flag. Doesn't
// touch status/assignment/calendar - archiving only hides a job from the
// normal Jobs list, it isn't a status change.
router.post("/:id/archive", async (req, res, next) => {
  try {
    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { archived: true, archivedAt: new Date() },
      { new: true }
    ).populate("assignedWorkers.worker", WORKER_POPULATE);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

// POST /api/jobs/:id/unarchive - bring an archived job back into the
// normal Jobs view.
router.post("/:id/unarchive", async (req, res, next) => {
  try {
    const job = await Job.findByIdAndUpdate(
      req.params.id,
      { archived: false, archivedAt: null },
      { new: true }
    ).populate("assignedWorkers.worker", WORKER_POPULATE);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  } catch (err) {
    next(err);
  }
});

async function computeRanking(job) {
  const workers = await Worker.find().lean();
  const activeJobs = await Job.find({ status: "Assigned", _id: { $ne: job._id } }).lean();
  return rankCandidates(job, workers, activeJobs, MAX_CONCURRENT_JOBS);
}

/**
 * Keeps the job's Google Calendar invite(s) in sync with its CURRENT team
 * and payouts - see syncAssignmentEvents() in services/googleCalendar.js
 * for the actual shared-vs-personal-events/payout-gating logic. This just
 * loads the current team's Worker docs and delegates.
 */
async function regenerateCalendarEvent(job) {
  const workers = await Worker.find({ _id: { $in: job.assignedWorkers.map((a) => a.worker) } });
  return syncAssignmentEvents(job, workers);
}

function sanitizeBody(body) {
  const {
    title,
    description,
    sourceUrl,
    location,
    lat,
    lng,
    workArea,
    difficulty,
    priority,
    scheduledStart,
    durationMinutes,
    customer,
    extraction,
    chargesTotal,
  } = body;
  const out = { title, description, sourceUrl, location, difficulty, priority };
  if (lat !== undefined && lat !== "") out.lat = Number(lat);
  if (lng !== undefined && lng !== "") out.lng = Number(lng);
  if (workArea !== undefined) out.workArea = WORK_AREAS.includes(workArea) ? workArea : null;
  if (scheduledStart !== undefined) out.scheduledStart = scheduledStart || null;
  if (durationMinutes !== undefined && durationMinutes !== "") out.durationMinutes = Number(durationMinutes);
  if (customer) out.customer = customer;
  if (extraction) out.extraction = extraction;
  // "" and null both mean "no price entered" - only a real, non-empty value
  // becomes a number. Explicitly included (even as null) so clearing the
  // field on an edit correctly wipes out any previously computed pay too -
  // see attachPay() below.
  if (chargesTotal !== undefined) {
    out.chargesTotal = chargesTotal === "" || chargesTotal === null ? null : Number(chargesTotal);
  }
  return out;
}

/**
 * Recomputes the `pay` breakdown (the ADMIN's cut - see services/pay.js)
 * from `data.chargesTotal` whenever that field was actually part of this
 * request (see sanitizeBody above) - leaves `pay` untouched on requests
 * that don't touch pricing at all (e.g. editing just a phone number), and
 * correctly clears it back to null when chargesTotal is cleared.
 */
function attachPay(data) {
  if (data.chargesTotal === undefined) return data;
  const pay = computePay(data.chargesTotal);
  data.pay = pay
    ? {
        gstRate: pay.gstRate,
        gstAmount: pay.gstAmount,
        afterGst: pay.afterGst,
        adminShare: pay.adminShare,
        adminPay: pay.adminPay,
      }
    : { gstRate: null, gstAmount: null, afterGst: null, adminShare: null, adminPay: null };
  return data;
}

export default router;
