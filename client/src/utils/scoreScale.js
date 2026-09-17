/**
 * Normalizes the assignment engine's raw scores onto a common, easy-to-read
 * 1-10 scale for display purposes only.
 *
 * The raw scores from server/src/services/assignment.js (and
 * server/src/utils/distance.js for Location) use very different ranges by
 * design - Skill can swing from -40 to +20, Location only ever goes 0 to
 * +20, Load roughly -12 to +8, Priority just 0 to 3 - so putting them
 * side by side as raw numbers makes columns look comparable when they
 * aren't. This maps each factor's own known best/worst case onto 1
 * (worst that factor can ever be) to 10 (best), so every column in the
 * ranking table means the same thing at a glance.
 *
 * IMPORTANT: this is a display transform only. The actual ranking/sorting
 * always uses the real, unnormalized totals computed by the server - nudge
 * these ranges if the WEIGHTS in assignment.js change, but never feed a
 * normalized value back into any real decision.
 */

const RANGES = {
  // WEIGHTS.skillMatchBonus (20, exact match) is the best case. The worst
  // is the most underqualified a worker can be: a 4-point gap (skill 1 vs
  // difficulty 5) * WEIGHTS.skillPerPointUnder (10) = -40.
  skill: { min: -40, max: 20 },
  // scoreLocation() in distance.js: 0 (far apart / no text match) to 20
  // (within 5km, or an exact text match).
  location: { min: 0, max: 20 },
  // WEIGHTS.loadFreeBonus (8, no active jobs) is the best case. One active
  // job in a different area is -12 - the realistic worst case for a
  // worker who still has spare capacity (the usual candidate pool).
  // Several active jobs can score lower still; that's rare enough to just
  // clamp to the bottom of the scale (1/10) rather than stretch the range
  // for an edge case.
  load: { min: -12, max: 8 },
  // WEIGHTS.priorityBonus: Low 0, Medium 1, High 3.
  priority: { min: 0, max: 3 },
  // Sum of the four ranges above, for the overall "Score" column.
  total: { min: -40 + 0 - 12 + 0, max: 20 + 20 + 8 + 3 },
};

/**
 * @param {number} raw
 * @param {'skill'|'location'|'load'|'priority'|'total'} kind
 * @returns {{ tenScale: number, percent: number }} tenScale is an integer
 *   1-10 (clamped); percent is 0-100 (clamped), meant for a bar's width/color.
 */
export function normalizeScore(raw, kind) {
  const range = RANGES[kind];
  const fraction = range.max === range.min ? 1 : (raw - range.min) / (range.max - range.min);
  const clamped = Math.min(1, Math.max(0, fraction));
  return {
    tenScale: Math.round(1 + clamped * 9),
    percent: Math.round(clamped * 100),
  };
}

/** Red (worst) -> orange -> amber -> green (best), matching the pill colors used elsewhere. */
export function scoreColor(percent) {
  if (percent >= 75) return "#1fa971";
  if (percent >= 50) return "#d59a1f";
  if (percent >= 25) return "#e08a45";
  return "#e0455a";
}
