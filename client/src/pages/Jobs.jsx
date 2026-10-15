import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import * as XLSX from "xlsx";
import JobCard from "../components/JobCard.jsx";
import JobsChart from "../components/JobsChart.jsx";
import Pagination from "../components/Pagination.jsx";
import { getJobsPage, getJobsAll, getJobsOverview, getWorkerOptions } from "../api.js";
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

function formatForExport(job) {
  const assignedWorkers = job.assignedWorkers || [];
  const totalPayout = assignedWorkers.reduce((sum, a) => sum + (Number(a.payout) || 0), 0);
  const adminPay = job.pay?.adminPay ?? null;
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
    "Profit ($)": job.chargesTotal != null && effectivePayout != null ? job.chargesTotal - effectivePayout : "",
    "Customer name": job.customer?.name || "",
    "Customer phone": job.customer?.phone || "",
    "Customer email": job.customer?.email || "",
  };
}

export default function Jobs() {
  const { showToast } = useToast();
  // One page of (server-filtered) jobs at a time - see GET /api/jobs.
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasAnyJobs, setHasAnyJobs] = useState(true);
  // Light version of EVERY matching job, just for the overview totals.
  const [overviewJobs, setOverviewJobs] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Bumped to re-fetch the current page (e.g. after saving a payout).
  const [refreshTick, setRefreshTick] = useState(0);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
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
  const [pageSize, setPageSize] = useState(10);

  // Set when this page was opened from a notification bell click (see
  // components/NotificationBell.jsx), e.g. "/jobs?focus=<jobId>" - that one
  // job is always included regardless of every other filter above (the
  // server adds it to the results) and the page holding it is opened, then
  // it's scrolled into view + highlighted (see "job-card-highlighted").
  // Kept in its own piece of state so it survives the "focus" param being
  // stripped back out of the URL right below - done purely so the URL bar
  // looks clean/shareable and a later reload doesn't re-focus forever.
  // Watching searchParams itself (not a one-time-on-mount read) is what lets
  // a SECOND notification click work while already sitting on this page.
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

  // Wait for a pause in typing before asking the server to search.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Everything that changes WHICH jobs match. The page number belongs to one
  // such combination: change any filter (or the page size) and it's page 1
  // again.
  const filterKey = [
    debouncedSearch,
    period,
    customStart,
    customEnd,
    workerFilter,
    statusFilter,
    workAreaFilter,
    countryFilter,
    archivedFilter,
    pageSize,
  ].join("|");
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  function setPage(p) {
    setPageState({ key: filterKey, page: p });
  }

  // The filters as the server's query string. Dates are worked out here (in
  // the browser's local time) and sent as exact instants.
  function filterParams() {
    const range = period === "custom" ? customRange(customStart, customEnd) : periodRange(period);
    const params = {
      search: debouncedSearch,
      worker: workerFilter,
      status: statusFilter,
      workArea: workAreaFilter,
      country: countryFilter,
      archived: archivedFilter,
    };
    if (range) {
      if (range[0].getTime() > 0) params.dateFrom = range[0].toISOString();
      if (range[1].getFullYear() < 3000) params.dateTo = range[1].toISOString();
    }
    return params;
  }

  // Fetches the current page. `loading` gates only the very first render (a
  // full-page "Loading jobs..." placeholder); every later fetch - a filter
  // change, another page, the reload JobCard triggers after saving a payout
  // - just swaps in the new data, so the list stays mounted and the scroll
  // position isn't lost.
  const hasLoadedOnce = useRef(false);
  const latestRequest = useRef(0);
  // Signature of a fetch we've already satisfied (skips an identical repeat).
  const skipSig = useRef("");
  // True while the focused job's page still has to be looked up by the server.
  const focusPending = useRef(Boolean(focusJobId));
  const lastFocus = useRef(focusJobId);
  if (lastFocus.current !== focusJobId) {
    lastFocus.current = focusJobId;
    focusPending.current = Boolean(focusJobId);
  }

  useEffect(() => {
    const params = filterParams();
    if (focusJobId) params.focus = focusJobId;
    const sigFor = (p) => JSON.stringify([params, pageSize, p, refreshTick]);
    const askedPage = focusPending.current ? null : page;
    if (askedPage !== null && skipSig.current === sigFor(askedPage)) return;

    const requestId = ++latestRequest.current;
    if (!hasLoadedOnce.current) setLoading(true);
    setError("");
    getJobsPage({ ...params, pageSize, ...(askedPage !== null ? { page: askedPage } : {}) })
      .then((data) => {
        if (requestId !== latestRequest.current) return;
        setJobs(data.items);
        setTotal(data.total);
        setHasAnyJobs(data.hasAnyJobs);
        hasLoadedOnce.current = true;
        focusPending.current = false;
        // The server may have picked a different page than asked (the
        // focused job's page, or the last page after jobs were removed).
        if (data.page !== askedPage) {
          skipSig.current = sigFor(data.page);
          setPageState({ key: filterKey, page: data.page });
        }
      })
      .catch((err) => {
        if (requestId === latestRequest.current) setError(err.message);
      })
      .finally(() => {
        if (requestId === latestRequest.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, page, refreshTick, focusJobId]);

  // The overview totals cover every matching job, not only the shown page.
  useEffect(() => {
    const params = filterParams();
    if (focusJobId) params.focus = focusJobId;
    let cancelled = false;
    getJobsOverview(params)
      .then((data) => {
        if (!cancelled) setOverviewJobs(data);
      })
      .catch(() => {
        // the list's own error banner already covers a failing server
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, refreshTick, focusJobId]);

  // Worker names for the filter dropdown.
  useEffect(() => {
    getWorkerOptions()
      .then(setWorkers)
      .catch(() => {});
  }, []);

  function loadAll() {
    setRefreshTick((t) => t + 1);
  }

  // Scrolls the focused job's card into view once it's on the shown page.
  useEffect(() => {
    if (!focusJobId) return;
    const el = document.getElementById(`job-${focusJobId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusJobId, jobs]);

  async function handleExport() {
    try {
      const data = await getJobsAll(filterParams());
      const rows = data.items.map(formatForExport);
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `jobs-export-${stamp}.xlsx`);
      showToast(`Exported ${rows.length} job${rows.length === 1 ? "" : "s"}`, "success");
    } catch (err) {
      showToast(err.message, "error");
    }
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
            {total} job{total === 1 ? "" : "s"}
          </span>
          <button className="btn btn-secondary" onClick={handleExport} disabled={total === 0}>
            Export as Excel
          </button>
        </div>
      </div>

      {loading ? (
        <p>Loading jobs...</p>
      ) : (
        <>
          {overviewJobs && <JobsChart jobs={overviewJobs} />}

          {total === 0 ? (
            <p className="empty-state">
              {!hasAnyJobs
                ? "No jobs yet - paste a link on the Home tab to get started."
                : "No jobs match the current filters."}
            </p>
          ) : (
            <>
              <Pagination total={total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} noun="job" />
              <div className="job-list">
                {jobs.map((job) => (
                  <JobCard key={job._id} job={job} onChange={loadAll} highlighted={job._id === focusJobId} />
                ))}
              </div>
              <Pagination total={total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} noun="job" />
            </>
          )}
        </>
      )}
    </div>
  );
}
