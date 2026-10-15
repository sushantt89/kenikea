import mongoose from "mongoose";
import Worker from "../models/Worker.js";
import { WORK_AREAS, countryForWorkArea } from "../utils/workAreas.js";

// Turns the Jobs page's filters (query string) into a MongoDB filter, so
// filtering and paging happen in the database instead of in the browser.
// Mirrors what the page used to do client-side.

const str = (v) => (typeof v === "string" ? v.trim() : "");
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(str(v));
const noWorkArea = { $or: [{ workArea: null }, { workArea: "" }] }; // null also matches "missing"

function parseDate(v) {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function buildJobFilter(query) {
  const and = [];

  // Archived: "active" (default) hides archived jobs, "archived" shows only
  // them, "all" shows both.
  const archived = str(query.archived) || "active";
  if (archived === "archived") and.push({ archived: true });
  else if (archived === "active") and.push({ archived: { $ne: true } });

  const status = str(query.status);
  if (status && status !== "all") and.push({ status });

  const workArea = str(query.workArea);
  if (workArea === "none") and.push(noWorkArea);
  else if (WORK_AREAS.includes(workArea)) and.push({ workArea });

  // A job with no work area counts as the default country (Australia), same
  // as countryForWorkArea() everywhere else.
  const country = str(query.country);
  if (country && country !== "all") {
    const areas = WORK_AREAS.filter((a) => countryForWorkArea(a) === country);
    const clauses = [{ workArea: { $in: areas } }];
    if (countryForWorkArea(null) === country) clauses.push(noWorkArea);
    and.push({ $or: clauses });
  }

  const worker = str(query.worker);
  if (worker === "unassigned") {
    and.push({ $or: [{ assignedWorkers: { $size: 0 } }, { assignedWorkers: { $exists: false } }] });
  } else if (isObjectId(worker)) {
    and.push({ "assignedWorkers.worker": worker });
  }

  // A job's own date: its scheduled time, or when it was created if it has
  // none (same rule as the Jobs page's period filters).
  const range = {};
  const from = parseDate(query.dateFrom);
  const to = parseDate(query.dateTo);
  if (from) range.$gte = from;
  if (to) range.$lt = to;
  if (from || to) {
    and.push({ $or: [{ scheduledStart: range }, { scheduledStart: null, createdAt: range }] });
  }

  const search = str(query.search);
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    const matchingWorkers = await Worker.find({ name: rx }).select("_id").lean();
    const or = [
      { title: rx },
      { location: rx },
      { workArea: rx },
      { status: rx },
      { description: rx },
      { "customer.name": rx },
      { "customer.phone": rx },
      { "customer.email": rx },
    ];
    if (isObjectId(search)) or.push({ _id: search });
    if (matchingWorkers.length) or.push({ "assignedWorkers.worker": { $in: matchingWorkers.map((w) => w._id) } });
    and.push({ $or: or });
  }

  return and.length ? { $and: and } : {};
}

export const JOB_SORT = { createdAt: -1, _id: -1 };

export function parsePaging(query, { defaultSize = 10, maxSize = 200 } = {}) {
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(str(query.pageSize), 10) || defaultSize));
  const page = parseInt(str(query.page), 10);
  return { pageSize, page: Number.isFinite(page) && page > 0 ? page : null };
}

/**
 * The page (1-based) a given document lands on in a createdAt-desc list -
 * used to open the page holding a job/worker that was opened from a
 * notification.
 */
export async function pageOf(Model, filter, doc, pageSize) {
  const ahead = await Model.countDocuments({
    $and: [
      filter,
      { $or: [{ createdAt: { $gt: doc.createdAt } }, { createdAt: doc.createdAt, _id: { $gt: doc._id } }] },
    ],
  });
  return Math.floor(ahead / pageSize) + 1;
}

export { mongoose };
