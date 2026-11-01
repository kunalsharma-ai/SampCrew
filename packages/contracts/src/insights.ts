import { fromMinor, toMinor } from './money';

/**
 * Explainable workforce insights. These are transparent rules, not a trained model: every point in a score
 * comes from a named factor with the evidence behind it, so HR can see why and disagree. They are advisory and
 * never change a record on their own.
 */

// Attrition risk -----------------------------------------------------------------------------------------------

export interface AttritionInput {
  /** Whole months since joining. */
  tenureMonths: number;
  /** Months since the last promotion, transfer or other job change; null when there has been none. */
  monthsSinceJobChange: number | null;
  /** Unplanned leave days (sick, casual, unpaid) in the last 90 days and in the 90 days before. */
  unplannedLeaveRecent: number;
  unplannedLeavePrior: number;
  /** Days late or absent without leave in the last 30 days. */
  lateOrAbsentDays30: number;
  /** Last released performance rating as a fraction of the top of the scale (0..1); null when none. */
  lastRatingShare: number | null;
  /** Recognitions received in the last 180 days. */
  recognitions180: number;
  /** Helpdesk cases (not confidential) raised about pay in the last 90 days. */
  payQueries90: number;
}

export interface RiskFactor { key: string; label: string; points: number; evidence: string }
export interface AttritionResult { score: number; band: 'low' | 'medium' | 'high'; factors: RiskFactor[] }

/** Rule weights. Documented in docs/phases/phase-8.md; the total is capped at 100. */
export const ATTRITION_RULES = {
  earlyTenure: 15, // first year
  stalled: 20, // no job change in 3+ years (tenure 3+ years)
  leaveSpike: 20, // unplanned leave at least doubled and 4+ days
  attendance: 15, // 3+ late or absent days in 30
  lowRating: 20, // bottom 40% of the scale
  noRecognition: 10, // none in 180 days (tenure 6+ months)
  payQueries: 10, // 2+ pay queries in 90 days
} as const;

export function attritionRisk(i: AttritionInput): AttritionResult {
  const f: RiskFactor[] = [];
  const W = ATTRITION_RULES;
  if (i.tenureMonths < 12) f.push({ key: 'early_tenure', label: 'In their first year', points: W.earlyTenure, evidence: `${i.tenureMonths} months since joining` });
  const sinceChange = i.monthsSinceJobChange ?? i.tenureMonths;
  if (i.tenureMonths >= 36 && sinceChange >= 36) {
    f.push({ key: 'stalled', label: 'No promotion or move in three years', points: W.stalled, evidence: i.monthsSinceJobChange === null ? `No job change in ${i.tenureMonths} months` : `Last job change ${sinceChange} months ago` });
  }
  if (i.unplannedLeaveRecent >= 4 && i.unplannedLeaveRecent >= 2 * Math.max(i.unplannedLeavePrior, 1)) {
    f.push({ key: 'leave_spike', label: 'More unplanned leave than before', points: W.leaveSpike, evidence: `${i.unplannedLeaveRecent} days in the last 90 days, ${i.unplannedLeavePrior} in the 90 days before` });
  }
  if (i.lateOrAbsentDays30 >= 3) f.push({ key: 'attendance', label: 'Late or absent more often', points: W.attendance, evidence: `${i.lateOrAbsentDays30} days late or absent in the last 30 days` });
  if (i.lastRatingShare !== null && i.lastRatingShare <= 0.4) f.push({ key: 'low_rating', label: 'Low last performance rating', points: W.lowRating, evidence: `Rated in the bottom ${Math.round(i.lastRatingShare * 100)}% of the scale` });
  if (i.tenureMonths >= 6 && i.recognitions180 === 0) f.push({ key: 'no_recognition', label: 'No recognition in six months', points: W.noRecognition, evidence: 'No recognitions received in the last 180 days' });
  if (i.payQueries90 >= 2) f.push({ key: 'pay_queries', label: 'Repeated questions about pay', points: W.payQueries, evidence: `${i.payQueries90} pay questions to HR in the last 90 days` });
  f.sort((a, b) => b.points - a.points);
  const score = Math.min(100, f.reduce((s, x) => s + x.points, 0));
  return { score, band: score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low', factors: f };
}

// Payroll anomaly checks ---------------------------------------------------------------------------------------

export interface PayHistoryPoint { gross: string; net: string; components: string[] }
export interface PayCheckInput {
  employeeName: string;
  gross: string;
  net: string;
  lopDays: string;
  daysInPeriod: number;
  components: string[];
  /** Earlier finalised months for the same person, most recent first. */
  history: PayHistoryPoint[];
}
export interface PayAnomaly { code: string; severity: 'info' | 'warning' | 'danger'; message: string }

/** A percentage change, rounded to one decimal place, from minor units. */
function changePct(now: bigint, before: bigint): number {
  if (before === 0n) return now === 0n ? 0 : 100;
  return Math.round(Number(((now - before) * 1000n) / before)) / 10;
}

function median(xs: bigint[]): bigint {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

/** Threshold for a month-on-month change worth a second look. */
export const PAY_CHANGE_THRESHOLD_PCT = 20;

export function payrollAnomalies(i: PayCheckInput): PayAnomaly[] {
  const out: PayAnomaly[] = [];
  const gross = toMinor(i.gross);
  const net = toMinor(i.net);
  if (net < 0n) out.push({ code: 'negative_net', severity: 'danger', message: `Net pay is negative (${fromMinor(net)}). Deductions exceed earnings.` });
  else if (net === 0n && gross > 0n) out.push({ code: 'zero_net', severity: 'warning', message: 'Net pay is zero although there are earnings.' });
  if (gross === 0n) out.push({ code: 'zero_gross', severity: 'warning', message: 'No earnings this month.' });
  const lop = Number(i.lopDays);
  if (lop > i.daysInPeriod / 2) out.push({ code: 'high_lop', severity: 'warning', message: `${i.lopDays} unpaid days out of ${i.daysInPeriod}.` });
  if (!i.history.length) {
    out.push({ code: 'no_history', severity: 'info', message: 'First month in CREW payroll, so there is nothing to compare with.' });
    return out;
  }
  const baseGross = median(i.history.slice(0, 3).map((h) => toMinor(h.gross)));
  const baseNet = median(i.history.slice(0, 3).map((h) => toMinor(h.net)));
  const g = changePct(gross, baseGross);
  const n = changePct(net, baseNet);
  if (Math.abs(g) >= PAY_CHANGE_THRESHOLD_PCT) out.push({ code: 'gross_change', severity: 'warning', message: `Gross pay is ${g > 0 ? 'up' : 'down'} ${Math.abs(g)}% on the usual ${fromMinor(baseGross)}.` });
  if (Math.abs(n) >= PAY_CHANGE_THRESHOLD_PCT) out.push({ code: 'net_change', severity: 'warning', message: `Net pay is ${n > 0 ? 'up' : 'down'} ${Math.abs(n)}% on the usual ${fromMinor(baseNet)}.` });
  // Statistical check over a longer history: a change far outside this person's usual month-to-month variation.
  if (i.history.length >= 4) {
    const nets = i.history.slice(0, 6).map((h) => Number(toMinor(h.net)));
    const mean = nets.reduce((s, x) => s + x, 0) / nets.length;
    const sd = Math.sqrt(nets.reduce((s, x) => s + (x - mean) ** 2, 0) / nets.length);
    const z = sd > 0 ? (Number(net) - mean) / sd : 0;
    if (Math.abs(z) >= 3 && Math.abs(n) < PAY_CHANGE_THRESHOLD_PCT) out.push({ code: 'net_outlier', severity: 'info', message: `Net pay is unusual for this person (${Math.abs(z).toFixed(1)} standard deviations from their last ${nets.length} months).` });
  }
  const last = new Set(i.history[0]!.components);
  const added = i.components.filter((c) => !last.has(c));
  const removed = [...last].filter((c) => !i.components.includes(c));
  if (added.length) out.push({ code: 'component_added', severity: 'info', message: `New this month: ${added.join(', ')}.` });
  if (removed.length) out.push({ code: 'component_removed', severity: 'info', message: `Not paid this month but paid last month: ${removed.join(', ')}.` });
  return out;
}
