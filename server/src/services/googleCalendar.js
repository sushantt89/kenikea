import { google } from "googleapis";
import { WORK_AREA_COLOR_IDS, timezoneForWorkArea } from "../utils/workAreas.js";
import { formatAssignedTitle } from "../utils/jobTitle.js";

/**
 * Adds an assignment to the team's Google Calendar. This uses a single
 * OAuth2 refresh token for the business's own Google account - it does NOT
 * ask each worker to connect their own account, which would need a much
 * bigger OAuth setup per worker.
 *
 * A job's team can change (auto-assign fills it, a worker is added/removed
 * by hand) - rather than trying to patch an existing event's attendee list
 * in place, syncAssignmentEvents() below just deletes whatever event(s)
 * existed before and creates fresh one(s) describing the *current* state,
 * whenever the team or a payout changes.
 *
 * NO INVITE GOES OUT AT ALL until every currently-assigned worker has a
 * payout entered - a team can be assigned and edited freely before that,
 * but nobody is notified via calendar until the pay is actually settled
 * (see syncAssignmentEvents). Once every payout is in, exactly how the
 * invite is split depends on whether everyone's being paid the same:
 *   - same amount for everyone -> ONE shared event, whole team invited,
 *     the pay line shows that one amount ("Worker payout: $30.00").
 *   - different amounts -> ONE PERSONAL event per worker (only they're
 *     invited to their own), the pay line shows just their own figure.
 *     Google Calendar has no way to show different text to different
 *     attendees on a single shared event, so this is the only way a
 *     worker never sees what a teammate is being paid. The admin isn't
 *     affected either way - the app's own Jobs tab always shows the full
 *     pay breakdown (IKEA payout, GST, admin cut, every worker's payout,
 *     profit) regardless of which path ran; only the calendar invite
 *     itself is limited to a bare worker-payout figure.
 *
 * The event is also colored by the job's own work area (see
 * utils/workAreas.js) so a shared calendar reads at a glance which area
 * each job belongs to, independent of who ends up assigned to it.
 *
 * If the required env vars aren't set, every function here becomes a
 * harmless no-op that reports "not configured" - the rest of the app
 * still works fine without Google Calendar wired up.
 */

let cachedClient = null;

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN
  );
}

function getClient() {
  if (cachedClient) return cachedClient;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

  cachedClient = google.calendar({ version: "v3", auth: oauth2Client });
  return cachedClient;
}

function defaultStart() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/**
 * Looks up the manually-entered payout for `worker` on `job`, from
 * job.assignedWorkers (works whether job.assignedWorkers[].worker is a
 * populated doc or a plain ObjectId).
 */
function payoutFor(job, worker) {
  const entry = (job.assignedWorkers || []).find((a) => {
    const id = a.worker?._id ?? a.worker;
    return String(id) === String(worker._id);
  });
  return entry?.payout ?? null;
}

/**
 * job.description is built by the scraper (or typed by hand) as one flowing
 * paragraph - several short facts joined with ". " (see scraper.js's
 * descriptionParts, e.g. "Products: A; B; C. Estimated duration: 106 mins.
 * Order #: 12345."). This splits it back into those individual facts so the
 * calendar event can show one bullet per item instead of a wall of text.
 * Splitting on a period+space that's followed by a capital letter or digit
 * targets exactly that join separator (a decimal amount like "$100.00"
 * has no space after its internal period, so it's never split apart) and
 * still degrades gracefully into plain sentence-splitting on descriptions
 * that aren't in that shape (e.g. from the generic HTML/JSON scraper
 * fallbacks, or typed by hand) - reads fine as a bulleted list either way.
 * Any "Customer: ..." fact already embedded in the text is dropped, since
 * the event builds its own dedicated Customer section straight from
 * job.customer instead (see buildDescription below).
 */
function descriptionBullets(text) {
  if (!text) return [];
  return text
    .split(/\.\s+(?=[A-Z0-9])/)
    .map((s) => s.trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .filter((s) => !/^customer:/i.test(s));
}

/**
 * Turns each fact from descriptionBullets() into a calendar line - almost
 * always one bullet per fact, EXCEPT "Products: A; B; C", which gets
 * exploded into its own numbered list (1. A, 2. B, 3. C, ...) instead of
 * one bullet with a dozen-plus items crammed onto a single semicolon-joined
 * line. Much easier to actually read on a job with a long parts list.
 *
 * "Charges total: ..." is dropped entirely rather than turned into a
 * bullet - the calendar invite is meant to show workers only their own
 * payout (see buildDescription's Pay section below), not the job's total
 * charge to the customer. This only affects the calendar - job.description
 * itself is untouched, so the Jobs tab still shows the full scraped detail.
 */
function jobDetailLines(description) {
  const lines = [];
  for (const item of descriptionBullets(description)) {
    if (/^Charges total:/i.test(item)) continue;
    const productsMatch = item.match(/^Products:\s*(.+)$/i);
    if (productsMatch) {
      const products = productsMatch[1]
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);
      lines.push(`Products (${products.length}):`);
      products.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    } else {
      lines.push(`• ${item}`);
    }
  }
  return lines;
}

/**
 * Appends one section to `lines`: a blank-line separator before it (if
 * there's already content above), an optional title, then one bulleted
 * line per item. Skipped entirely if there are no items, so an empty
 * section (e.g. no customer details captured) doesn't leave a stray title
 * or blank line behind.
 */
function pushSection(lines, title, items) {
  if (!items || items.length === 0) return;
  if (lines.length > 0) lines.push("");
  if (title) lines.push(title);
  for (const item of items) lines.push(`• ${item}`);
}

/**
 * Same as pushSection, but for lines that are already fully formatted
 * (e.g. jobDetailLines()'s numbered product sub-list) - pushed as-is
 * rather than auto-prefixed with "• ".
 */
function pushRawSection(lines, title, rawLines) {
  if (!rawLines || rawLines.length === 0) return;
  if (lines.length > 0) lines.push("");
  if (title) lines.push(title);
  lines.push(...rawLines);
}

/**
 * Builds one calendar event's description: the job's own scraped/typed
 * details (numbered product list included), a separate Customer section,
 * a Pay section, then the assigned team and source link - each section
 * visually separated by a blank line so it reads as distinct blocks rather
 * than one run-on wall of text.
 *
 * The Pay section deliberately shows ONLY a worker-payout figure - never
 * the IKEA payout, GST, admin cut or profit (those stay admin-only, inside
 * the app's own Jobs tab). `payoutView` controls exactly what that figure
 * is: { mode: "shared", amount } and { mode: "single", amount } both show
 * a plain "Worker payout: $X" line (no "each" suffix on the shared one -
 * every worker on that invite is already being paid that exact amount, so
 * it doesn't need qualifying). No payoutView at all omits the Pay section
 * entirely.
 */
function buildDescription(job, team, payoutView) {
  const lines = [];

  pushRawSection(lines, "Job details", jobDetailLines(job.description));

  // Name and phone only - the customer's email is deliberately left out
  // of the calendar invite (workers don't need it, and it's still visible
  // in the app's own Jobs tab for admin use).
  const customerItems = [];
  if (job.customer?.name) customerItems.push(`Name: ${job.customer.name}`);
  if (job.customer?.phone) customerItems.push(`Phone: ${job.customer.phone}`);
  pushSection(lines, "Customer", customerItems);

  const payItems = [];
  if (payoutView?.mode === "shared" || payoutView?.mode === "single") {
    payItems.push(`Worker payout: $${Number(payoutView.amount).toFixed(2)}`);
  }
  pushSection(lines, "Pay for this job", payItems);

  // No "Source: <link>" line anymore - that Beehiive URL isn't something a
  // worker needs to see on their calendar invite.
  pushSection(lines, null, [`Assigned team: ${team.map((w) => w.name).join(", ")}`]);

  return lines.join("\n");
}

/**
 * Creates ONE calendar event for a job assignment.
 * @param {object} job - needs title, description, location, sourceUrl, scheduledStart, durationMinutes, workArea, sourceUrl
 * @param {object[]} team - the FULL currently-assigned team (each needs name, email, _id) - used for the
 *   "Assigned team" line and the work-area color fallback, regardless of who's actually invited to THIS event
 * @param {object} [options]
 * @param {object[]} [options.attendees] - who actually gets invited to this event; defaults to the whole
 *   `team`. Pass a single-worker array to create a personal, one-attendee event instead.
 * @param {object} [options.payoutView] - what the Pay section shows; see buildDescription(). Omitted entirely
 *   hides the Pay section.
 * @returns {Promise<{created: boolean, eventId?: string, htmlLink?: string, start?: string, end?: string, reason?: string, usedDefaultTime?: boolean}>}
 */
export async function createAssignmentEvent(job, team, options = {}) {
  const fullTeam = (team || []).filter(Boolean);
  const attendees = (options.attendees || fullTeam).filter(Boolean);

  if (!isConfigured()) {
    return {
      created: false,
      reason:
        "Google Calendar is not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in server/.env - see README).",
    };
  }

  if (fullTeam.length === 0) {
    return { created: false, reason: "No workers are assigned to this job yet." };
  }

  const invitable = attendees.filter((w) => w.email);
  if (invitable.length === 0) {
    return { created: false, reason: "None of the assigned workers have an email address to invite." };
  }

  const usedDefaultTime = !job.scheduledStart;
  const start = job.scheduledStart ? new Date(job.scheduledStart) : defaultStart();
  const durationMinutes = job.durationMinutes && job.durationMinutes > 0 ? job.durationMinutes : 60;
  const end = new Date(start.getTime() + durationMinutes * 60000);

  const description = buildDescription(job, fullTeam, options.payoutView);

  // Colors/times by the job's OWN work area when it's set (see
  // utils/workAreas.js - this is deliberate so a job's color stays the same
  // no matter who ends up assigned). If a job somehow doesn't have its area
  // set (an address that didn't auto-guess, or a hand-created job where it
  // was left blank), fall back to whichever area the assigned team is
  // actually in - since jobs can now only be auto-assigned to workers in
  // the job's own area anyway (see assignment.js's hard work-area filter),
  // this fallback should usually agree with the job's area when it IS set,
  // and guarantees a job never shows up uncolored/default just because its
  // own area field wasn't filled in.
  const effectiveWorkArea = job.workArea || fullTeam.find((w) => w.workArea)?.workArea || null;
  const colorId = effectiveWorkArea ? WORK_AREA_COLOR_IDS[effectiveWorkArea] : undefined;
  // The dateTime below already carries the correct absolute instant (see
  // parseExpectedDate() in scraper.js / JobDraftForm.jsx on the frontend),
  // so this timeZone is mostly about how Google Calendar *displays* it -
  // explicitly the job's own area's zone rather than whatever zone the
  // invitee's Google account happens to default to, so a schedule "shows
  // as" the same real time everyone would expect for that job's location.
  const timeZone = timezoneForWorkArea(effectiveWorkArea);

  // Lead the event title with whoever is actually invited to THIS event
  // (not always the full team - a personal, single-worker event should only
  // show that one worker's name, not the whole team's), and move the
  // scraped "(Job <id>)" tag (see utils/jobTitle.js) up next to their
  // name(s) too, so a shared calendar reads "Ana + Ben (695676) - Attend,
  // set up..." at a glance without opening the event - matching the same
  // format the Jobs list uses (see client/src/components/JobCard.jsx).
  // Falls back to the plain title if somehow none of the invitees have a
  // name.
  const summary = formatAssignedTitle(
    job.title,
    invitable.map((w) => w.name)
  );

  try {
    const calendar = getClient();
    const { data } = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      sendUpdates: "all",
      requestBody: {
        summary,
        description,
        location: job.location || undefined,
        start: { dateTime: start.toISOString(), timeZone },
        end: { dateTime: end.toISOString(), timeZone },
        attendees: invitable.map((w) => ({ email: w.email, displayName: w.name })),
        ...(colorId ? { colorId } : {}),
      },
    });

    return {
      created: true,
      eventId: data.id,
      htmlLink: data.htmlLink,
      start: start.toISOString(),
      end: end.toISOString(),
      usedDefaultTime,
    };
  } catch (err) {
    return { created: false, reason: err.message };
  }
}

/**
 * Fully resyncs a job's Google Calendar invite(s) to match its CURRENT team
 * and payouts: deletes whatever event(s) existed before and creates
 * whatever the current state calls for. Mutates job.googleCalendar and
 * saves the job - callers don't need to persist that field themselves.
 * This is the ONE place that decides the shared-vs-personal-events split
 * described in this file's header comment; routes/jobs.js and
 * routes/workers.js both call this instead of createAssignmentEvent()
 * directly whenever a job's team or a payout changes.
 *
 * @param {object} job - a Mongoose Job document (will be saved)
 * @param {object[]} team - the FULL currently-assigned team (populated Worker docs)
 * @returns {Promise<{created: boolean, reason?: string, personalized?: boolean, count?: number, htmlLink?: string, usedDefaultTime?: boolean}>}
 *   one summary object suitable for showing directly in the UI
 */
export async function syncAssignmentEvents(job, team) {
  // Always start clean - simpler and more reliable than trying to patch
  // existing event(s) in place.
  for (const ev of job.googleCalendar?.events || []) {
    if (ev.eventId) await deleteAssignmentEvent(ev.eventId);
  }
  job.googleCalendar = { events: [] };

  const fullTeam = (team || []).filter(Boolean);
  if (fullTeam.length === 0) {
    await job.save();
    return { created: false, reason: "No workers are assigned to this job yet." };
  }

  if (!isConfigured()) {
    await job.save();
    return {
      created: false,
      reason:
        "Google Calendar is not configured (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in server/.env - see README).",
    };
  }

  // The actual gate: no invite of any kind until every assigned worker has
  // a payout entered - see this file's header comment for why.
  const payouts = fullTeam.map((w) => payoutFor(job, w));
  if (payouts.some((p) => p == null)) {
    await job.save();
    return {
      created: false,
      reason: "Waiting for a payout to be entered for every assigned worker before sending calendar invites.",
    };
  }

  const allSameAmount = payouts.every((p) => Number(p) === Number(payouts[0]));

  if (allSameAmount) {
    const result = await createAssignmentEvent(job, fullTeam, {
      payoutView: { mode: "shared", amount: payouts[0] },
    });
    if (result.created) {
      job.googleCalendar.events.push({ eventId: result.eventId, htmlLink: result.htmlLink, workerId: null });
    }
    await job.save();
    return result;
  }

  // Payouts differ - one personal event per worker, each invited alone, so
  // nobody can see a teammate's figure in a shared invite.
  const perWorkerResults = [];
  for (const worker of fullTeam) {
    const result = await createAssignmentEvent(job, fullTeam, {
      attendees: [worker],
      payoutView: { mode: "single", amount: payoutFor(job, worker) },
    });
    if (result.created) {
      job.googleCalendar.events.push({ eventId: result.eventId, htmlLink: result.htmlLink, workerId: worker._id });
    }
    perWorkerResults.push(result);
  }
  await job.save();

  const created = perWorkerResults.filter((r) => r.created);
  const failed = perWorkerResults.filter((r) => !r.created);
  if (created.length === 0) {
    return { created: false, reason: failed[0]?.reason || "Could not create any calendar invites." };
  }
  return {
    created: true,
    personalized: true,
    count: created.length,
    htmlLink: created[0].htmlLink,
    usedDefaultTime: created[0].usedDefaultTime,
    reason:
      failed.length > 0
        ? `${failed.length} invite(s) could not be sent: ${failed.map((f) => f.reason).join("; ")}`
        : undefined,
  };
}

/**
 * Cancels a previously created assignment event (e.g. on unassign/delete).
 * Silently does nothing if not configured or there's no event to cancel.
 */
export async function deleteAssignmentEvent(eventId) {
  if (!isConfigured() || !eventId) return { deleted: false };

  try {
    const calendar = getClient();
    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
      eventId,
      sendUpdates: "all",
    });
    return { deleted: true };
  } catch (err) {
    console.warn("[googleCalendar] failed to delete event:", err.message);
    return { deleted: false, reason: err.message };
  }
}

export { isConfigured };
