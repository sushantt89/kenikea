// A small, dependency-free bar chart (plain inline SVG-free HTML/CSS) -
// avoids pulling in a charting library for a handful of simple bars, and
// keeps the bundle light. Colors follow a fixed categorical order (never
// re-cycled per filter) matching the rest of the app's palette: blue for
// "proposed worker payout" figures, amber for "worker payout" figures,
// plus the app's existing green/red for the profit delta - so the same
// quantity always reads as the same color everywhere in the app.

const STATUS_COLORS = {
  Unassigned: "#9aa1ac",
  Assigned: "#3457d5",
  Completed: "#1f9d55",
};

const ADMIN_COLOR = "#3f5efb"; // matches --primary
const WORKER_COLOR = "#d59a1f"; // matches --amber
const WORKER_PALETTE = ["#d59a1f", "#7c5cff", "#0fa3a3", "#e0668c", "#5a7d2a", "#3457d5", "#d64545", "#1f9d55"];

function money(n) {
  return `$${Number(n).toFixed(2)}`;
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
function StatTile({ label, value, tone }) {
  return (
    <div className="stat-tile">
      <span className="stat-tile-label">{label}</span>
      <span className={`stat-tile-value${tone ? ` stat-tile-${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export default function JobsChart({ jobs }) {
  const statusCounts = { Unassigned: 0, Assigned: 0, Completed: 0 };
  for (const job of jobs) {
    if (statusCounts[job.status] !== undefined) statusCounts[job.status] += 1;
  }
  const maxStatusCount = Math.max(1, ...Object.values(statusCounts));

  // "Proposed worker payout" (job.pay.adminPay - see
  // server/src/services/pay.js) is a per-JOB figure, so it's broken down
  // by job here rather than by worker.
  const pricedJobs = jobs.filter((j) => j.pay?.adminPay != null);
  const adminByJob = pricedJobs
    .map((j) => ({ label: j.title, value: j.pay.adminPay }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const maxAdmin = Math.max(1, ...adminByJob.map((e) => e.value));

  // Worker payout is the manually-entered amount each assigned worker gets
  // for a job (see Job.assignedWorkers[].payout) - summed per worker here,
  // across every filtered job they're on (naturally handles a job with
  // more than one worker, since each has its own entry).
  const payoutByWorker = new Map();
  for (const job of jobs) {
    for (const a of job.assignedWorkers || []) {
      if (a.payout == null || !a.worker) continue;
      const key = a.worker.name || "Unknown";
      payoutByWorker.set(key, (payoutByWorker.get(key) || 0) + Number(a.payout));
    }
  }
  const payoutEntries = [...payoutByWorker.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxPayout = Math.max(1, ...payoutEntries.map(([, v]) => v));

  const totalJobs = jobs.length;
  const totalIkea = pricedJobs.reduce((sum, j) => sum + Number(j.chargesTotal || 0), 0);
  const totalAdmin = pricedJobs.reduce((sum, j) => sum + Number(j.pay.adminPay || 0), 0);
  const totalWorkerPayout = [...payoutByWorker.values()].reduce((a, b) => a + b, 0);
  const totalProfit = totalAdmin - totalWorkerPayout;

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

      {pricedJobs.length > 0 && (
        <div className="stat-tile-row">
          <StatTile label="IKEA payout" value={money(totalIkea)} />
          <StatTile label="Proposed worker payout" value={money(totalAdmin)} />
          <StatTile label="Worker payout" value={money(totalWorkerPayout)} />
          <StatTile
            label="Profit"
            value={money(totalProfit)}
            tone={totalProfit >= 0 ? "positive" : "negative"}
          />
        </div>
      )}

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

        <div className="chart-block">
          <div className="chart-block-header">
            <h3>Proposed worker payout by job</h3>
            <span className="muted small">{money(totalAdmin)} total</span>
          </div>
          {adminByJob.length === 0 ? (
            <p className="empty-state">No priced jobs in this range yet.</p>
          ) : (
            adminByJob.map((entry, i) => (
              <BarRow
                key={entry.label + i}
                label={entry.label}
                value={entry.value}
                max={maxAdmin}
                color={ADMIN_COLOR}
                formatValue={money}
              />
            ))
          )}
        </div>

        <div className="chart-block">
          <div className="chart-block-header">
            <h3>Worker payout by worker</h3>
            <span className="muted small">{money(totalWorkerPayout)} total</span>
          </div>
          {payoutEntries.length === 0 ? (
            <p className="empty-state">No worker payouts entered for this range yet.</p>
          ) : (
            payoutEntries.map(([name, value], i) => (
              <BarRow
                key={name}
                label={name}
                value={value}
                max={maxPayout}
                color={i === 0 ? WORKER_COLOR : WORKER_PALETTE[i % WORKER_PALETTE.length]}
                formatValue={money}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
