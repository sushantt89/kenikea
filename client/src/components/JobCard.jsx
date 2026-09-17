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
} from "../api.js";
import { normalizeScore, scoreColor } from "../utils/scoreScale.js";
import { requiredWorkerCount } from "../utils/team.js";
import { WORK_AREA_SWATCH, timezoneForWorkArea } from "../utils/workAreas.js";
import { formatInZone } from "../utils/timezone.js";

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

function money(n) {
  return `$${Number(n).toFixed(2)}`;
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

// One assigned worker's row: name/location, an editable payout amount
// (saved on blur/Enter rather than on every keystroke), and a Remove
// button. Kept as its own component so each row has its own local draft
// value while typing.
function AssignedWorkerRow({ assignment, disabled, onSavePayout, onRemove }) {
  const worker = assignment.worker || {};
  const [draft, setDraft] = useState(assignment.payout ?? "");
  const [saving, setSaving] = useState(false);

  // Keep the input in sync if the payout changes from outside this row
  // (e.g. a refetch after some other edit) rather than only ever reading
  // the initial value.
  useEffect(() => {
    setDraft(assignment.payout ?? "");
  }, [assignment.payout]);

  async function commit() {
    const value = draft === "" ? null : Number(draft);
    if (value === (assignment.payout ?? null)) return;
    setSaving(true);
    try {
      await onSavePayout(worker._id, value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="assigned-worker-row">
      <span className="assigned-worker-name">
        <strong>{worker.name || "Unknown worker"}</strong>
        {worker.location && <span className="muted small"> ({worker.location})</span>}
      </span>
      <label className="payout-input">
        <span className="muted small">Payout $</span>
        <input
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          value={draft}
          disabled={disabled || saving}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
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

export default function JobCard({ job, onChange }) {
  const [ranking, setRanking] = useState(null);
  const [rankingError, setRankingError] = useState("");
  const [calendarStatus, setCalendarStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const assignedWorkers = job.assignedWorkers || [];
  const needed = requiredWorkerCount(job);
  const teamFull = assignedWorkers.length >= needed;

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

  async function handleAutoAssign() {
    setBusy(true);
    setRankingError("");
    setCalendarStatus(null);
    try {
      const result = await assignJob(job._id);
      setRanking(null);
      setCalendarStatus(result.calendarEvent);
      onChange();
    } catch (err) {
      setRankingError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignTo(workerId) {
    setBusy(true);
    setCalendarStatus(null);
    try {
      const result = await assignJobTo(job._id, workerId);
      setRanking(null);
      setCalendarStatus(result.calendarEvent);
      onChange();
    } catch (err) {
      setRankingError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSavePayout(workerId, payout) {
    try {
      // Entering a payout is often the moment the calendar invite actually
      // goes out - see services/googleCalendar.js: nothing is sent until
      // every assigned worker's payout is set, so this is worth surfacing
      // right here rather than only on the original assign action.
      const result = await setWorkerPayout(job._id, workerId, payout);
      setCalendarStatus(result.calendarEvent);
      onChange();
    } catch (err) {
      setRankingError(err.message);
    }
  }

  async function handleRemoveWorker(workerId) {
    setBusy(true);
    try {
      await unassignWorkerFromJob(job._id, workerId);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function handleUnassignAll() {
    setBusy(true);
    try {
      await unassignJob(job._id);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    setBusy(true);
    try {
      await completeJob(job._id);
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
      onChange();
    } finally {
      setBusy(false);
    }
  }

  const adminPay = job.pay?.adminPay ?? null;
  const totalPayout = assignedWorkers.reduce((sum, a) => sum + (Number(a.payout) || 0), 0);
  const anyPayoutSet = assignedWorkers.some((a) => a.payout != null);
  const profit = adminPay != null ? adminPay - totalPayout : null;
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
    <div className="card job-card">
      <div className="job-card-header">
        <div>
          <h3>{job.title}</h3>
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
        <span className={`pill ${STATUS_CLASS[job.status]}`}>{job.status}</span>
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
          {assignedWorkers.map((a) => (
            <AssignedWorkerRow
              key={a.worker?._id || a.worker}
              assignment={a}
              disabled={job.status === "Completed" || busy}
              onSavePayout={handleSavePayout}
              onRemove={handleRemoveWorker}
            />
          ))}
        </div>
      )}

      {job.chargesTotal != null && (
        <div className="pay-block">
          <p className="pay-line">
            IKEA payout <strong>{money(job.chargesTotal)}</strong>
            {adminPay != null && (
              <>
                {" "}
                &middot; less {Math.round((job.pay.gstRate ?? 0.1) * 100)}% GST = {money(job.pay.afterGst)}{" "}
                &middot; admin pay <strong className="pay-amount">{money(adminPay)}</strong>
              </>
            )}
          </p>
          {assignedWorkers.length > 0 && (
            <p className="pay-line">
              Worker payout:{" "}
              {assignedWorkers
                .map((a) => `${a.worker?.name || "?"} ${a.payout != null ? money(a.payout) : "-"}`)
                .join(", ")}
              {assignedWorkers.length > 1 && ` (total ${money(totalPayout)})`}
            </p>
          )}
          {adminPay != null && (
            <p className={`pay-line profit-line ${profit >= 0 ? "profit-positive" : "profit-negative"}`}>
              Profit <strong>{money(profit)}</strong>
              {!anyPayoutSet && <span className="muted small"> (worker payout not entered yet)</span>}
            </p>
          )}
        </div>
      )}

      {calendarPending && (
        <p className="muted small pending-note">
          Calendar invite pending - enter a payout for every assigned worker to send it.
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

      <p className="muted small">
        <a href={job.sourceUrl} target="_blank" rel="noreferrer">
          View source link
        </a>
      </p>

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
            <p className="muted small">
              Excluded: {ranking.excluded.map((e) => `${e.name} (${e.reason})`).join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
