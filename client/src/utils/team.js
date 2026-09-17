// Mirrors requiredWorkerCount() in server/src/services/assignment.js, purely
// so the UI can show a "needs N more" badge without a round trip - the
// server's own copy is still what's authoritative for auto-assign.
export function requiredWorkerCount(job) {
  let n = 1;
  if ((job?.durationMinutes || 0) > 180) n = Math.max(n, 2);
  if ((job?.chargesTotal || 0) > 500) n = Math.max(n, 3);
  return n;
}
