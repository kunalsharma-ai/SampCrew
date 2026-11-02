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

/** A charge made once rather than monthly: a recruitment drive, onboarding, equipment, a setup fee. */
export const bidFeeInput = z.object({
  label: z.string().trim().min(2, 'Name the fee').max(120),
  /** What the client pays, once. */
  amount: positiveMoney,
  /** What it costs to deliver; left out, nothing. */
  cost: money.optional(),
  /** When it is invoiced. */
  billing: z.enum(['on_signing', 'on_start', 'on_delivery']).default('on_start'),
}).strict();
export type BidFeeInput = z.infer<typeof bidFeeInput>;
export const FEE_BILLING_LABEL = { on_signing: 'On signing', on_start: 'On start', on_delivery: 'On delivery' } as const;

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
  fees: z.array(bidFeeInput).max(20, 'Up to 20 fees').default([]),
  /** The rate card the bill rates are checked against. */
  rateCardId: z.uuid().nullable().optional(),
}).strict();
export type BidInput = z.infer<typeof bidInput>;

// Rate cards -------------------------------------------------------------------------------------------

/**
 * Standard monthly pay and bill rates per role, for every client or for one. A bid that uses a card fills its rates
 * from it, and a bill rate below the card is flagged for Finance.
 */
export const rateCardInput = z.object({
  name: z.string().trim().min(2).max(80),
  /** Left out, the card is for any client. */
  clientId: z.uuid().nullable().default(null),
  currency: currency.default('INR'),
  notes: z.string().trim().max(1000).default(''),
  lines: z.array(z.object({
    roleTitle: z.string().trim().min(2).max(120),
    payMonthly: positiveMoney,
    billMonthly: positiveMoney,
  }).strict()).min(1, 'Add at least one role').max(100),
}).strict().refine((v) => new Set(v.lines.map((l) => l.roleTitle.toLowerCase())).size === v.lines.length, { message: 'Each role once', path: ['lines'] });
export type RateCardInput = z.infer<typeof rateCardInput>;
export interface RateCard extends RateCardInput { id: string; clientName: string | null; updatedAt: string }

/** The card's rates for a role, matched on the title ignoring case and spacing. */
export function rateFor(card: Pick<RateCardInput, 'lines'> | null | undefined, roleTitle: string) {
  const key = roleTitle.trim().replace(/\s+/g, ' ').toLowerCase();
  return card?.lines.find((l) => l.roleTitle.trim().replace(/\s+/g, ' ').toLowerCase() === key) ?? null;
}

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
  /** The rate card's bill rate for this role, when the bid uses a card that lists it. */
  rateCardBill: string | null;
  /** Billed below the rate card. */
  belowRateCard: boolean;
}

export interface PricedFee { label: string; amount: string; cost: string; margin: string; billing: BidFeeInput['billing'] }

export interface BidPricing {
  lines: PricedLine[];
  fees: PricedFee[];
  /** One-off fees in total (included in the contract figures, not in the monthly ones). */
  feesTotal: string;
  feesCost: string;
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
  /** Lines billed below the rate card. */
  belowRateCard: number;
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
export function priceBid(
  b: Pick<BidInput, 'lines' | 'onCostPct' | 'overheadPct' | 'targetMarginPct' | 'durationMonths'> & { fees?: BidFeeInput[] },
  card?: Pick<RateCardInput, 'lines'> | null,
): BidPricing {
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
    const std = rateFor(card, l.roleTitle);
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
      rateCardBill: std ? fromMinor(toMinor(std.billMonthly)) : null,
      belowRateCard: !!std && bill < toMinor(std.billMonthly),
    };
  });
  const months = BigInt(b.durationMonths);
  let feeRev = 0n;
  let feeCost = 0n;
  const fees = (b.fees ?? []).map((f): PricedFee => {
    const a = toMinor(f.amount);
    const c = toMinor(f.cost || '0');
    feeRev += a;
    feeCost += c;
    return { label: f.label, amount: fromMinor(a), cost: fromMinor(c), margin: fromMinor(a - c), billing: f.billing ?? 'on_start' };
  });
  const cRev = rev * months + feeRev;
  const cCost = cost * months + feeCost;
  // Over the whole contract, so one-off fees count; with no fees this equals the monthly margin.
  const marginPct = pct(cRev - cCost, cRev);
  return {
    lines,
    fees,
    feesTotal: fromMinor(feeRev),
    feesCost: fromMinor(feeCost),
    headcount: heads,
    monthlyRevenue: fromMinor(rev),
    monthlyCost: fromMinor(cost),
    monthlyMargin: fromMinor(rev - cost),
    contractRevenue: fromMinor(cRev),
    contractCost: fromMinor(cCost),
    contractMargin: fromMinor(cRev - cCost),
    marginPct,
    belowTarget: pctLess(marginPct, b.targetMarginPct),
    lossMaking: cRev < cCost,
    belowRateCard: lines.filter((l) => l.belowRateCard).length,
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

// Online acceptance ------------------------------------------------------------------------------------

/** Accepting a proposal: who signs, and a typed signature that must match their name. */
export const proposalAcceptInput = z.object({
  signerName: z.string().trim().min(2).max(120),
  signerTitle: z.string().trim().min(2).max(120),
  signerEmail: email,
  signature: z.string().trim().min(2).max(120),
  authorised: z.literal(true, { error: 'Confirm that you may accept on behalf of the client' }),
}).strict().refine((v) => v.signature.toLowerCase().replace(/\s+/g, ' ') === v.signerName.toLowerCase().replace(/\s+/g, ' '), {
  message: 'Type your full name exactly as above to sign', path: ['signature'],
});
export type ProposalAcceptInput = z.infer<typeof proposalAcceptInput>;

export const proposalDeclineInput = z.object({
  signerName: z.string().trim().min(2).max(120),
  signerEmail: email,
  reason: z.string().trim().min(3, 'Tell us briefly why').max(1000),
}).strict();
export type ProposalDeclineInput = z.infer<typeof proposalDeclineInput>;

/** What the client sees on the acceptance page: roles, rates and totals, never costs or margins. */
export interface PublicProposal {
  /** open: can be accepted; closed: decided another way (marked won or lost by the team, or answered on another link). */
  status: 'open' | 'accepted' | 'declined' | 'expired' | 'replaced' | 'withdrawn' | 'closed';
  organisation: string;
  code: string;
  version: number;
  title: string;
  clientName: string;
  issuedOn: string;
  validUntil: string | null;
  expiresAt: string;
  currency: string;
  startDate: string;
  durationMonths: number;
  coverNote: string;
  terms: string;
  preparedBy: string;
  lines: { roleTitle: string; location: string | null; headcount: number; billMonthly: string; monthlyRevenue: string }[];
  headcount: number;
  monthlyRevenue: string;
  /** One-off fees, without what they cost us. */
  fees: { label: string; amount: string; billing: BidFeeInput['billing'] }[];
  feesTotal: string;
  contractRevenue: string;
  decision: { kind: 'accepted' | 'declined'; by: string; title: string | null; at: string; reason: string | null } | null;
}
