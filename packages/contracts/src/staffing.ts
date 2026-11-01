import { z } from 'zod';
import { applyRate, divRound, fromMinor, rate, toMinor, type Minor } from './money';
import { email } from './schemas/common';
import { isoDate } from './schemas/people';

/**
 * Staffing bids: priced proposals to supply people to a client (contract staffing, managed teams, recruitment
 * drives). A bid has one line per role; each line has the monthly pay per person (what the people cost before
 * on-costs) and the monthly bill rate per person (what the client pays). Margin is measured on revenue.
 */

const money = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Use an amount such as 45000 or 45000.50');
const positiveMoney = money.refine((v) => Number(v) > 0, 'Must be more than zero');
const percent = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use a percentage such as 13 or 8.33');
const optionalText = (max: number) => z.string().trim().max(max).optional();
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code such as INR');

export const BID_STATUSES = ['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'won', 'lost', 'withdrawn'] as const;
export type BidStatus = (typeof BID_STATUSES)[number];
export const BID_MODES = ['quick', 'advanced'] as const;
export const BID_OUTCOMES = ['won', 'lost', 'withdrawn'] as const;
/** Editing is allowed until the bid is decided; editing an approved or sent bid sends it back for approval. */
export const BID_EDITABLE: readonly BidStatus[] = ['draft', 'rejected', 'approved', 'sent'];

// Clients ----------------------------------------------------------------------------------------------

export const clientInput = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: optionalText(200),
  industry: optionalText(80),
  contactName: optionalText(120),
  contactEmail: email.optional(),
  contactPhone: optionalText(30),
  address: optionalText(500),
  currency: currency.default('INR'),
  notes: optionalText(1000),
}).strict();
export type ClientInput = z.infer<typeof clientInput>;

// Templates --------------------------------------------------------------------------------------------

export const bidTemplateInput = z.object({
  name: z.string().trim().min(2).max(80),
  coverNote: z.string().trim().max(4000).default(''),
  terms: z.string().trim().max(4000).default(''),
  validityDays: z.number().int().min(1).max(180).default(30),
  onCostPct: percent.default('13'),
  overheadPct: percent.default('5'),
  targetMarginPct: percent.refine((v) => Number(v) < 100, 'Must be below 100%').default('18'),
  isDefault: z.boolean().default(false),
}).strict();
export type BidTemplateInput = z.infer<typeof bidTemplateInput>;

// Bids -------------------------------------------------------------------------------------------------

export const bidLineInput = z.object({
  roleTitle: z.string().trim().min(2).max(120),
  designationId: z.uuid().nullable().optional(),
  headcount: z.number().int().min(1).max(10000),
  location: optionalText(120),
  /** Monthly pay per person (gross cost to company before on-costs and overhead). */
  payMonthly: positiveMoney,
  /** Monthly bill rate per person. Left out, it is worked out from the target margin. */
  billMonthly: positiveMoney.optional(),
  notes: optionalText(300),
}).strict();
export type BidLineInput = z.infer<typeof bidLineInput>;

export const bidInput = z.object({
  clientId: z.uuid(),
  legalEntityId: z.uuid(),
  title: z.string().trim().min(3).max(160),
  mode: z.enum(BID_MODES).default('advanced'),
  currency: currency.default('INR'),
  startDate: isoDate,
  durationMonths: z.number().int().min(1).max(120),
  /** Employer costs on top of pay: statutory contributions, insurance, benefits. */
  onCostPct: percent,
  /** Delivery overhead: account management, payroll processing, recruitment. */
  overheadPct: percent,
  targetMarginPct: percent.refine((v) => Number(v) < 100, 'Must be below 100%'),
  templateId: z.uuid().nullable().optional(),
  coverNote: z.string().trim().max(4000).default(''),
  terms: z.string().trim().max(4000).default(''),
  validUntil: isoDate.optional(),
  lines: z.array(bidLineInput).min(1, 'Add at least one role').max(50),
}).strict();
export type BidInput = z.infer<typeof bidInput>;

export const bidListQuery = z.object({
  status: z.enum(BID_STATUSES).optional(),
  clientId: z.uuid().optional(),
  q: z.string().trim().max(120).optional(),
});

export const bidSendInput = z.object({
  to: email,
  cc: z.array(email).max(5).default([]),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(1).max(4000),
  /** When to send. Left out, it goes now. */
  sendAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type BidSendInput = z.infer<typeof bidSendInput>;

export const bidOutcomeInput = z.object({
  outcome: z.enum(BID_OUTCOMES),
  reason: optionalText(500),
}).strict();

// Pricing ----------------------------------------------------------------------------------------------

export interface PricedLine {
  roleTitle: string;
  headcount: number;
  location: string | null;
  payMonthly: string;
  /** Pay plus on-costs plus overhead, per person per month. */
  loadedCostMonthly: string;
  billMonthly: string;
  /** True when the bill rate was worked out from the target margin. */
  billDerived: boolean;
  monthlyRevenue: string;
  monthlyCost: string;
  monthlyMargin: string;
  marginPct: string;
  markupPct: string;
  belowTarget: boolean;
}

export interface BidPricing {
  lines: PricedLine[];
  headcount: number;
  monthlyRevenue: string;
  monthlyCost: string;
  monthlyMargin: string;
  contractRevenue: string;
  contractCost: string;
  contractMargin: string;
  marginPct: string;
  belowTarget: boolean;
  lossMaking: boolean;
}

/** a / b as a percentage with two decimals ("18.25"); 0 when b is 0. */
function pct(a: Minor, b: Minor): string {
  if (b === 0n) return '0.00';
  const bp = divRound(a * 10000n, b);
  const neg = bp < 0n;
  const v = neg ? -bp : bp;
  return `${neg ? '-' : ''}${v / 100n}.${String(v % 100n).padStart(2, '0')}`;
}

/** Compares two "12.34"-style percentages exactly. */
function pctLess(a: string, b: string): boolean {
  return toMinor(a) < toMinor(b);
}

/**
 * Prices a bid exactly (integer minor units, no floating point).
 * - Loaded cost per person = pay + pay x on-cost% + pay x overhead%.
 * - A derived bill rate is loaded cost / (1 - target margin), rounded up to a whole currency unit so the margin
 *   is never below target.
 * - Margin % = (revenue - cost) / revenue; markup % = (bill - loaded cost) / loaded cost.
 */
export function priceBid(b: Pick<BidInput, 'lines' | 'onCostPct' | 'overheadPct' | 'targetMarginPct' | 'durationMonths'>): BidPricing {
  const target = rate(b.targetMarginPct, true);
  if (target.num >= target.den) throw new Error('Target margin must be below 100%');
  let rev = 0n;
  let cost = 0n;
  let heads = 0;
  const lines = b.lines.map((l): PricedLine => {
    const pay = toMinor(l.payMonthly);
    const loaded = pay + applyRate(pay, b.onCostPct, { percent: true }) + applyRate(pay, b.overheadPct, { percent: true });
    const derived = !l.billMonthly;
    const bill = derived ? divRound(loaded * target.den, (target.den - target.num) * 100n, 'up') * 100n : toMinor(l.billMonthly!);
    const hc = BigInt(l.headcount);
    const lr = bill * hc;
    const lc = loaded * hc;
    rev += lr;
    cost += lc;
    heads += l.headcount;
    const marginPct = pct(lr - lc, lr);
    return {
      roleTitle: l.roleTitle,
      headcount: l.headcount,
      location: l.location ?? null,
      payMonthly: fromMinor(pay),
      loadedCostMonthly: fromMinor(loaded),
      billMonthly: fromMinor(bill),
      billDerived: derived,
      monthlyRevenue: fromMinor(lr),
      monthlyCost: fromMinor(lc),
      monthlyMargin: fromMinor(lr - lc),
      marginPct,
      markupPct: pct(bill - loaded, loaded),
      belowTarget: pctLess(marginPct, b.targetMarginPct),
    };
  });
  const months = BigInt(b.durationMonths);
  const marginPct = pct(rev - cost, rev);
  return {
    lines,
    headcount: heads,
    monthlyRevenue: fromMinor(rev),
    monthlyCost: fromMinor(cost),
    monthlyMargin: fromMinor(rev - cost),
    contractRevenue: fromMinor(rev * months),
    contractCost: fromMinor(cost * months),
    contractMargin: fromMinor((rev - cost) * months),
    marginPct,
    belowTarget: pctLess(marginPct, b.targetMarginPct),
    lossMaking: rev < cost,
  };
}

/** "1234567.50" -> "12,34,567.50" (Indian grouping for INR) or "1,234,567.50". */
export function formatAmount(amount: string, currency = 'INR'): string {
  const neg = amount.startsWith('-');
  const [i, f = '00'] = amount.replace('-', '').split('.');
  let int = i!;
  if (currency === 'INR' && int.length > 3) {
    const last3 = int.slice(-3);
    const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    int = `${rest},${last3}`;
  } else {
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return `${neg ? '-' : ''}${int}.${f.padEnd(2, '0')}`;
}
