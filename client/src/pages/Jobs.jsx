import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import JobCard from "../components/JobCard.jsx";
import JobsChart from "../components/JobsChart.jsx";
import { getJobs, getWorkers } from "../api.js";
import { WORK_AREAS, timezoneForWorkArea } from "../utils/workAreas.js";
import { formatInZone } from "../utils/timezone.js";

const PERIODS = [
  { value: "all", label: "All time" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const STATUSES = ["Unassigned", "Assigned", "Completed"];

// The date a job "happened" on, for filtering purposes - its scheduled time
// when known, otherwise falls back to when it was created (e.g. a job
// that's never had a time set yet still shows up under "today" once added).
function jobDate(job) {
  const raw = job.scheduledStart || job.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// [start, end) for the given preset, in local time. Week runs Mon-Sun.
function periodRange(period) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (period === "day") {
    const end = new Date(startOfDay);
    end.setDate(end.getDate() + 1);
    return [startOfDay, end];
  }

  if (period === "week") {
    const day = startOfDay.getDay(); // 0 (Sun) - 6 (Sat)
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(startOfDay);
    start.setDate(start.getDate() + mondayOffset);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return [start, end];
  }

  if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return [start, end];
  }

  return null; // "all" - no range
}

function formatForExport(job) {
  const date = jobDate(job);
  const assignedWorkers = job.assignedWorkers || [];
  const totalPayout = assignedWorkers.reduce((sum, a) => sum + (Number(a.payout) || 0), 0);
  const adminPay = job.pay?.adminPay ?? null;
  return {
    Title: job.title,
    Status: job.status,
    "Assigned worker(s)": assignedWorkers.map((a) => a.worker?.name).filter(Boolean).join(", "),
    "Work area": job.workArea || "",
    Location: job.location || "",
    Priority: job.priority,
    Difficulty: job.difficulty,
    "Scheduled start": job.scheduledStart
      ? formatInZone(job.scheduledStart, timezoneForWorkArea(job.workArea))
      : "",
    "Duration (min)": job.durationMinutes ?? "",
    "IKEA payout ($)": job.chargesTotal ?? "",
    "Admin pay ($)": adminPay ?? "",
    "Worker payout total ($)": assignedWorkers.length ? totalPayout : "",
    "Profit ($)": adminPay != null ? adminPay - totalPayout : "",
    "Customer name": job.customer?.name || "",
    "Customer phone": job.customer?.phone || "",
    "Customer email": job.customer?.email || "",
    "Sort date": date ? date.toISOString() : "",
  };
}

export default function Jobs() {
  const [jobs, setJobs] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [period, setPeriod] = useState("all");
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workAreaFilter, setWorkAreaFilter] = useState("all");

  // `loading` gates the very first render (a full-page "Loading jobs..."
  // placeholder while there's nothing to show yet). Every later reload -
  // e.g. the one JobCard triggers via onChange right after you save a
  // payout - reuses this same function, but must NOT flip `loading` back
  // to true: doing that used to unmount the whole job list (scroll
  // position included) just to briefly show that placeholder again before
  // re-rendering the fresh data. hasLoadedOnce tracks that distinction
  // with a ref (not state) since it doesn't need to trigger a render of
  // its own - once true, later loadAll() calls just swap in new data
  // without ever touching `loading`, so the list stays mounted and the
  // page doesn't jump back to the top.
  const hasLoadedOnce = useRef(false);

  async function loadAll() {
    if (!hasLoadedOnce.current) setLoading(true);
    setError("");
    try {
      const [jobsData, workersData] = await Promise.all([getJobs(), getWorkers()]);
      setJobs(jobsData);
      setWorkers(workersData);
      hasLoadedOnce.current = true;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const filteredJobs = useMemo(() => {
    const range = periodRange(period);
    return jobs.filter((job) => {
      if (range) {
        const d = jobDate(job);
        if (!d || d < range[0] || d >= range[1]) return false;
      }
      const assignedWorkers = job.assignedWorkers || [];
      if (workerFilter === "unassigned") {
        if (assignedWorkers.length > 0) return false;
      } else if (workerFilter !== "all") {
        if (!assignedWorkers.some((a) => (a.worker?._id || a.worker) === workerFilter)) return false;
      }
      if (statusFilter !== "all" && job.status !== statusFilter) return false;
      if (workAreaFilter === "none") {
        if (job.workArea) return false;
      } else if (workAreaFilter !== "all") {
        if (job.workArea !== workAreaFilter) return false;
      }
      return true;
    });
  }, [jobs, period, workerFilter, statusFilter, workAreaFilter]);

  function handleExport() {
    const rows = filteredJobs.map(formatForExport);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `jobs-export-${stamp}.xlsx`);
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Jobs</h1>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card filter-bar">
        <label>
          Period
          <select value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Worker
          <select value={workerFilter} onChange={(e) => setWorkerFilter(e.target.value)}>
            <option value="all">All workers</option>
            <option value="unassigned">Unassigned</option>
            {workers.map((w) => (
              <option key={w._id} value={w._id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Work area
          <select value={workAreaFilter} onChange={(e) => setWorkAreaFilter(e.target.value)}>
            <option value="all">All work areas</option>
            <option value="none">No work area set</option>
            {WORK_AREAS.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-bar-actions">
          <span className="muted small">
            {filteredJobs.length} of {jobs.length} job{jobs.length === 1 ? "" : "s"}
          </span>
          <button className="btn btn-secondary" onClick={handleExport} disabled={filteredJobs.length === 0}>
            Export as Excel
          </button>
        </div>
      </div>

      {loading ? (
        <p>Loading jobs...</p>
      ) : (
        <>
          <JobsChart jobs={filteredJobs} />

          {filteredJobs.length === 0 ? (
            <p className="empty-state">
              {jobs.length === 0
                ? "No jobs yet - paste a link on the Home tab to get started."
                : "No jobs match the current filters."}
            </p>
          ) : (
            <div className="job-list">
              {filteredJobs.map((job) => (
                <JobCard key={job._id} job={job} onChange={loadAll} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
