/**
 * Pure leave arithmetic. Quantities are handled as integer hundredths of a day so that no floating point
 * error ever reaches a balance; the API and database exchange them as decimal strings ("1.50").
 *
 * Rules (documented in docs/phases/phase-2.md):
 * - The leave year is the calendar year. A request must fall inside one leave year.
 * - Working days exclude the calendar's weekly offs and its non-optional holidays.
 * - A half day on a non-working day counts as zero.
 * - Monthly accrual credits entitlement / 12 on the first of each month; the month someone joins or leaves is
 *   prorated by calendar days employed in that month.
 * - Up-front accrual credits the full entitlement on 1 January, or on the joining date prorated by calendar
 *   days remaining in the year.
 * - Rounding 'half_day' rounds each credit to the nearest 0.5 day (halves round up); 'none' keeps 2 decimals.
 * - At year end the positive balance carries forward up to the policy cap and the rest lapses. Negative
 *   balances carry forward in full so they are recovered from the next year.
 */

export type Hundredths = number;

export const toH = (days: string | number): Hundredths => {
  const s = String(days).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid day quantity: ${s}`);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = Number(i) * 100 + Number(f.padEnd(2, '0'));
  return neg ? -v : v;
};

export const fromH = (h: Hundredths): string => {
  const neg = h < 0;
  const a = Math.abs(h);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

/** Rounds a rational quantity num/den (in hundredths) to whole hundredths, halves away from zero. */
const divRound = (num: number, den: number): Hundredths => {
  const q = Math.floor(Math.abs(num) / den);
  const r = Math.abs(num) % den;
  const v = 2 * r >= den ? q + 1 : q;
  return num < 0 ? -v : v;
};

export function applyRounding(h: Hundredths, rounding: 'none' | 'half_day'): Hundredths {
  if (rounding === 'none') return h;
  return divRound(h, 50) * 50;
}

// ---- Dates (UTC calendar arithmetic on YYYY-MM-DD strings, no time zones involved) ----

const parse = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y!, m! - 1, day!);
};
const fmt = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;
export const addDays = (d: string, n: number) => fmt(parse(d) + n * DAY);
export const daysBetweenInclusive = (a: string, b: string) => Math.round((parse(b) - parse(a)) / DAY) + 1;
export const dayOfWeek = (d: string) => new Date(parse(d)).getUTCDay();
export const yearOf = (d: string) => Number(d.slice(0, 4));
const daysInYear = (y: number) => daysBetweenInclusive(`${y}-01-01`, `${y}-12-31`);
const monthStart = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}-01`;
const monthEnd = (y: number, m: number) => fmt(Date.UTC(y, m, 0));
const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);

export interface WorkCalendar {
  weeklyOffs: readonly number[];
  /** Non-optional holiday dates. */
  holidays: ReadonlySet<string>;
}

export const isWorkingDay = (d: string, cal: WorkCalendar) => !cal.weeklyOffs.includes(dayOfWeek(d)) && !cal.holidays.has(d);

/** Number of leave days a request consumes, in hundredths. */
export function countLeaveDays(
  req: { startDate: string; endDate: string; startHalf: 'full' | 'second_half'; endHalf: 'full' | 'first_half' },
  cal: WorkCalendar,
): Hundredths {
  if (req.endDate < req.startDate) throw new Error('end before start');
  let total = 0;
  for (let d = req.startDate; d <= req.endDate; d = addDays(d, 1)) {
    if (!isWorkingDay(d, cal)) continue;
    const single = req.startDate === req.endDate;
    const half = (d === req.startDate && req.startHalf === 'second_half') || (d === req.endDate && req.endHalf === 'first_half');
    total += single ? (req.startHalf === 'full' && req.endHalf === 'full' ? 100 : 50) : half ? 50 : 100;
  }
  return total;
}

export interface AccrualPolicy {
  accrualMethod: 'annual_upfront' | 'monthly' | 'none';
  annualEntitlement: Hundredths;
  rounding: 'none' | 'half_day';
}

export interface Employment {
  dateOfJoining: string;
  /** Last working day if exiting or exited. */
  lastWorkingDay: string | null;
}

export interface AccrualCredit {
  key: string;
  effectiveOn: string;
  quantity: Hundredths;
}

/**
 * Credits due for the leave year containing `asOf`, up to and including `asOf`. Callers insert them with
 * the key as an idempotency key, so running this daily (or twice) never double-credits.
 */
export function accrualsDue(policy: AccrualPolicy, emp: Employment, asOf: string): AccrualCredit[] {
  if (policy.accrualMethod === 'none' || policy.annualEntitlement <= 0) return [];
  const year = yearOf(asOf);
  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;
  const from = maxDate(emp.dateOfJoining, yStart);
  const to = emp.lastWorkingDay ? minDate(emp.lastWorkingDay, yEnd) : yEnd;
  if (from > to || from > asOf) return [];

  if (policy.accrualMethod === 'annual_upfront') {
    const employed = daysBetweenInclusive(from, yEnd);
    const raw = employed === daysInYear(year) ? policy.annualEntitlement : divRound(policy.annualEntitlement * employed, daysInYear(year));
    const q = applyRounding(raw, policy.rounding);
    return q > 0 ? [{ key: `Y${year}`, effectiveOn: from, quantity: q }] : [];
  }

  const credits: AccrualCredit[] = [];
  const lastMonth = Number(asOf.slice(5, 7));
  for (let m = 1; m <= lastMonth; m++) {
    const ms = monthStart(year, m);
    const me = monthEnd(year, m);
    const a = maxDate(ms, from);
    const b = minDate(me, to);
    if (a > b) continue;
    const employed = daysBetweenInclusive(a, b);
    const full = daysBetweenInclusive(ms, me);
    const raw = divRound(policy.annualEntitlement * employed, 12 * full);
    const q = applyRounding(raw, policy.rounding);
    if (q > 0) credits.push({ key: `M${year}-${String(m).padStart(2, '0')}`, effectiveOn: a, quantity: q });
  }
  return credits;
}

/** Year-end split of a closing balance into what carries forward and what lapses. */
export function yearEnd(balance: Hundredths, carryForwardMax: Hundredths): { carry: Hundredths; lapse: Hundredths } {
  if (balance <= 0) return { carry: balance, lapse: 0 };
  const carry = Math.min(balance, carryForwardMax);
  return { carry, lapse: balance - carry };
}
