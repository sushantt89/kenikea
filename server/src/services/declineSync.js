import Job from "../models/Job.js";
import Worker from "../models/Worker.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import { getEventAttendees, syncAssignmentEvents } from "./googleCalendar.js";
import { sendEmail } from "./mailer.js";
import { formatAssignedTitle } from "../utils/jobTitle.js";

const WORKER_POPULATE = "name email location workArea";

/**
 * Checks every currently-Assigned job's live calendar invite(s) for a
 * DECLINED response from one of its own assigned workers, and for each one
 * it finds:
 *   - removes that worker from the job's team (they said no - leaving them
 *     assigned would be wrong)
 *   - re-syncs the job's calendar invite(s) to match the smaller team (see
 *     services/googleCalendar.js's syncAssignmentEvents), which also flips
 *     the job back to Unassigned automatically once nobody's left
 *   - creates a Notification (see models/Notification.js) so the bell icon
 *     in the navbar can point straight at the job
 *   - emails every User (this app's own login accounts - see
 *     models/User.js) so it's noticed even when nobody has the app open
 *
 * There's no background/cron process in this app - this only ever runs as
 * a side effect of someone actually loading a page (see routes/jobs.js's
 * GET / and routes/notifications.js's GET /, both of which call this
 * before responding), same pattern as routes/jobs.js's own
 * archiveStaleJobs(). Google never pushes a decline to this app on its
 * own, so a decline is only ever noticed the next time someone's using the
 * app after it happened - there's no true real-time push here.
 *
 * Once a worker's removed from a job's team this way, their old invite is
 * gone (syncAssignmentEvents deletes it), so the SAME decline can't be
 * re-detected and re-notified on a later check - this function only ever
 * creates one notification per actual decline.
 */
export async function checkCalendarDeclines() {
  const jobs = await Job.find({
    status: "Assigned",
    "googleCalendar.events.0": { $exists: true },
  }).populate("assignedWorkers.worker", WORKER_POPULATE);

  for (const job of jobs) {
    await checkOneJob(job);
  }
}

async function checkOneJob(job) {
  const declinedEmails = new Set();

  for (const ev of job.googleCalendar?.events || []) {
    if (!ev.eventId) continue;
    const attendees = await getEventAttendees(ev.eventId);
    for (const a of attendees) {
      if (a.responseStatus === "declined") declinedEmails.add(a.email.toLowerCase());
    }
  }
  if (declinedEmails.size === 0) return;

  const declinedAssignments = job.assignedWorkers.filter(
    (a) => a.worker?.email && declinedEmails.has(a.worker.email.toLowerCase())
  );
  if (declinedAssignments.length === 0) return;

  const declinedWorkers = declinedAssignments.map((a) => a.worker);
  const declinedIds = new Set(declinedWorkers.map((w) => String(w._id)));

  job.assignedWorkers = job.assignedWorkers.filter(
    (a) => !declinedIds.has(String(a.worker?._id || a.worker))
  );

  if (job.assignedWorkers.length === 0) {
    job.status = "Unassigned";
    job.assignedAt = null;
  }
  await job.save();

  // Re-syncs (or, if nobody's left, clears) the calendar invite(s) to
  // match the now-smaller team.
  const remaining = await Worker.find({ _id: { $in: job.assignedWorkers.map((a) => a.worker) } });
  await syncAssignmentEvents(job, remaining);

  const admins = await User.find({}, "email");
  const adminEmails = admins.map((u) => u.email).filter(Boolean);

  for (const worker of declinedWorkers) {
    // No other workers to lead with here - this notification is ABOUT one
    // specific worker declining, so their own name would be redundant as
    // the "who" in formatAssignedTitle(); just the job id + customer.
    const jobLabel = formatAssignedTitle(job.title, [], job.customer);
    const message = `${worker.name} declined the calendar invite for ${jobLabel} - it needs to be reassigned.`;

    await Notification.create({
      type: "worker-declined",
      message,
      job: job._id,
      worker: worker._id,
    });

    await Promise.all(
      adminEmails.map((to) =>
        sendEmail({
          to,
          subject: "A worker declined a job - needs reassignment",
          body: `${message}\n\nOpen the app to assign someone else.`,
        })
      )
    );
  }
}
