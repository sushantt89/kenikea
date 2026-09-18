import { scoreLocation, locationsMatch } from "../utils/distance.js";
import { timezoneForWorkArea } from "../utils/workAreas.js";
import { formatInZone } from "../utils/timezone.js";
import { checkFortnightAvailability } from "./fortnightAvailability.js";

/**
 * The assignment engine, in the order the business rules were specified:
 *
 *   1. Availability     - a worker is never a candidate for a time they've
 *                         told the fortnightly form they're not free for -
 *                         see checkFortnightAvailability() in
 *                         fortnightAvailability.js, which parses their
 *                         free-text day answer ("8-5", "Not available", ...)
 *                         and compares it against this job's scheduled
 *                         time. There is deliberately no plain on/off
 *                         toggle anymore (the old Worker.availability
 *                         checkbox is gone from the UI) - this is now
 *                         entirely driven by what they actually submitted
 *                         for that specific day. Like hasTimeConflict below,
 *                         this fails OPEN (never excludes) whenever there's
 *                         nothing to check against - no scheduled time on
 *                         the job, or no submitted answer for that day.
 *                         Neither is a worker whose existing job's scheduled
 *                         time window genuinely overlaps this job's - a
 *                         worker can't physically be in two places at once,
 *                         so that's a hard exclusion too, not just a score
 *                         penalty (see hasTimeConflict below). This only
 *                         applies when BOTH jobs have a known scheduled
 *                         time; if either doesn't, there's nothing to
 *                         compare and the worker is never excluded on that
 *                         basis alone. A worker already on THIS job's team
 *                         is excluded too - no point ranking them again.
 *   2. Work area        - if the job has a work area set, only workers
 *                         whose OWN work area (set on the Workers page)
 *                         matches exactly are considered - e.g. an Adelaide
 *                         job will never show an NSW-based worker as a
 *                         candidate, and a worker with no work area set
 *                         doesn't match anything until they get one. This
 *                         only gates the ranked list (Preview/Auto-assign);
 *                         manually adding a specific worker via "Add to
 *                         team" still bypasses every check, same as always.
 *   3. Skill / difficulty - prefer the closest skill match that still meets
 *                           (or exceeds) the job's difficulty tier
 *                           (Easy/Medium/Difficult); heavily penalise
 *                           underqualified workers.
 *   4. Location         - prefer workers nearer the job (real distance if
 *                           coordinates are set on both sides, otherwise a
 *                           text match on the location field). Since
 *                           candidates are already narrowed to the job's own
 *                           work area by rule 2, this is really about
 *                           picking the closest match *within* that area.
 *   5. Existing assignments - a worker already at their concurrent-job limit
 *                           is skipped unless nobody else is eligible; a
 *                           worker already working a job in the *same* area
 *                           is only lightly penalised (it's efficient to
 *                           keep them there), one in a *different* area is
 *                           penalised more heavily.
 *
 * Worker.priority (Low/Medium/High) is applied last, as a small tiebreaker
 * nudge - it never overrides the rules above, it only separates otherwise
 * close candidates.
 *
 * The function always returns the full ranked breakdown (not just the
 * winner) so the UI can show *why* a worker was chosen and let a human
 * override the suggestion.
 *
 * A job can need more than one worker on it at once (see
 * requiredWorkerCount() below) - "assigning" a job is therefore filling a
 * TEAM, not picking a single winner. This module still just ranks
 * candidates one job at a time; routes/jobs.js is what takes the top N off
 * the ranking to fill a team on auto-assign.
 */

const WEIGHTS = {
  skillPerPointOver: -3, // cost per point *over*-qualified (mild, encourages a close match)
  skillMatchBonus: 20, // score when skillLevel matches the job's difficulty tier exactly
  skillPerPointUnder: 10, // magnitude of the cost per point *under*-qualified (see scoreSkill - gap is negative here, so this needs to be positive for gap * weight to come out as a penalty, not a bonus)
  loadFreeBonus: 8, // bonus for having zero active jobs right now
  loadSameAreaPenalty: -4, // already has an active job in the same area
  loadDifferentAreaPenalty: -12, // already has an active job elsewhere
  loadExtraJobPenalty: -6, // additional penalty per active job beyond the first
  priorityBonus: { High: 3, Medium: 1, Low: 0 },
};

// Job.difficulty is a plain three-level label (Easy/Medium/Difficult), but
// Worker.skillLevel stays a 1-5 number (more granular, and not something
// anyone asked to change). To keep comparing them meaningfully, each tier
// is mapped onto that same 1-5 scale at its natural anchor point - Easy=1,
// Medium=3 (the old default), Difficult=5 - which exactly reproduces the
// previous 1-5 vs 1-5 gap math for the two ends and the middle, so the
// WEIGHTS above (and the skill score's -40..+20 range baked into
// client/src/utils/scoreScale.js) didn't need to change at all.
const DIFFICULTY_RANK = { Easy: 1, Medium: 3, Difficult: 5 };

export function difficultyRank(difficulty) {
  return DIFFICULTY_RANK[difficulty] ?? DIFFICULTY_RANK.Medium;
}

/**
 * How many workers a job needs on its team at once. Two independent
 * business rules, whichever asks for more wins (they're not additive):
 *   - Over 3 hours (180 min) needs at least 2 workers.
 *   - An IKEA payout over $500 needs at least 3 workers.
 * Everything else just needs 1.
 * @param {{durationMinutes?: number, chargesTotal?: number}} job
 */
export function requiredWorkerCount(job) {
  let n = 1;
  if ((job?.durationMinutes || 0) > 180) n = Math.max(n, 2);
  if ((job?.chargesTotal || 0) > 500) n = Math.max(n, 3);
  return n;
}

function scoreSkill(worker, job) {
  const gap = worker.skillLevel - difficultyRank(job.difficulty);
  if (gap >= 0) {
    return { score: WEIGHTS.skillMatchBonus + gap * WEIGHTS.skillPerPointOver, gap };
  }
  // gap is negative here (underqualified) - multiplying by the positive
  // skillPerPointUnder weight correctly produces a negative score (penalty).
  return { score: gap * WEIGHTS.skillPerPointUnder, gap };
}

function getJobWindow(j) {
  if (!j?.scheduledStart) return null;
  const start = new Date(j.scheduledStart).getTime();
  if (Number.isNaN(start)) return null;
  const durationMinutes = j.durationMinutes ?? 60;
  return { start, end: start + durationMinutes * 60 * 1000 };
}

/**
 * True only when BOTH jobs have a known, valid scheduled time AND those
 * windows genuinely overlap. Deliberately fails "open" (returns false, i.e.
 * no conflict) whenever either job's time isn't set - an unknown time isn't
 * evidence of a conflict, and treating it as one would end up excluding
 * every worker just because a job was entered without a specific time.
 */
function hasTimeConflict(jobA, jobB) {
  const a = getJobWindow(jobA);
  const b = getJobWindow(jobB);
  if (!a || !b) return false;
  return a.start < b.end && b.start < a.end;
}

/** True if `worker` is on `job`'s current team (job.assignedWorkers). */
function isOnTeam(worker, job) {
  return (job.assignedWorkers || []).some((a) => String(a.worker) === String(worker._id));
}

function scoreLoad(worker, job, activeJobsForWorker, maxConcurrentJobs) {
  if (activeJobsForWorker.length === 0) {
    return { score: WEIGHTS.loadFreeBonus, atCapacity: false, sameArea: null, activeCount: 0 };
  }

  const atCapacity = activeJobsForWorker.length >= maxConcurrentJobs;
  const sameArea = activeJobsForWorker.some((j) => locationsMatch(j.location, job.location));

  let score = sameArea ? WEIGHTS.loadSameAreaPenalty : WEIGHTS.loadDifferentAreaPenalty;
  score += (activeJobsForWorker.length - 1) * WEIGHTS.loadExtraJobPenalty;

  return { score, atCapacity, sameArea, activeCount: activeJobsForWorker.length };
}

/**
 * @param {object} job - the job to assign (needs difficulty, location, lat/lng, assignedWorkers)
 * @param {object[]} workers - all workers to consider
 * @param {object[]} activeJobs - all jobs currently with status "Assigned" (any worker), each with assignedWorkers
 * @param {number} maxConcurrentJobs - capacity limit per worker
 */
export function rankCandidates(job, workers, activeJobs, maxConcurrentJobs = 2) {
  const excluded = [];
  const available = [];

  for (const worker of workers) {
    const fortnightCheck = checkFortnightAvailability(worker, job);
    if (!fortnightCheck.ok) {
      excluded.push({ workerId: worker._id, name: worker.name, reason: fortnightCheck.reason });
      continue;
    }

    if (job.workArea && worker.workArea !== job.workArea) {
      excluded.push({
        workerId: worker._id,
        name: worker.name,
        reason: `Different work area (job is in ${job.workArea}, worker is ${
          worker.workArea ? `in ${worker.workArea}` : "not assigned a work area"
        })`,
      });
      continue;
    }

    if (isOnTeam(worker, job)) {
      excluded.push({ workerId: worker._id, name: worker.name, reason: "Already assigned to this job" });
      continue;
    }

    const conflict = activeJobs.find(
      (j) =>
        (j.assignedWorkers || []).some((a) => String(a.worker) === String(worker._id)) &&
        hasTimeConflict(job, j)
    );
    if (conflict) {
      const when = conflict.scheduledStart
        ? formatInZone(conflict.scheduledStart, timezoneForWorkArea(conflict.workArea))
        : "an unspecified time";
      excluded.push({
        workerId: worker._id,
        name: worker.name,
        reason: `Time conflict with "${conflict.title}" (scheduled ${when})`,
      });
      continue;
    }

    available.push(worker);
  }

  if (available.length === 0) {
    return { ranking: [], excluded, pool: "none", assigned: null };
  }

  const withActiveJobs = available.map((worker) => {
    const activeJobsForWorker = activeJobs.filter((j) =>
      (j.assignedWorkers || []).some((a) => String(a.worker) === String(worker._id))
    );
    return { worker, activeJobsForWorker };
  });

  const notAtCapacity = [];
  const atCapacity = [];
  for (const entry of withActiveJobs) {
    const isAtCapacity = entry.activeJobsForWorker.length >= maxConcurrentJobs;
    (isAtCapacity ? atCapacity : notAtCapacity).push(entry);
  }

  let pool = notAtCapacity;
  let poolLabel = "available";
  if (pool.length === 0) {
    // Nobody has spare capacity - fall back to everyone rather than refusing
    // to assign, but flag it clearly. (They stay in `pool` and get scored
    // normally below, just under the "all workers are at capacity" label.)
    pool = atCapacity;
    poolLabel = "all workers are at capacity";
  } else {
    for (const entry of atCapacity) {
      excluded.push({
        workerId: entry.worker._id,
        name: entry.worker.name,
        reason: `At capacity (${entry.activeJobsForWorker.length}/${maxConcurrentJobs} active jobs)`,
      });
    }
  }

  const ranking = pool.map(({ worker, activeJobsForWorker }) => {
    const skill = scoreSkill(worker, job);
    const location = scoreLocation(worker, job);
    const load = scoreLoad(worker, job, activeJobsForWorker, maxConcurrentJobs);
    const priorityBonus = WEIGHTS.priorityBonus[worker.priority] ?? 0;

    const total = skill.score + location.score + load.score + priorityBonus;

    return {
      workerId: worker._id,
      name: worker.name,
      email: worker.email,
      location: worker.location,
      skillLevel: worker.skillLevel,
      priority: worker.priority,
      // Included so the "Preview candidates" ranking table can show the
      // same click-to-view Availability popup as the Workers page,
      // without a second fetch per worker (see FortnightAvailability.jsx).
      formAvailability: worker.formAvailability,
      formAvailabilitySyncedAt: worker.formAvailabilitySyncedAt,
      total: Math.round(total * 10) / 10,
      breakdown: {
        skill: { score: round1(skill.score), gap: skill.gap },
        location: { score: round1(location.score), distanceKm: location.distanceKm, method: location.method },
        load: {
          score: round1(load.score),
          activeCount: load.activeCount,
          atCapacity: load.atCapacity,
          sameAreaAsExisting: load.sameArea,
        },
        priorityBonus: round1(priorityBonus),
      },
    };
  });

  ranking.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;

    // Exact tie on total score. Location scoring uses coarse distance
    // *bands* (see distance.js - anything under 20km scores the same 14
    // points, for example), so two workers can tie overall despite one
    // being genuinely several km closer. Break the tie with the real
    // distance rather than leaving it to whatever order they happened to
    // be in - closer wins. If neither/either side lacks a real distance
    // (text-matching fallback), the tie is left as-is (stable sort keeps
    // the original order), since there's nothing more meaningful to compare.
    const distA = a.breakdown.location.distanceKm;
    const distB = b.breakdown.location.distanceKm;
    if (distA != null && distB != null && distA !== distB) return distA - distB;

    return 0;
  });

  return {
    ranking,
    excluded,
    pool: poolLabel,
    assigned: ranking[0] || null,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

export { WEIGHTS };
