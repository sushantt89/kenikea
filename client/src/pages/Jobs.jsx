import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import * as XLSX from "xlsx";
import JobCard from "../components/JobCard.jsx";
import JobsChart from "../components/JobsChart.jsx";
import { getJobs, getWorkers } from "../api.js";
import { useToast } from "../toast/ToastContext.jsx";
import { WORK_AREAS, timezoneForWorkArea, countryForWorkArea, currencyForWorkArea } from "../utils/workAreas.js";
import { formatInZone } from "../utils/timezone.js";
import { splitJobTitle } from "../utils/jobTitle.js";

const PERIODS = [
  { value: "all", label: "All time" },
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

const STATUSES = ["Unassigned", "Assigned", "Completed"];

// Coarser than the Work area filter below - lets you see "all of
// Australia" (Adelaide + Perth + Brisbane + NSW) as one bucket against
// Auckland/New Zealand, which the per-area filter alone can't do (picking
// one Australian area at a time excludes the other three). See
// utils/workAreas.js's countryForWorkArea() - derived from WORK_AREAS so
// this never drifts out of sync with it.
const COUNTRIES = [...new Set(WORK_AREAS.map(countryForWorkArea))];

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

// [start, end) for a hand-picked "Custom range" (see the two date inputs
// shown once Period is set to "custom"). `startStr`/`endStr` are plain
// "YYYY-MM-DD" strings straight from a native <input type="date">, parsed
// as LOCAL midnight (not UTC) so the range lines up with jobDate()'s own
// local-time comparisons. `end` is inclusive of the whole day picked, so
// choosing the same day for both bounds shows just that one day - that's
// why it's pushed forward one calendar day before being used as the
// exclusive upper bound, same convention as periodRange() above. Leaving
// either box blank leaves that side of the range open (any date up to /
// from the other one that IS set); leaving both blank means no filtering
// at all yet, same as period "all".
function customRange(startStr, endStr) {
  if (!startStr && !endStr) return null;

  const start = startStr ? new Date(`${startStr}T00:00:00`) : new Date(0);
  const end = endStr ? new Date(`${endStr}T00:00:00`) : new Date(8640000000000000);
  if (endStr) end.setDate(end.getDate() + 1);
  return [start, end];
}

// One lowercased blob of everything a user might plausibly search a job
// by - the job's title (which already includes its IKEA "Job 123456" id,
// see scraper.js), its own Mongo id (in case that gets pasted instead),
// location, work area, status, description, customer details, and any
// assigned workers' names. Built fresh per job on each search rather than
// memoized per-job - the job lists here are small enough (an admin tool's
// worth of jobs, not a consumer-scale table) that this is unmeasurable.
function jobSearchText(job) {
  const assignedNames = (job.assignedWorkers || []).map((a) => a.worker?.name).filter(Boolean);
  return [
    job.title,
    job._id,
    job.location,
    job.workArea,
    job.status,
    job.description,
    job.customer?.name,
    job.customer?.phone,
    job.customer?.email,
    ...assignedNames,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatForExport(job) {
  const assignedWorkers = job.assignedWorkers || [];
  const totalPayout = assignedWorkers.reduce((sum, a) => sum + (Number(a.payout) || 0), 0);
  const adminPay = job.pay?.adminPay ?? null;
  const afterGst = job.pay?.afterGst ?? null;
  // Same "estimate until every assigned worker's payout is actually saved"
  // rule as the on-screen Profit line in JobCard.jsx - see its own comment
  // for the full rationale. Kept in sync by hand since this export builds
  // its own row object rather than reusing JobCard's JSX.
  const settled = assignedWorkers.length > 0 && assignedWorkers.every((a) => a.payout != null);
  const effectivePayout = settled ? totalPayout : adminPay;
  // Pulled back out of the stored title - see utils/jobTitle.js. Blank for
  // a manually-created job that was never scraped from a Beehiive link.
  const { jobId } = splitJobTitle(job.title);
  return {
    "Scheduled start": job.scheduledStart
      ? formatInZone(job.scheduledStart, timezoneForWorkArea(job.workArea))
      : "",
    "Job ID": jobId || "",
    Status: job.status,
    "Assigned worker(s)": assignedWorkers.map((a) => a.worker?.name).filter(Boolean).join(", "),
    "Work area": job.workArea || "",
    // The job's own currency (AUD for every Australian area, NZD for
    // Auckland - see utils/workAreas.js) - included so the money columns
    // below aren't ambiguous once an export mixes jobs from both
    // countries; every number in a given row is in THIS currency.
    Currency: currencyForWorkArea(job.workArea),
    Location: job.location || "",
    Priority: job.priority,
    Difficulty: job.difficulty,
    "Duration (min)": job.durationMinutes ?? "",
    "IKEA payout ($)": job.chargesTotal ?? "",
    "Proposed worker payout ($)": adminPay ?? "",
    "Worker payout total ($)": assignedWorkers.length ? totalPayout : "",
    "Profit ($)": afterGst != null && effectivePayout != null ? afterGst - effectivePayout : "",
    "Customer name": job.customer?.name || "",
    "Customer phone": job.customer?.phone || "",
    "Customer email": job.customer?.email || "",
  };
}

export default function Jobs() {
  const { showToast } = useToast();
  const [jobs, setJobs] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("all");
  // Only used while period === "custom" - see customRange() above.
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [workerFilter, setWorkerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [workAreaFilter, setWorkAreaFilter] = useState("all");
  const [countryFilter, setCountryFilter] = useState("all");
  // "active" (default) hides archived jobs from every other view; "archived"
  // shows ONLY archived jobs, on their own - see the Job model's `archived`
  // field for how a job gets into that state (auto after 6 months, or by
  // hand via the Archive button on its card).
  const [archivedFilter, setArchivedFilter] = useState("active");

  // Set when this page was opened from a notification bell click (see
  // components/NotificationBell.jsx), e.g. "/jobs?focus=<jobId>" - that one
  // job is always shown regardless of every other filter above (see
  // filteredJobs below) and gets scrolled into view + a highlight outline
  // (see the "job-card-highlighted" class). Kept in its own piece of state
  // (rather than just reading searchParams directly wherever it's needed)
  // so it survives the "focus" param being stripped back out of the URL
  // right below - done purely so the URL bar itself looks clean/shareable,
  // and a later reload of the same URL doesn't re-focus forever. Watching
  // searchParams itself (not a one-time-on-mount read) is what lets a
  // SECOND notification click work correctly even while already sitting on
  // this page - Jobs.jsx doesn't remount just because the query string
  // changed, so a one-time read would miss it.
  const [searchParams, setSearchParams] = useSearchParams();
  const [focusJobId, setFocusJobId] = useState(() => searchParams.get("focus"));

  useEffect(() => {
    const focus = searchParams.get("focus");
    if (!focus) return;
    setFocusJobId(focus);
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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
    const range = period === "custom" ? customRange(customStart, customEnd) : periodRange(period);
    const query = search.trim().toLowerCase();
    return jobs.filter((job) => {
      // A job opened via a notification bell click always shows, no matter
      // what the filters above are currently set to - see focusJobId above.
      if (focusJobId && job._id === focusJobId) return true;
      if (query && !jobSearchText(job).includes(query)) return false;
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
      if (countryFilter !== "all" && countryForWorkArea(job.workArea) !== countryFilter) return false;
      // "all" shows both active and archived jobs together - "active" and
      // "archived" each show only their own.
      if (archivedFilter === "archived") {
        if (!job.archived) return false;
      } else if (archivedFilter === "active") {
        if (job.archived) return false;
      }
      return true;
    });
  }, [
    jobs,
    period,
    customStart,
    customEnd,
    workerFilter,
    statusFilter,
    workAreaFilter,
    countryFilter,
    archivedFilter,
    focusJobId,
    search,
  ]);

  // Scrolls the focused job's card into view once it's actually in the
  // (post-filter) list and rendered - see focusJobId above.
  useEffect(() => {
    if (!focusJobId) return;
    const el = document.getElementById(`job-${focusJobId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusJobId, filteredJobs]);

  function handleExport() {
    const rows = filteredJobs.map(formatForExport);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `jobs-export-${stamp}.xlsx`);
    showToast(`Exported ${rows.length} job${rows.length === 1 ? "" : "s"}`, "success");
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Jobs</h1>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="card jobs-search-card">
        <input
          type="search"
          className="jobs-search-input"
          placeholder="Search by job, customer, worker, location..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

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
        {period === "custom" && (
          <>
            <label>
              From
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
            </label>
            <label>
              To
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            </label>
          </>
        )}
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
        <label>
          Country
          <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
            <option value="all">All countries</option>
            {COUNTRIES.map((country) => (
              <option key={country} value={country}>
                {country}
              </option>
            ))}
          </select>
        </label>
        <label>
          View
          <select value={archivedFilter} onChange={(e) => setArchivedFilter(e.target.value)}>
            <option value="active">Active jobs</option>
            <option value="archived">Archived jobs only</option>
            <option value="all">All jobs (active + archived)</option>
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
                <JobCard key={job._id} job={job} onChange={loadAll} highlighted={job._id === focusJobId} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
