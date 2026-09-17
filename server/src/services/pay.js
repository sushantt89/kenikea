/**
 * Business (admin) pay calculation.
 *
 * The IKEA payout the business receives for a job (its `chargesTotal`, in
 * AUD) is not what the business itself keeps - two deductions are applied,
 * in this order:
 *
 *   1. GST (10%) is removed from the payout.
 *   2. The business/admin keeps a fixed share (75%) of what's left.
 *
 * This is the ADMIN's cut, not any individual worker's pay - what each
 * assigned worker is actually paid for a job is a separate, manually
 * entered amount (see Job.assignedWorkers[].payout in models/Job.js),
 * since that's negotiated per worker/job rather than a fixed formula.
 * Comparing this admin figure against the sum of what workers were paid
 * is what shows the actual profit on a job (see routes/jobs.js
 * attachPay() and client/src/components/JobCard.jsx).
 *
 * Worked example:
 *   $100 payout -> less 10% GST = $90.00 -> admin's 75% share = $67.50
 *
 *   gstAmount = chargesTotal * GST_RATE        =  100 * 0.10 = 10.00
 *   afterGst  = chargesTotal - gstAmount        =  100 - 10  = 90.00
 *   adminPay  = afterGst     * ADMIN_SHARE      =   90 * 0.75 = 67.50
 */

export const GST_RATE = 0.1; // 10%
export const ADMIN_SHARE = 0.75; // admin/business keeps 75% of the post-GST amount

/**
 * @param {number|string|null|undefined} chargesTotal - the IKEA payout to the business, in AUD
 * @returns {{chargesTotal:number, gstRate:number, gstAmount:number, afterGst:number, adminShare:number, adminPay:number} | null}
 *   null when chargesTotal isn't a usable positive number - i.e. there's
 *   nothing to calculate yet (job has no price info scraped/entered).
 */
export function computePay(chargesTotal) {
  const total = Number(chargesTotal);
  if (!Number.isFinite(total) || total <= 0) return null;

  const gstAmount = round2(total * GST_RATE);
  const afterGst = round2(total - gstAmount);
  const adminPay = round2(afterGst * ADMIN_SHARE);

  return {
    chargesTotal: round2(total),
    gstRate: GST_RATE,
    gstAmount,
    afterGst,
    adminShare: ADMIN_SHARE,
    adminPay,
  };
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
