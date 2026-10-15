export const PAGE_SIZES = [10, 25, 50, 100];

// 1 ... 4 5 [6] 7 8 ... 20
function pageNumbers(page, pageCount) {
  const nums = new Set([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...nums].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("gap-" + n);
    out.push(n);
  });
  return out;
}

export default function Pagination({ total, page, pageSize, onPage, onPageSize, noun = "item" }) {
  // Nothing to page through.
  if (total <= PAGE_SIZES[0]) return null;

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="pagination">
      <span className="muted small">
        {from}-{to} of {total} {noun}
        {total === 1 ? "" : "s"}
      </span>
      <div className="pagination-pages">
        <button type="button" className="btn btn-secondary" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          Previous
        </button>
        {pageNumbers(page, pageCount).map((n) =>
          typeof n === "string" ? (
            <span key={n} className="muted">
              ...
            </span>
          ) : (
            <button
              key={n}
              type="button"
              className={`btn ${n === page ? "btn-primary" : "btn-secondary"}`}
              onClick={() => onPage(n)}
              aria-current={n === page ? "page" : undefined}
            >
              {n}
            </button>
          )
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
        >
          Next
        </button>
      </div>
      <label className="pagination-size muted small">
        Per page{" "}
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
