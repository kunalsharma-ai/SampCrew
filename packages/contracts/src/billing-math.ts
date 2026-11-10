/**
 * Subscription billing arithmetic shared by the API, the Web Portal and the Console: billing periods, proration,
 * discounts and Indian GST. Amounts are decimal strings ("1234.50"); all arithmetic is done in integer minor units
 * (paise or cents) with explicit rounding, as in money.ts.
 */
import { applyRate, divRound, fromMinor, toMinor } from './money';

export type BillingCycle = 'monthly' | 'annual';

const DAY = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whole days from a to b (b later is positive). Dates are 'YYYY-MM-DD'. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b) - parse(a)) / DAY);
}

export function addDays(date: string, days: number): string {
  return iso(parse(date) + days * DAY);
}

/**
 * The same day one month (or one year) later. A day the next month does not have becomes its last day, so a period
 * that starts on 31 January ends on 28 (or 29) February.
 */
export function addPeriod(date: string, cycle: BillingCycle, count = 1): string {
  const d = new Date(parse(date));
  const months = cycle === 'annual' ? 12 * count : count;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return iso(target.getTime());
}

/** What one billing period of a plan costs: seats x price per seat per month x months in the period. */
export function periodAmount(unitPerSeatMonth: string, seats: number, cycle: BillingCycle): string {
  return fromMinor(toMinor(unitPerSeatMonth) * BigInt(seats) * (cycle === 'annual' ? 12n : 1n));
}

/** The monthly value of a period amount (for MRR). Annual amounts are divided by 12, rounded to the minor unit. */
export function monthlyValue(amount: string, cycle: BillingCycle): string {
  return cycle === 'annual' ? fromMinor(divRound(toMinor(amount), 12n)) : fromMinor(toMinor(amount));
}

/**
 * The share of a period amount for the days left: amount x (days from `today` to the period end) / (days in the
 * period). Nothing is left on or after the period end; the whole amount before the period starts.
 */
export function prorate(amount: string, periodStart: string, periodEnd: string, today: string): string {
  const total = daysBetween(periodStart, periodEnd);
  if (total <= 0) return '0.00';
  const left = Math.min(total, Math.max(0, daysBetween(today, periodEnd)));
  return fromMinor(divRound(toMinor(amount) * BigInt(left), BigInt(total)));
}

export interface UpgradeQuote {
  /** Charged now: the new plan for the days left, less the unused part of what was paid. Never negative. */
  dueNow: string;
  /** The unused part of the current period, credited against the new plan. */
  credit: string;
  /** The new plan's price for the days left (or for a whole new period when the cycle changes). */
  charge: string;
  /** The period after the change. A cycle change starts a new period today. */
  periodStart: string;
  periodEnd: string;
}

/**
 * Proration for a change that applies immediately. Keeping the cycle keeps the current period: the difference is
 * charged for the days left. Changing the cycle starts a new period today: the whole new period is charged, less the
 * unused part of the current one.
 */
export function upgradeQuote(input: {
  currentAmount: string;
  newAmount: string;
  periodStart: string;
  periodEnd: string;
  today: string;
  currentCycle: BillingCycle;
  newCycle: BillingCycle;
  /** Nothing was paid for the current period (trial, or a period not invoiced): no credit is given. */
  noCredit?: boolean;
}): UpgradeQuote {
  const credit = input.noCredit ? '0.00' : prorate(input.currentAmount, input.periodStart, input.periodEnd, input.today);
  if (input.currentCycle !== input.newCycle || input.noCredit) {
    const due = toMinor(input.newAmount) - toMinor(credit);
    return {
      dueNow: fromMinor(due > 0n ? due : 0n), credit, charge: fromMinor(toMinor(input.newAmount)),
      periodStart: input.today, periodEnd: addPeriod(input.today, input.newCycle),
    };
  }
  const charge = prorate(input.newAmount, input.periodStart, input.periodEnd, input.today);
  const due = toMinor(charge) - toMinor(credit);
  return { dueNow: fromMinor(due > 0n ? due : 0n), credit, charge, periodStart: input.periodStart, periodEnd: input.periodEnd };
}

/** A percentage of an amount, rounded half up, as a positive decimal string. */
export function percentOf(amount: string, percent: string): string {
  return fromMinor(applyRate(toMinor(amount), percent, { percent: true }));
}

export function sum(amounts: string[]): string {
  return fromMinor(amounts.reduce((a, b) => a + toMinor(b), 0n));
}

export function minus(a: string, b: string): string {
  return fromMinor(toMinor(a) - toMinor(b));
}

export function times(amount: string, quantity: number): string {
  return fromMinor(toMinor(amount) * BigInt(quantity));
}

export function isPositive(amount: string): boolean {
  return toMinor(amount) > 0n;
}

/** Amount in the smallest currency unit, as payment gateways expect (paise, cents). */
export function minorUnits(amount: string): number {
  return Number(toMinor(amount));
}

// ---------------------------------------------------------------------------------------------------------------
// Tax: Indian GST (CGST + SGST within a state, IGST between states, zero-rated exports), or one flat rate elsewhere
// ---------------------------------------------------------------------------------------------------------------

export interface TaxParty {
  countryCode: string;
  /** Two-digit GST state code (27 = Maharashtra). */
  stateCode: string | null;
  gstin: string | null;
}

export interface TaxSettings {
  /** The GST rate for SaaS (SAC 998314), 18 by default. */
  gstRate: string;
  /** Services to customers outside India are zero-rated under a Letter of Undertaking (no IGST charged). */
  exportZeroRated: boolean;
  /** For a seller outside India, or without a GSTIN: one tax at this rate (0 for none). */
  otherTaxRate: string;
  otherTaxLabel: string;
}

export interface TaxLine { code: 'cgst' | 'sgst' | 'igst' | 'tax'; label: string; rate: string; amount: string }

export interface TaxResult {
  lines: TaxLine[];
  total: string;
  /** Where the supply is made, for the invoice (state name and code in India, else the country). */
  placeOfSupply: string;
  /** Text the invoice must carry, such as the export declaration. */
  note: string | null;
}

/** GST state and union territory codes. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

/** GSTIN: state code, PAN, entity number, Z, check character. The first two digits are the state code. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function taxFor(subtotal: string, seller: TaxParty, buyer: TaxParty, s: TaxSettings): TaxResult {
  const base = toMinor(subtotal);
  const indianSeller = seller.countryCode === 'IN' && Boolean(seller.gstin);
  if (!indianSeller) {
    const amount = toMinor(s.otherTaxRate) > 0n ? applyRate(base, s.otherTaxRate, { percent: true }) : 0n;
    const lines: TaxLine[] = amount > 0n ? [{ code: 'tax', label: s.otherTaxLabel || 'Tax', rate: s.otherTaxRate, amount: fromMinor(amount) }] : [];
    return { lines, total: fromMinor(amount), placeOfSupply: buyer.countryCode, note: null };
  }
  // A buyer's GSTIN names their state; otherwise the state in their billing details.
  const buyerState = buyer.gstin ? buyer.gstin.slice(0, 2) : buyer.stateCode;
  const sellerState = seller.gstin!.slice(0, 2);
  if (buyer.countryCode !== 'IN') {
    if (s.exportZeroRated) {
      return { lines: [{ code: 'igst', label: 'IGST', rate: '0', amount: '0.00' }], total: '0.00', placeOfSupply: `Outside India (${buyer.countryCode})`, note: 'Supply meant for export of services under a Letter of Undertaking without payment of IGST.' };
    }
    const igst = applyRate(base, s.gstRate, { percent: true });
    return { lines: [{ code: 'igst', label: 'IGST', rate: s.gstRate, amount: fromMinor(igst) }], total: fromMinor(igst), placeOfSupply: `Outside India (${buyer.countryCode})`, note: null };
  }
  const place = buyerState && GST_STATES[buyerState] ? `${GST_STATES[buyerState]} (${buyerState})` : 'India';
  if (buyerState && buyerState === sellerState) {
    const half = rateHalf(s.gstRate);
    const each = applyRate(base, half, { percent: true });
    return {
      lines: [{ code: 'cgst', label: 'CGST', rate: half, amount: fromMinor(each) }, { code: 'sgst', label: 'SGST', rate: half, amount: fromMinor(each) }],
      total: fromMinor(each * 2n), placeOfSupply: place, note: null,
    };
  }
  const igst = applyRate(base, s.gstRate, { percent: true });
  return { lines: [{ code: 'igst', label: 'IGST', rate: s.gstRate, amount: fromMinor(igst) }], total: fromMinor(igst), placeOfSupply: place, note: null };
}

/** Half of a rate as a decimal string: "18" -> "9", "12.5" -> "6.25". */
function rateHalf(r: string): string {
  const [i, f = ''] = r.split('.');
  const scaled = BigInt(i! + f.padEnd(4, '0').slice(0, 4)) * 10_000n / 2n; // 8 decimals
  const s = scaled.toString().padStart(9, '0');
  const out = `${s.slice(0, -8)}.${s.slice(-8)}`.replace(/\.?0+$/, '');
  return out.startsWith('.') ? `0${out}` : out || '0';
}

/** The Indian financial year an invoice date falls in, as used in invoice numbers: 2026-27. */
export function financialYear(date: string): string {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Usage against a limit, as a whole percentage (null when unlimited or not limited). */
export function usagePercent(used: number, limit: number | undefined): number | null {
  if (limit === undefined || limit < 0) return null;
  if (limit === 0) return used > 0 ? 100 : 0;
  return Math.floor((used * 100) / limit);
}
