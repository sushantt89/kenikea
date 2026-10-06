// A small, dependency-free bar chart (plain inline SVG-free HTML/CSS) -
// avoids pulling in a charting library for a handful of simple bars, and
// keeps the bundle light.

import { currencyForWorkArea, CURRENCY_SYMBOL } from "../utils/workAreas.js";

const STATUS_COLORS = {
  Unassigned: "#9aa1ac",
  Assigned: "#3457d5",
  Completed: "#1f9d55",
};

// `currency` defaults to AUD (the original single-currency assumption)
// but every call site below passes the actual job's own currency (see
// currencyForWorkArea in utils/workAreas.js) so an Auckland job's numbers
// read as "NZ$..." rather than a bare "$" that implies AUD.
function money(n, currency = "AUD") {
  const symbol = CURRENCY_SYMBOL[currency] || "$";
  return `${symbol}${Number(n).toFixed(2)}`;
}

function BarRow({ label, value, max, color, formatValue }) {
  const pct = max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0;
  return (
    <div className="chart-row">
      <span className="chart-row-label" title={label}>
        {label}
      </span>
      <div className="chart-row-track">
        <div className="chart-row-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="chart-row-value">{formatValue ? formatValue(value) : value}</span>
    </div>
  );
}

// A KPI row of stat tiles - "a handful of headline numbers" is a stat-tile
// job, not a chart (see the dataviz skill's choosing-a-form guidance). This
// is what directly answers "how much money is being made": IKEA payout in,
// the business's own cut, what workers were paid out, and the difference.
// (The old "by job"/"by worker" breakdown lists below this used to expand
// to one row per job/worker, which just turned into an ever-growing
// scrolling list as more jobs piled up - removed in favor of these
// headline totals plus the job cards/Workers page for the per-item detail.)
function StatTile({ label, value, tone }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className={`stat-tile-value${tone ? ` stat-tile-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

// One row of the 4 headline tiles for a single currency's jobs. `suffix` is
// " (AUD)"/" (NZD)" when more than one currency is present in the current
// filter, or "" when everything on screen is the same currency (the common
// case for a business that only ever sees one country's jobs at a time) -
// no point labeling every tile with a currency nobody needs to
// disambiguate.
function CurrencyStatRow({ currency, suffix, totalIkea, totalAdmin, totalWorkerPayout, totalProfit }) {
  const fmt = (n) => money(n, currency);
  return (
    <div className="stat-tile-row" key={currency}>
      <StatTile label={`IKEA payout${suffix}`} value={fmt(totalIkea)} />
      <StatTile label={`Proposed worker payout${suffix}`} value={fmt(totalAdmin)} />
      <StatTile label={`Worker payout${suffix}`} value={fmt(totalWorkerPayout)} />
      <StatTile
        label={`Profit${suffix}`}
        value={fmt(totalProfit)}
        tone={totalProfit >= 0 ? "positive" : "negative"}
      />
    </div>
  );
}

export default function JobsChart({ jobs }) {
  const statusCounts = { Unassigned: 0, Assigned: 0, Completed: 0 };
  for (const job of jobs) {
    if (statusCounts[job.status] !== undefined) statusCounts[job.status] += 1;
  }
  const maxStatusCount = Math.max(1, ...Object.values(statusCounts));

  // Every money total below is kept split by currency (AUD vs NZD - see
  // currencyForWorkArea) rather than blended into one number: an
  // Australian job's dollars and a New Zealand job's dollars are
  // different currencies, not just different regions, so adding them
  // together would be a meaningless figure even though both print with a
  // "$" sign. `currencies` is whichever ones are actually present in the
  // current filter (usually just one, unless the Jobs page's filters are
  // set to show both countries at once).
  const currencyOf = (job) => currencyForWorkArea(job.workArea);
  const currencies = [...new Set(jobs.map(currencyOf))];
  const multiCurrency = currencies.length > 1;

  const pricedJobs = jobs.filter((j) => j.pay?.adminPay != null);

  // Worker payout is the manually-entered amount each assigned worker gets
  // for a job (see Job.assignedWorkers[].payout) - summed per CURRENCY
  // here (an Australian job's payout is never added to a New Zealand
  // job's), which is all the "Worker payout" headline tile needs; the
  // per-worker breakdown this used to feed has been removed (see the
  // comment on StatTile above).
  const workerPayoutByCurrency = new Map();
  for (const job of jobs) {
    const currency = currencyOf(job);
    for (const a of job.assignedWorkers || []) {
      if (a.payout == null) continue;
      workerPayoutByCurrency.set(currency, (workerPayoutByCurrency.get(currency) || 0) + Number(a.payout));
    }
  }

  const totalJobs = jobs.length;

  // One totals object per currency present, rather than one blended set -
  // see the big comment above `currencies`.
  const totalsByCurrency = currencies.map((currency) => {
    const jobsForCurrency = pricedJobs.filter((j) => currencyOf(j) === currency);
    const totalIkea = jobsForCurrency.reduce((sum, j) => sum + Number(j.chargesTotal || 0), 0);
    const totalAdmin = jobsForCurrency.reduce((sum, j) => sum + Number(j.pay.adminPay || 0), 0);
    const totalWorkerPayout = workerPayoutByCurrency.get(currency) || 0;
    // Profit is the SUM of each job's own profit, computed exactly like the
    // job card and the Excel export do (JobCard.jsx / Jobs.jsx
    // formatForExport): the IKEA payout (before GST) minus what the workers
    // actually get - their entered payouts once every assigned worker has
    // one, otherwise the proposed worker payout as a stand-in. (This tile
    // used to be "proposed payout minus entered payout", which is the
    // saving versus the proposal, not profit, so it disagreed with every
    // job card.)
    const totalProfit = jobsForCurrency.reduce((sum, j) => {
      if (j.chargesTotal == null) return sum;
      const assigned = j.assignedWorkers || [];
      const settled = assigned.length > 0 && assigned.every((a) => a.payout != null);
      const effectivePayout = settled
        ? assigned.reduce((t, a) => t + (Number(a.payout) || 0), 0)
        : Number(j.pay.adminPay || 0);
      return sum + (Number(j.chargesTotal) - effectivePayout);
    }, 0);
    return { currency, totalIkea, totalAdmin, totalWorkerPayout, totalProfit };
  });

  if (totalJobs === 0) {
    return (
      <div className="card chart-card">
        <h2>Overview</h2>
        <p className="empty-state">No jobs match the current filters.</p>
      </div>
    );
  }

  return (
    <div className="card chart-card">
      <h2>Overview</h2>

      {pricedJobs.length > 0 &&
        totalsByCurrency.map((t) => (
          <CurrencyStatRow key={t.currency} {...t} suffix={multiCurrency ? ` (${t.currency})` : ""} />
        ))}

      <div className="chart-grid">
        <div className="chart-block">
          <div className="chart-block-header">
            <h3>Jobs by status</h3>
            <span className="muted small">{totalJobs} total</span>
          </div>
          {Object.entries(statusCounts).map(([status, count]) => (
            <BarRow
              key={status}
              label={status}
              value={count}
              max={maxStatusCount}
              color={STATUS_COLORS[status]}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
