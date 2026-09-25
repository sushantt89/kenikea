import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import WorkerForm from "../components/WorkerForm.jsx";
import WorkerTable from "../components/WorkerTable.jsx";
import {
  getWorkers,
  createWorker,
  updateWorker,
  deleteWorker,
  syncWorkerAvailability,
  getRolloutStatus,
  updateRolloutFormUrl,
  rollOutForm,
} from "../api.js";
import { useToast } from "../toast/ToastContext.jsx";

// "in 5 days" / "today" / "overdue by 3 days" / null if never rolled out
// yet - the fortnight is always exactly 14 days from the last roll-out, see
// server/src/routes/workers.js's POST /roll-out.
function daysUntilNextRollout(lastRolledOutAt) {
  if (!lastRolledOutAt) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSince = Math.floor((Date.now() - new Date(lastRolledOutAt).getTime()) / msPerDay);
  return 14 - daysSince;
}

export default function Workers() {
  const { showToast } = useToast();
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Set when this page was opened from a notification bell click (see
  // components/NotificationBell.jsx), e.g. "/workers?focus=<workerId>" -
  // same "focus" pattern as pages/Jobs.jsx (see its own comment for the
  // full rationale). WorkerTable uses this to scroll to and highlight that
  // one worker's row and pop their availability modal straight open.
  const [searchParams, setSearchParams] = useSearchParams();
  const [focusWorkerId, setFocusWorkerId] = useState(() => searchParams.get("focus"));

  useEffect(() => {
    const focus = searchParams.get("focus");
    if (!focus) return;
    setFocusWorkerId(focus);
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null); // worker being edited, or null for "add"
  const [showForm, setShowForm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const [rollout, setRollout] = useState(null); // { formUrl, lastRolledOutAt } once loaded
  const [formUrlDraft, setFormUrlDraft] = useState("");
  const [savingLink, setSavingLink] = useState(false);
  const [rollingOut, setRollingOut] = useState(false);
  const [rollOutResult, setRollOutResult] = useState(null);

  // Same fix as Jobs.jsx's loadAll() - see the comment there. Without
  // hasLoadedOnce, editing/adding/deleting a worker while scrolled down
  // the list would flip `loading` back to true, unmount the whole
  // WorkerTable to show "Loading workers..." again, then remount it -
  // which resets scroll to the top of the page every time.
  const hasLoadedOnce = useRef(false);

  async function load() {
    if (!hasLoadedOnce.current) setLoading(true);
    setError("");
    try {
      setWorkers(await getWorkers());
      hasLoadedOnce.current = true;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadRollout() {
    try {
      const status = await getRolloutStatus();
      setRollout(status);
      setFormUrlDraft(status.formUrl || "");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    loadRollout();
  }, []);

  async function handleSubmit(data) {
    if (editing) {
      await updateWorker(editing._id, data);
      showToast(`${data.name} updated`, "success");
    } else {
      await createWorker(data);
      showToast(`${data.name} added`, "success");
    }
    setShowForm(false);
    setEditing(null);
    await load();
  }

  async function handleDelete(worker) {
    if (!window.confirm(`Delete ${worker.name}? Any jobs assigned to them will become unassigned.`)) {
      return;
    }
    try {
      await deleteWorker(worker._id);
      showToast(`${worker.name} deleted`, "success");
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  // Pulls the latest fortnightly Google Form responses into every matching
  // worker's record (see services/availabilitySync.js on the server) -
  // safe to click any time, e.g. after workers submit a new round of
  // answers. Shows a plain "not configured" message rather than an error
  // if the Google Sheets side hasn't been set up yet (see README).
  async function handleSyncAvailability() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await syncWorkerAvailability();
      setSyncResult(result);
      if (result.synced) {
        showToast(`Synced availability for ${result.updatedWorkers} worker${result.updatedWorkers === 1 ? "" : "s"}`, "success");
        await load();
      }
    } catch (err) {
      setSyncResult({ synced: false, reason: err.message });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveFormUrl() {
    setSavingLink(true);
    try {
      const status = await updateRolloutFormUrl(formUrlDraft.trim());
      setRollout(status);
      showToast("Form link saved", "success");
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingLink(false);
    }
  }

  // Emails every worker with an email the current form link and records
  // "rolled out just now" - see POST /api/workers/roll-out. Requires the
  // form link to be saved first (the button below is disabled otherwise).
  async function handleRollOut() {
    // If the current fortnight was already rolled out and isn't due again
    // yet, don't let a stray second click quietly re-email everyone with
    // no warning - ask specifically, naming when it was last sent and how
    // many days are actually left, instead of the generic confirm text.
    const daysLeft = rollout?.lastRolledOutAt ? daysUntilNextRollout(rollout.lastRolledOutAt) : null;
    const alreadySentThisFortnight = daysLeft != null && daysLeft > 0;
    const confirmMessage = alreadySentThisFortnight
      ? `You already rolled out the form on ${new Date(rollout.lastRolledOutAt).toLocaleDateString()} - the next fortnight isn't due for ${daysLeft} more day${daysLeft === 1 ? "" : "s"}. Send it again to all workers anyway?`
      : "This will create the next fortnight's form (if automatic creation is set up) and email every worker its link now. Continue?";
    if (!window.confirm(confirmMessage)) return;

    setRollingOut(true);
    setRollOutResult(null);
    try {
      const result = await rollOutForm();
      setRollOutResult(result);
      setRollout((r) => ({ ...r, lastRolledOutAt: result.lastRolledOutAt, formUrl: result.formUrl ?? r?.formUrl }));
      if (result.formUrl) setFormUrlDraft(result.formUrl);
      showToast(`Emailed ${result.sent} worker${result.sent === 1 ? "" : "s"} the fortnight form`, "success");
    } catch (err) {
      setRollOutResult({ error: err.message });
    } finally {
      setRollingOut(false);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Workers</h1>
        <div className="page-header-actions">
          <button className="btn btn-secondary" onClick={handleSyncAvailability} disabled={syncing}>
            {syncing ? "Syncing..." : "Sync fortnight availability"}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setEditing(null);
              setShowForm((s) => !s);
            }}
          >
            {showForm && !editing ? "Close" : "+ Add worker"}
          </button>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card rollout-card">
        <h2>Fortnight form rollout</h2>
        <p className="muted small">
          {rollout?.lastRolledOutAt ? (
            (() => {
              const daysLeft = daysUntilNextRollout(rollout.lastRolledOutAt);
              return (
                <>
                  Last rolled out {new Date(rollout.lastRolledOutAt).toLocaleString()}. Next fortnight{" "}
                  {daysLeft > 0
                    ? `due in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
                    : daysLeft === 0
                      ? "due today"
                      : `overdue by ${-daysLeft} day${-daysLeft === 1 ? "" : "s"}`}
                  .
                </>
              );
            })()
          ) : (
            "Never rolled out yet."
          )}
        </p>

        <div className="form-row">
          <label>
            Form link (only needed by hand if automatic form creation isn't set up - "Roll out" below
            creates the next fortnight's form itself otherwise, and fills this in automatically)
            <input
              type="url"
              placeholder="https://docs.google.com/forms/d/e/.../viewform"
              value={formUrlDraft}
              onChange={(e) => setFormUrlDraft(e.target.value)}
            />
          </label>
        </div>
        {rollout?.formUrl && (
          <p className="muted small">
            <a href={rollout.formUrl} target="_blank" rel="noreferrer">
              View current form
            </a>
          </p>
        )}

        <div className="form-actions">
          <button
            className="btn btn-secondary"
            onClick={handleSaveFormUrl}
            disabled={savingLink || formUrlDraft.trim() === (rollout?.formUrl || "")}
          >
            {savingLink ? "Saving..." : "Save link"}
          </button>
          <button className="btn btn-primary" onClick={handleRollOut} disabled={rollingOut}>
            {rollingOut ? "Rolling out..." : "Roll out to all workers"}
          </button>
        </div>

        {rollOutResult && (
          <div className={`banner ${rollOutResult.error ? "banner-error" : "banner-warning"}`}>
            {rollOutResult.error
              ? `Could not roll out: ${rollOutResult.error}`
              : `Emailed ${rollOutResult.sent} worker${rollOutResult.sent === 1 ? "" : "s"}.${
                  rollOutResult.failed?.length
                    ? ` ${rollOutResult.failed.length} failed: ${rollOutResult.failed
                        .map((f) => `${f.worker || f.email} (${f.reason})`)
                        .join(", ")}.`
                    : ""
                }`}
          </div>
        )}
      </div>

      {syncResult && (
        <div className={`banner ${syncResult.synced ? "banner-warning" : "banner-error"}`}>
          {syncResult.synced
            ? `Synced availability for ${syncResult.updatedWorkers} worker${syncResult.updatedWorkers === 1 ? "" : "s"} from the form.${
                syncResult.unmatchedEmails?.length
                  ? ` ${syncResult.unmatchedEmails.length} response email(s) didn't match a worker in this app: ${syncResult.unmatchedEmails.join(", ")}.`
                  : ""
              }`
            : `Could not sync availability: ${syncResult.reason}`}
        </div>
      )}

      {(showForm || editing) && (
        <div
          className="form-modal-backdrop"
          onClick={() => {
            setShowForm(false);
            setEditing(null);
          }}
        >
          <div className="form-modal-panel" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="form-modal-close"
              onClick={() => {
                setShowForm(false);
                setEditing(null);
              }}
              aria-label="Close"
            >
              &times;
            </button>
            <div className="card">
              <h2>{editing ? `Edit ${editing.name}` : "New worker"}</h2>
              <WorkerForm
                initial={editing}
                submitLabel={editing ? "Save changes" : "Add worker"}
                onSubmit={handleSubmit}
                onCancel={() => {
                  setShowForm(false);
                  setEditing(null);
                }}
              />
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p>Loading workers...</p>
      ) : (
        <WorkerTable
          workers={workers}
          onEdit={(w) => {
            setEditing(w);
            setShowForm(true);
          }}
          onDelete={handleDelete}
          onAvailabilityChange={load}
          highlightId={focusWorkerId}
        />
      )}
    </div>
  );
}
