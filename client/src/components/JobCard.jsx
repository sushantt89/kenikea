import { useState, useEffect } from "react";
import {
  getCandidates,
  assignJob,
  assignJobTo,
  setWorkerPayout,
  unassignWorkerFromJob,
  unassignJob,
  completeJob,
  deleteJob,
  updateJob,
  archiveJob,
  unarchiveJob,
} from "../api.js";
import JobDraftForm from "./JobDraftForm.jsx";
import { normalizeScore, scoreColor } from "../utils/scoreScale.js";
import { requiredWorkerCount } from "../utils/team.js";
import { WORK_AREA_SWATCH, timezoneForWorkArea, currencyForWorkArea, CURRENCY_SYMBOL } from "../utils/workAreas.js";
import { formatInZone } from "../utils/timezone.js";
import { formatAssignedTitle } from "../utils/jobTitle.js";
import { useToast } from "../toast/ToastContext.jsx";
import { FortnightCell, FortnightModal } from "./FortnightAvailability.jsx";

const STATUS_CLASS = {
  Unassigned: "pill-gray",
  Assigned: "pill-blue",
  Completed: "pill-green",
};

// A raw assignment-engine score (see server/src/services/assignment.js -
// every factor uses a different range) rendered as a common 1-10 scale
// plus a colored bar, so every column in the ranking table means the same
// thing at a glance. The true raw value is always still available as a
// tooltip and (for Location) as an actual distance - see scoreScale.js for
// why 1-10 rather than the raw points.
function ScoreCell({ raw, kind, tooltip, sub }) {
  const { tenScale, percent } = normalizeScore(raw, kind);
  return (
    <td title={tooltip}>
      <div className="score-cell">
        <div className="score-bar-track">
          <div className="score-bar-fill" style={{ width: `${percent}%`, background: scoreColor(percent) }} />
        </div>
        <span className="score-value">{tenScale}/10</span>
        {sub && <span className="score-sub">{sub}</span>}
      </div>
    </td>
  );
}

// Shown in the job's own work-area timezone (with its abbreviation, e.g.
// ACST/AEDT/NZST) rather than whoever's viewing the page's local time - a
// job scheduled for "7:00am" in Adelaide should always read as 7:00am
// Adelaide time, even viewed from Auckland or overseas.
function formatDateTime(iso, workArea) {
  return formatInZone(iso, timezoneForWorkArea(workArea));
}

// `currency` defaults to AUD (this app's original single-currency
// assumption) but every call site in this file passes the job's own
// currency (see currencyForWorkArea in utils/workAreas.js), so an Auckland
// job's figures read as "NZ$..." instead of a bare "$" that implies AUD.
function money(n, currency = "AUD") {
  const symbol = CURRENCY_SYMBOL[currency] || "$";
  return `${symbol}${Number(n).toFixed(2)}`;
}

// Splits `total` (a dollar amount) into `count` equal cent-accurate shares
// that add back up to EXACTLY `total` - naively rounding each share to
// cents on its own can be off by a cent or two once they're added back up
// (e.g. splitting $6.75 two ways as round(6.75/2) + round(6.75/2) gives
// $3.38 + $3.38 = $6.76, a cent over). Every share gets the same
// rounded-down cent amount; whatever's left over (always fewer cents than
// there are shares) is handed out one cent at a time starting from the
// last share, since there's no fairer way to split a leftover cent than
// just picking somewhere for it to go.
function splitEqually(total, count) {
  const totalCents = Math.round(total * 100);
  const base = Math.floor(totalCents / count);
  const leftoverCents = totalCents - base * count;
  const shares = new Array(count).fill(base);
  for (let i = 0; i < leftoverCents; i++) shares[count - 1 - i] += 1;
  return shares.map((c) => c / 100);
}

// job.description is one flowing paragraph - short facts joined with ". "
// (see server/src/services/scraper.js's descriptionParts, e.g.
// "Products: A; B; C. Estimated duration: 106 mins."). This splits it back
// into those individual facts to render as separate lines instead of one
// wall of text - mirrors descriptionBullets() in
// server/src/services/googleCalendar.js (kept in sync by hand, same as
// this app's other small client/server utility duplicates). Any
// "Customer: ..." fact is dropped since the card already shows that
// separately, straight from job.customer.
function splitDescriptionFacts(text) {
  if (!text) return [];
  return text
    .split(/\.\s+(?=[A-Z0-9])/)
    .map((s) => s.trim().replace(/\.+$/, ""))
    .filter(Boolean)
    .filter((s) => !/^customer:/i.test(s));
}

// Renders job.description as a short list of facts, one per line - except
// "Products: A; B; C", which becomes its own numbered list (1. A, 2. B,
// 3. C, ...) instead of one line with a dozen-plus items crammed together
// separated by semicolons.
function JobDescriptionView({ description }) {
  const facts = splitDescriptionFacts(description);
  if (facts.length === 0) return null;

  return (
    <div className="job-description">
      {facts.map((fact, i) => {
        const productsMatch = fact.match(/^Products:\s*(.+)$/i);
        if (productsMatch) {
          const products = productsMatch[1]
            .split(";")
            .map((p) => p.trim())
            .filter(Boolean);
          return (
            <div key={i} className="job-description-products">
              <span className="job-description-label">Products ({products.length}):</span>
              <ol>
                {products.map((p, j) => (
                  <li key={j}>{p}</li>
                ))}
              </ol>
            </div>
          );
        }
        return (
          <p key={i} className="job-description-line">
            {fact}
          </p>
        );
      })}
    </div>
  );
}

// One assigned worker's row: name/location, an editable payout amount, and
// a Remove button. The payout input is now a plain controlled field - it no
// longer saves itself on blur (see the file header note on handleAssignPayouts
// in JobCard below for why); typing here just updates the draft value kept
// in JobCard's state, and nothing is sent to the server until the ASSIGN
// button is clicked.
function AssignedWorkerRow({ assignment, value, disabled, onDraftChange, onRemove, currencySymbol }) {
  const worker = assignment.worker || {};

  return (
    <div className="assigned-worker-row">
      <span className="assigned-worker-name">
        <strong>{worker.name || "Unknown worker"}</strong>
        {worker.location && <span className="muted small"> ({worker.location})</span>}
      </span>
      <label className="payout-input">
        <span className="muted small">Payout {currencySymbol}</span>
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={value}
          disabled={disabled}
          onChange={(e) => onDraftChange(worker._id, e.target.value)}
        />
      </label>
      {!disabled && (
        <button className="btn btn-tiny btn-danger" onClick={() => onRemove(worker._id)}>
          Remove
        </button>
      )}
    </div>
  );
}

export default function JobCard({ job, onChange, highlighted }) {
  const { showToast } = useToast();
  const [ranking, setRanking] = useState(null);
  const [openCandidate, setOpenCandidate] = useState(null);
  const [rankingError, setRankingError] = useState("");
  const [calendarStatus, setCalendarStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [payoutDrafts, setPayoutDrafts] = useState({});
  const [editing, setEditing] = useState(false);

  const assignedWorkers = job.assignedWorkers || [];
  const needed = requiredWorkerCount(job);
  const teamFull = assignedWorkers.length >= needed;

  // Keep the payout draft inputs in sync with the server's copy whenever the
  // assigned team or its saved payouts change (a fresh assignment, a
  // removal, a refetch after another edit) - each entry starts out matching
  // whatever's already saved, and typing from there just edits this local
  // draft until ASSIGN is clicked.
  //
  // A worker who doesn't have a SAVED payout yet gets their draft
  // pre-filled with a suggested amount instead of starting blank: the
  // "proposed worker payout" (job.pay.adminPay - the business's own GST/
  // share math, see services/pay.js) split equally between however many
  // assigned workers still need a payout, so a solo assignment is
  // suggested the whole amount and a 2-person team is suggested half each.
  // It's still just a draft - nothing is saved until ASSIGN is clicked, and
  // it's fully editable first (see the file header note on
  // handleAssignPayouts below for why nothing auto-saves on its own).
  // Editing it down (or up) before clicking ASSIGN is exactly how the
  // profit line ends up different from adminPay - profit is always
  // `adminPay - (sum of every assigned worker's SAVED payout)`, so paying a
  // worker less than the suggested amount simply leaves the rest as extra
  // profit, no separate calculation needed for that.
  // A worker who ALREADY has a saved payout keeps showing exactly that -
  // adding a new teammate later never silently changes pay that's already
  // been committed; only whoever's still unpaid shares what's left of the
  // proposed payout (adminPay minus whatever's already been committed to
  // other workers on this job).
  const assignedKey = assignedWorkers.map((a) => `${a.worker?._id || a.worker}:${a.payout ?? ""}`).join(",");
  useEffect(() => {
    const adminPay = job.pay?.adminPay ?? null;
    const committed = assignedWorkers.reduce((sum, a) => sum + (a.payout != null ? Number(a.payout) : 0), 0);
    const unsetIds = assignedWorkers
      .filter((a) => a.payout == null)
      .map((a) => a.worker?._id || a.worker);
    const remainingPot = adminPay != null ? Math.max(0, adminPay - committed) : null;
    const suggestedById = {};
    if (remainingPot != null && unsetIds.length > 0) {
      splitEqually(remainingPot, unsetIds.length).forEach((share, i) => {
        suggestedById[unsetIds[i]] = share;
      });
    }

    const next = {};
    for (const a of assignedWorkers) {
      const id = a.worker?._id || a.worker;
      next[id] = a.payout != null ? a.payout : suggestedById[id] ?? "";
    }
    setPayoutDrafts(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job._id, assignedKey, job.pay?.adminPay]);

  async function handlePreview() {
    setRankingError("");
    setBusy(true);
    try {
      const result = await getCandidates(job._id);
      setRanking(result);
    } catch (err) {
      setRankingError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // After a save inside FortnightModal, show the just-saved data right away
  // (openCandidate is a snapshot from the ranking/excluded list, so it won't
  // reflect the edit on its own), then re-run the whole preview - a
  // corrected day can change whether this or another worker gets excluded,
  // so the ranking/excluded lists themselves need refreshing, not just this
  // one row.
  function handleCandidateAvailabilitySaved(updated) {
    setOpenCandidate(updated);
    handlePreview();
  }

  async function handleAutoAssign() {
    setBusy(true);
    setRankingError("");
    setCalendarStatus(null);
    try {
      const result = await assignJob(job._id);
      setRanking(null);
      setCalendarStatus(result.calendarEvent);
      const names = (result.assignedThisTime || []).map((w) => w.name).join(", ");
      showToast(names ? `Assigned ${names} to "${job.title}"` : `Team assigned to "${job.title}"`, "success");
      onChange();
    } catch (err) {
      setRankingError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignTo(workerId) {
    const workerName = ranking?.ranking.find((r) => r.workerId === workerId)?.name || "Worker";
    setBusy(true);
    setCalendarStatus(null);
    try {
      const result = await assignJobTo(job._id, workerId);
      setRanking(null);
      setCalendarStatus(result.calendarEvent);
      showToast(`${workerName} added to "${job.title}"`, "success");
      onChange();
    } catch (err) {
      setRankingError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleDraftChange(workerId, value) {
    setPayoutDrafts((prev) => ({ ...prev, [workerId]: value }));
  }

  // Replaces the old auto-save-on-blur behaviour: nothing is sent to the
  // server just from typing into a payout box anymore. Clicking ASSIGN
  // commits every payout that's actually changed (in one go, for however
  // many workers are on the team) and is also the moment the Google
  // Calendar invite actually goes out - see services/googleCalendar.js:
  // nothing is sent until every assigned worker's payout is set, so this is
  // worth surfacing right here as the one deliberate action that finalizes
  // it, rather than it firing the instant a payout field loses focus.
  async function handleAssignPayouts() {
    setBusy(true);
    setRankingError("");
    setCalendarStatus(null);
    try {
      let lastResult = null;
      let changed = false;
      for (const a of assignedWorkers) {
        const workerId = a.worker?._id || a.worker;
        const draftValue = payoutDrafts[workerId];
        const normalized = draftValue === "" || draftValue == null ? null : Number(draftValue);
        const current = a.payout ?? null;
        if (normalized === current) continue;
        changed = true;
        lastResult = await setWorkerPayout(job._id, workerId, normalized);
      }
      if (lastResult) {
        setCalendarStatus(lastResult.calendarEvent);
        showToast(`Payout${changed ? "s" : ""} assigned for "${job.title}"`, "success");
      } else if (!changed) {
        setRankingError("No payout changes to assign - edit a worker's payout first.");
      }
      onChange();
    } catch (err) {
      setRankingError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveWorker(workerId) {
    const workerName = assignedWorkers.find((a) => String(a.worker?._id || a.worker) === String(workerId))?.worker?.name || "Worker";
    setBusy(true);
    try {
      await unassignWorkerFromJob(job._id, workerId);
      showToast(`${workerName} removed from "${job.title}"`, "success");
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function handleUnassignAll() {
    setBusy(true);
    try {
      await unassignJob(job._id);
      showToast(`Team unassigned from "${job.title}"`, "success");
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    setBusy(true);
    try {
      await completeJob(job._id);
      showToast(`"${job.title}" marked complete`, "success");
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete job "${job.title}"?`)) return;
    setBusy(true);
    try {
      await deleteJob(job._id);
      showToast(`"${job.title}" deleted`, "success");
      onChange();
    } finally {
      setBusy(false);
    }
  }

  // Toggles the `archived` flag by hand at any age - see the Job model's
  // comment on `archived` for how a job also gets archived automatically
  // once it's 6 months old. Doesn't touch status/assignment/calendar;
  // archiving only hides a job from the normal Jobs list (see Jobs.jsx's
  // "View" filter).
  async function handleToggleArchive() {
    setBusy(true);
    try {
      if (job.archived) {
        await unarchiveJob(job._id);
        showToast(`"${job.title}" unarchived`, "success");
      } else {
        await archiveJob(job._id);
        showToast(`"${job.title}" archived`, "success");
      }
      onChange();
    } finally {
      setBusy(false);
    }
  }

  // Reuses the exact same form Home.jsx uses to create a job - see
  // JobDraftForm's isEdit flag, which just changes a couple of labels.
  // Available regardless of job status: a scraped or manually-entered
  // detail (address, duration, price, etc.) can turn out wrong after the
  // job's already been assigned or even completed, and there's no reason
  // to block fixing it.
  async function handleSaveEdit(form) {
    const updated = await updateJob(job._id, form);
    showToast(`"${updated.title}" updated`, "success");
    setEditing(false);
    onChange();
  }

  const adminPay = job.pay?.adminPay ?? null;
  const afterGst = job.pay?.afterGst ?? null;
  const totalPayout = assignedWorkers.reduce((sum, a) => sum + (Number(a.payout) || 0), 0);
  // Profit is what the business actually keeps: the post-GST amount minus
  // whatever workers are actually paid (see services/pay.js - adminPay
  // itself, despite its name, is the PROPOSED worker payout shown in the
  // UI above, not the business's own cut - the business's real, guaranteed
  // margin is the other, complementary slice of afterGst: afterGst -
  // adminPay, e.g. $9.00 - $6.75 = $2.25 on a $10 job).
  //
  // Until every currently-assigned worker's payout is actually SAVED (by
  // clicking ASSIGN) there's no real "what workers are actually paid"
  // number yet - including when nobody's even assigned at all - so profit
  // is shown as an ESTIMATE using the full proposed payout (adminPay) as a
  // stand-in for that, which collapses to exactly that guaranteed baseline
  // margin above. The moment every assigned worker has a real, saved
  // payout, profit switches over to the ACTUAL figure - paying a worker
  // less than the proposed amount adds straight to profit; paying more
  // eats into it (see the "(estimated ...)" note next to this line below).
  const settled = assignedWorkers.length > 0 && assignedWorkers.every((a) => a.payout != null);
  const effectivePayout = settled ? totalPayout : adminPay;
  const profit = afterGst != null ? afterGst - effectivePayout : null;
  // This job's own currency - AUD for every Australian work area, NZD for
  // Auckland (see utils/workAreas.js). Every dollar figure below is for
  // THIS one job, so there's no cross-currency summing risk here (unlike
  // JobsChart.jsx, which aggregates across many jobs and has to keep
  // currencies separate) - just a display label.
  const currency = currencyForWorkArea(job.workArea);
  const currencySymbol = CURRENCY_SYMBOL[currency] || "$";
  // No calendar invite goes out until EVERY assigned worker has a payout
  // entered (see services/googleCalendar.js) - shown here as a persistent
  // note (not just the transient banner right after an action) so it's
  // still clear after a page reload why there's no "View Google Calendar
  // event" link yet.
  const calendarPending =
    assignedWorkers.length > 0 &&
    (job.googleCalendar?.events?.length ?? 0) === 0 &&
    !assignedWorkers.every((a) => a.payout != null);

  return (
    <div id={`job-${job._id}`} className={`card job-card${highlighted ? " job-card-highlighted" : ""}`}>
      <div className="job-card-header">
        <div>
          <h3>{formatAssignedTitle(job.title, assignedWorkers.map((a) => a.worker?.name), job.customer)}</h3>
          <p className="muted small">
            {job.location || "No location"} &middot; difficulty {job.difficulty} &middot; priority {job.priority}
            {job.workArea && (
              <span className="area-tag">
                <span className="area-dot" style={{ background: WORK_AREA_SWATCH[job.workArea] }} />
                {job.workArea}
              </span>
            )}
          </p>
        </div>
        <div className="job-card-header-pills">
          {job.archived && <span className="pill pill-gray">Archived</span>}
          <span className={`pill ${STATUS_CLASS[job.status]}`}>{job.status}</span>
        </div>
      </div>

      <JobDescriptionView description={job.description} />

      <p className="muted small">
        {formatDateTime(job.scheduledStart, job.workArea)
          ? `Scheduled: ${formatDateTime(job.scheduledStart, job.workArea)} (${job.durationMinutes || 60} min)`
          : "No scheduled time set"}
        {job.customer?.name && ` · Customer: ${job.customer.name}${job.customer.phone ? ` (${job.customer.phone})` : ""}`}
      </p>

      {job.status !== "Completed" && (
        <p className="muted small">
          Team: {assignedWorkers.length}/{needed} worker{needed === 1 ? "" : "s"} assigned
          {!teamFull && ` - needs ${needed - assignedWorkers.length} more`}
          {needed > 1 && (
            <span className="muted small">
              {" "}
              (this job {job.durationMinutes > 180 ? "is over 3 hours" : "has a payout over $500"})
            </span>
          )}
        </p>
      )}

      {assignedWorkers.length > 0 && (
        <div className="assigned-team">
          {assignedWorkers.map((a) => {
            const workerId = a.worker?._id || a.worker;
            return (
              <AssignedWorkerRow
                key={workerId}
                assignment={a}
                value={payoutDrafts[workerId] ?? ""}
                disabled={job.status === "Completed" || busy}
                onDraftChange={handleDraftChange}
                onRemove={handleRemoveWorker}
                currencySymbol={currencySymbol}
              />
            );
          })}
          {job.status !== "Completed" && (
            <button className="btn btn-small btn-primary" onClick={handleAssignPayouts} disabled={busy}>
              ASSIGN
            </button>
          )}
        </div>
      )}

      {job.chargesTotal != null && (
        <div className="pay-block">
          <p className="pay-line">
            IKEA payout <strong>{money(job.chargesTotal, currency)}</strong>
            {adminPay != null && (
              <>
                {" "}
                &middot; less {Math.round((job.pay.gstRate ?? 0.1) * 100)}% GST = {money(job.pay.afterGst, currency)}{" "}
                &middot; proposed worker payout <strong className="pay-amount">{money(adminPay, currency)}</strong>
              </>
            )}
          </p>
          {assignedWorkers.length > 0 && (
            <p className="pay-line">
              Worker payout:{" "}
              {assignedWorkers
                .map((a) => `${a.worker?.name || "?"} ${a.payout != null ? money(a.payout, currency) : "-"}`)
                .join(", ")}
              {assignedWorkers.length > 1 && ` (total ${money(totalPayout, currency)})`}
            </p>
          )}
          {adminPay != null && (
            <p className={`pay-line profit-line ${profit >= 0 ? "profit-positive" : "profit-negative"}`}>
              Profit <strong>{money(profit, currency)}</strong>
              {!settled && (
                <span className="muted small"> (estimated - using the proposed worker payout until it's confirmed)</span>
              )}
            </p>
          )}
        </div>
      )}

      {calendarPending && (
        <p className="muted small pending-note">
          Calendar invite pending - enter a payout for every assigned worker and click ASSIGN to send it.
        </p>
      )}

      {job.googleCalendar?.events?.length > 0 && (
        <p className="muted small">
          {job.googleCalendar.events.map((ev, i) => {
            // A personal event (workerId set) invites just one worker -
            // label its link with their name so it's clear these are
            // separate, personalized invites (see services/googleCalendar.js).
            const worker = ev.workerId
              ? assignedWorkers.find((a) => String(a.worker?._id || a.worker) === String(ev.workerId))?.worker
              : null;
            return (
              <span key={ev.eventId || i}>
                {i > 0 && " · "}
                <a href={ev.htmlLink} target="_blank" rel="noreferrer">
                  {worker ? `View calendar invite (${worker.name})` : "View Google Calendar event"}
                </a>
              </span>
            );
          })}
        </p>
      )}

      {calendarStatus && (
        <div className={`banner ${calendarStatus.created ? "banner-warning" : "banner-error"}`}>
          {calendarStatus.created
            ? calendarStatus.personalized
              ? `Sent ${calendarStatus.count} personal calendar invite${calendarStatus.count === 1 ? "" : "s"} (payouts differ, so each worker only sees their own pay)${calendarStatus.reason ? ` - ${calendarStatus.reason}` : ""}.`
              : `Added to Google Calendar${calendarStatus.usedDefaultTime ? " (no scheduled time was set, so a default 1-hour slot starting next hour was used)" : ""}.`
            : `Not added to Google Calendar: ${calendarStatus.reason}`}
        </div>
      )}

      {job.sourceUrl && (
        <p className="muted small">
          <a href={job.sourceUrl} target="_blank" rel="noreferrer">
            View source link
          </a>
        </p>
      )}

      <div className="job-actions">
        {job.status !== "Completed" && (
          <button className="btn btn-small" onClick={handlePreview} disabled={busy}>
            Preview candidates
          </button>
        )}
        {job.status !== "Completed" && !teamFull && (
          <button className="btn btn-small btn-primary" onClick={handleAutoAssign} disabled={busy}>
            Auto-assign {assignedWorkers.length > 0 ? "remaining worker(s)" : "best worker(s)"}
          </button>
        )}
        {job.status === "Assigned" && (
          <>
            <button className="btn btn-small" onClick={handleComplete} disabled={busy}>
              Mark complete
            </button>
            <button className="btn btn-small btn-danger" onClick={handleUnassignAll} disabled={busy}>
              Unassign all
            </button>
          </>
        )}
        <button className="btn btn-small" onClick={() => setEditing(true)} disabled={busy}>
          Edit
        </button>
        <button className="btn btn-small" onClick={handleToggleArchive} disabled={busy}>
          {job.archived ? "Unarchive" : "Archive"}
        </button>
        <button className="btn btn-small btn-danger" onClick={handleDelete} disabled={busy}>
          Delete
        </button>
      </div>

      {rankingError && <div className="banner banner-error">{rankingError}</div>}

      {ranking && (
        <div className="ranking">
          {ranking.pool === "all workers are at capacity" && (
            <div className="banner banner-warning">
              Every worker is already at their concurrent-job limit - ranking shown anyway as a fallback.
            </div>
          )}
          {ranking.ranking.length === 0 ? (
            <p className="muted small">No available workers to rank.</p>
          ) : (
            <div className="table-scroll">
            <table className="ranking-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Availability</th>
                  <th>Score</th>
                  <th>Skill</th>
                  <th>Location</th>
                  <th>Load</th>
                  <th>Priority</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ranking.ranking.map((r, i) => (
                  <tr key={r.workerId} className={i === 0 ? "top-candidate" : ""}>
                    <td>{r.name}</td>
                    <td>
                      <FortnightCell worker={r} onOpen={setOpenCandidate} />
                    </td>
                    <ScoreCell raw={r.total} kind="total" tooltip={`Raw total score: ${r.total}`} />
                    <ScoreCell
                      raw={r.breakdown.skill.score}
                      kind="skill"
                      tooltip={`Raw score: ${r.breakdown.skill.score} - gap vs job difficulty: ${r.breakdown.skill.gap}`}
                    />
                    <ScoreCell
                      raw={r.breakdown.location.score}
                      kind="location"
                      tooltip={`Raw score: ${r.breakdown.location.score}`}
                      sub={
                        r.breakdown.location.distanceKm != null
                          ? `${r.breakdown.location.distanceKm}km away`
                          : "text match only"
                      }
                    />
                    <ScoreCell
                      raw={r.breakdown.load.score}
                      kind="load"
                      tooltip={`Raw score: ${r.breakdown.load.score}`}
                      sub={`${r.breakdown.load.activeCount} active job${r.breakdown.load.activeCount === 1 ? "" : "s"}${
                        r.breakdown.load.atCapacity ? " (at capacity)" : ""
                      }`}
                    />
                    <ScoreCell
                      raw={r.breakdown.priorityBonus}
                      kind="priority"
                      tooltip={`Raw score: ${r.breakdown.priorityBonus} - worker priority: ${r.priority}`}
                    />
                    <td>
                      {job.status !== "Completed" && (
                        <button
                          className="btn btn-tiny"
                          onClick={() => handleAssignTo(r.workerId)}
                          disabled={busy}
                        >
                          Add to team
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {ranking.excluded.length > 0 && (
            <div className="excluded-list">
              <p className="muted small excluded-list-title">
                Excluded ({ranking.excluded.length})
              </p>
              <ul className="excluded-list-items">
                {ranking.excluded.map((e) => (
                  <li key={e.workerId}>
                    <span className="excluded-list-name">{e.name}</span>
                    <span className="excluded-list-reason">{e.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <FortnightModal worker={openCandidate} onClose={() => setOpenCandidate(null)} onSaved={handleCandidateAvailabilitySaved} />
      {editing && (
        <div className="form-modal-backdrop" onClick={() => setEditing(false)}>
          <div className="form-modal-panel" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="form-modal-close" onClick={() => setEditing(false)} aria-label="Close">
              &times;
            </button>
            <JobDraftForm draft={job} onSave={handleSaveEdit} onDiscard={() => setEditing(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
