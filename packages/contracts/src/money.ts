/**
 * Exact money arithmetic. Amounts are integer paise (or cents) held in BigInt, so no floating point error can
 * reach a salary, a deduction or a total. The API and database exchange amounts as decimal strings ("1234.50").
 *
 * Rounding is always explicit:
 * - 'half_up'   rounds halves away from zero (most component and statutory amounts),
 * - 'up'        rounds any fraction up (ESI contributions are rounded up to the next rupee),
 * - 'down'      truncates towards zero.
 */

export type Minor = bigint;
export type Rounding = 'half_up' | 'up' | 'down';

const MONEY = /^-?\d{1,13}(\.\d{1,2})?$/;
const RATE = /^\d{1,6}(\.\d{1,6})?$/;

/** "1234.5" -> 123450n */
export function toMinor(amount: string | number): Minor {
  const s = typeof amount === 'number' ? String(amount) : amount.trim();
  if (!MONEY.test(s)) throw new Error(`Invalid amount: ${s}`);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = BigInt(i!) * 100n + BigInt(f.padEnd(2, '0'));
  return neg ? -v : v;
}

/** 123450n -> "1234.50" */
export function fromMinor(m: Minor): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Divides num by den (den > 0) with the given rounding. */
export function divRound(num: bigint, den: bigint, rounding: Rounding = 'half_up'): bigint {
  if (den <= 0n) throw new Error('Division by a non-positive number');
  const neg = num < 0n;
  const a = neg ? -num : num;
  let q = a / den;
  const r = a % den;
  if (r !== 0n) {
    if (rounding === 'up') q += 1n;
    else if (rounding === 'half_up' && 2n * r >= den) q += 1n;
  }
  return neg ? -q : q;
}

/** A decimal rate such as "0.12" or "8.33" (a percentage when `percent`) as an exact fraction. */
export function rate(r: string, percent = false): { num: bigint; den: bigint } {
  const s = r.trim();
  if (!RATE.test(s)) throw new Error(`Invalid rate: ${s}`);
  const [i, f = ''] = s.split('.');
  const den = 10n ** BigInt(f.length) * (percent ? 100n : 1n);
  return { num: BigInt(i! + f), den };
}

/** amount x rate, rounded to whole minor units. */
export function applyRate(amount: Minor, r: string, opts: { percent?: boolean; rounding?: Rounding } = {}): Minor {
  const { num, den } = rate(r, opts.percent);
  return divRound(amount * num, den, opts.rounding ?? 'half_up');
}

/** amount x num / den (for proration by days), rounded to whole minor units. */
export const prorate = (amount: Minor, num: bigint, den: bigint, rounding: Rounding = 'half_up'): Minor => divRound(amount * num, den, rounding);

/** Rounds to whole major units (rupees). */
export const toWhole = (m: Minor, rounding: Rounding = 'half_up'): Minor => divRound(m, 100n, rounding) * 100n;

export const min = (a: Minor, b: Minor) => (a < b ? a : b);
export const max = (a: Minor, b: Minor) => (a > b ? a : b);
export const sum = (xs: Minor[]) => xs.reduce((s, x) => s + x, 0n);

/** Indian (12,34,567.00) or Western (1,234,567.00) grouping, for explanations and documents. */
export function formatMoney(m: Minor, currency: string): string {
  const [whole, frac] = fromMinor(m < 0n ? -m : m).split('.');
  const grouped = currency === 'INR' ? whole!.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,') : whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${m < 0n ? '-' : ''}${currency} ${grouped}.${frac}`;
}
