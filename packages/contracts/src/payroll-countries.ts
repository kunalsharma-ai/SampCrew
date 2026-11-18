/**
 * Statutory rules for countries other than India: a rules-based ("generic") scheme that any country can be
 * described with, and the calculation that turns it into payslip lines. India keeps its own scheme in
 * payroll-engine.ts (PF, ESI, professional tax, TDS), unchanged.
 *
 * A generic scheme has three parts, all stored per legal entity with an effective date:
 * - Contributions: social security, pension, insurance and levies. Each one is an employee rate and an employer
 *   rate on a monthly base (gross pay, or only the components marked as contribution wages), counted on the part
 *   of the base between a monthly threshold and a monthly ceiling. A contribution applies to everyone, or only to
 *   people enrolled in it (the salary's "enrolled" switch: nationals in the Gulf, CPF members, pension members).
 * - Income tax withheld by the employer: annual slabs on the projected taxable pay of the tax year, less an annual
 *   allowance, plus an optional levy on taxable income and a surcharge on the tax. This month's tax is what is still
 *   due for the year spread over the months left (the same cumulative method the India engine uses for TDS).
 * - Regional taxes: extra annual slabs per state, province or canton, matched to the region written on the
 *   employee's work location (US states, for example). A region without a table has no regional tax.
 *
 * The country packs in statutory-packs.ts are starting values only. A local payroll advisor must check every rate
 * and threshold for the period being paid; SampCrew does not certify them as current law.
 */
import { applyRate, divRound, formatMoney, fromMinor, max, min, type Minor, sum, toMinor, toWhole } from './money';

export interface TaxSlab { upTo: string | null; ratePercent: string }

export type LineKind = 'earning' | 'deduction' | 'employer' | 'reimbursement';
export interface PayLine { code: string; name: string; kind: LineKind; amount: string; taxable?: boolean; explanation: string }

export const CONTRIBUTION_BASES = ['gross', 'contribution_wages'] as const;
export const CONTRIBUTION_SCOPES = ['everyone', 'enrolled'] as const;
export const STATUTORY_ROUNDING = ['cent', 'whole'] as const;

export interface ContributionRule {
  /** 2 to 12 capital letters or digits. Payslip lines are CODE_EE (employee) and CODE_ER (employer). */
  code: string;
  name: string;
  employeeRatePercent: string;
  employerRatePercent: string;
  /** Gross pay of the month, or only components marked as contribution wages (Basic, for example). */
  base: (typeof CONTRIBUTION_BASES)[number];
  /** Monthly amount of the base that is not contributed on (a primary threshold). null = from zero. */
  threshold: string | null;
  /** Monthly cap on the base. null = no cap. */
  ceiling: string | null;
  /** No contribution at all when the month's base is below this. null = always. */
  eligibleFrom: string | null;
  appliesTo: (typeof CONTRIBUTION_SCOPES)[number];
  /** The employee's share is taken off taxable pay before income tax (a net pay pension, a 401(k)). */
  reducesTaxablePay: boolean;
}

export interface IncomeTaxRule {
  name: string;
  /** Annual amount taken off taxable pay before the slabs (a standard deduction). */
  allowance: string;
  /** Annual slabs on taxable pay after the allowance. The last one has no upper limit. */
  slabs: TaxSlab[];
  /** A levy on taxable pay (Australia's Medicare levy, for example). */
  levyPercent: string;
  /** A surcharge on the slab tax (a cess). */
  surchargePercent: string;
  /** Projected taxable pay above this is flagged for a manual check, with the note. */
  reviewAbove: string | null;
  reviewNote: string;
}

export interface RegionalTaxRule { name: string; allowance: string; slabs: TaxSlab[] }

export interface GenericStatutory {
  kind: 'generic';
  countryCode: string;
  /** Month the tax year starts, 1 to 12 (January = 1, April = 4, July = 7). */
  taxYearStartMonth: number;
  /** Round each contribution and tax to the cent, or to whole units of the currency. */
  rounding: (typeof STATUTORY_ROUNDING)[number];
  /** What the salary's "enrolled" switch means in this country (shown on the salary form). */
  enrolmentLabel: string;
  contributions: ContributionRule[];
  incomeTax: IncomeTaxRule | null;
  /** Keyed by the region written on the work location (for example "California"). */
  regionalTaxes: Record<string, RegionalTaxRule>;
  /** What this scheme does not calculate, for the person who reviews it. */
  notes: string;
}

export const isGenericStatutory = (s: unknown): s is GenericStatutory => typeof s === 'object' && s !== null && (s as { kind?: unknown }).kind === 'generic';

/** Tax on an annual taxable income, by slabs. */
export function slabTax(income: Minor, slabs: TaxSlab[]): Minor {
  let tax = 0n;
  let lower = 0n;
  for (const s of slabs) {
    const upper = s.upTo === null ? null : toMinor(s.upTo);
    if (income <= lower) break;
    const top = upper === null ? income : min(income, upper);
    tax += applyRate(top - lower, s.ratePercent, { percent: true });
    if (upper === null) break;
    lower = upper;
  }
  return tax;
}

/** The base a contribution is counted on: the part between the threshold and the ceiling. */
export function contributionBase(r: ContributionRule, base: Minor): Minor {
  if (r.eligibleFrom !== null && base < toMinor(r.eligibleFrom)) return 0n;
  const top = r.ceiling === null ? base : min(base, toMinor(r.ceiling));
  return max(0n, top - (r.threshold === null ? 0n : toMinor(r.threshold)));
}

const roundTo = (m: Minor, rounding: GenericStatutory['rounding']) => (rounding === 'whole' ? toWhole(m) : m);

/** Annual tax by an income tax or regional rule: allowance, slabs, levy and surcharge. */
export function annualGenericTax(projected: Minor, t: { allowance: string; slabs: TaxSlab[]; levyPercent?: string; surchargePercent?: string }, rounding: GenericStatutory['rounding']) {
  const taxable = max(0n, projected - toMinor(t.allowance));
  const slab = slabTax(taxable, t.slabs);
  const surcharge = t.surchargePercent ? applyRate(slab, t.surchargePercent, { percent: true }) : 0n;
  const levy = t.levyPercent ? applyRate(taxable, t.levyPercent, { percent: true }) : 0n;
  return { taxable, slab, surcharge, levy, tax: roundTo(slab + surcharge + levy, rounding) };
}

export interface GenericInput {
  settings: GenericStatutory;
  currency: string;
  /** This month's earned gross and contribution wages, and the contracted monthly amounts (for the rest of the year). */
  earned: Minor;
  contributionWages: Minor;
  contractedGross: Minor;
  contractedContributionWages: Minor;
  taxableNow: Minor;
  taxableRecurring: Minor;
  apply: { enrolled: boolean; incomeTax: boolean; regional: boolean; region: string | null };
  tax: { monthsRemaining: number; ytdTaxable: Minor; ytdTax: Minor; ytdRegionalTax: Minor };
}

export interface GenericOutput {
  lines: PayLine[];
  explanation: string[];
  warnings: string[];
  taxableNow: Minor;
  projected: Minor | null;
  annualTax: Minor | null;
  incomeTax: Minor;
  regionalTax: Minor;
}

/** Contributions, income tax and regional tax for one employee-month under a generic scheme. */
export function genericStatutory(i: GenericInput): GenericOutput {
  const s = i.settings;
  const fmt = (m: Minor) => formatMoney(m, i.currency);
  const lines: PayLine[] = [];
  const explanation: string[] = [];
  const warnings: string[] = [];
  let taxableNow = i.taxableNow;
  let taxableRecurring = i.taxableRecurring;

  for (const r of s.contributions) {
    if (r.appliesTo === 'enrolled' && !i.apply.enrolled) continue;
    const raw = r.base === 'gross' ? i.earned : i.contributionWages;
    const b = contributionBase(r, raw);
    const what = r.base === 'gross' ? 'gross pay' : 'contribution wages';
    if (b === 0n) {
      if (r.eligibleFrom !== null && raw < toMinor(r.eligibleFrom)) explanation.push(`No ${r.name}: ${what} ${fmt(raw)} is below ${fmt(toMinor(r.eligibleFrom))}.`);
      continue;
    }
    const range = [
      r.threshold !== null ? `above ${fmt(toMinor(r.threshold))}` : '',
      r.ceiling !== null && raw > toMinor(r.ceiling) ? `capped at ${fmt(toMinor(r.ceiling))}` : '',
    ].filter(Boolean).join(', ');
    const on = range ? `${fmt(b)} (${what} ${fmt(raw)}, ${range})` : `${what} ${fmt(b)}`;
    const ee = roundTo(applyRate(b, r.employeeRatePercent, { percent: true }), s.rounding);
    const er = roundTo(applyRate(b, r.employerRatePercent, { percent: true }), s.rounding);
    if (ee > 0n) {
      lines.push({ code: `${r.code}_EE`, name: r.name, kind: 'deduction', amount: fromMinor(ee), explanation: `${r.employeeRatePercent}% of ${on}${r.reducesTaxablePay ? '; taken off taxable pay' : ''}` });
      if (r.reducesTaxablePay) {
        taxableNow -= ee;
        const recurringBase = contributionBase(r, r.base === 'gross' ? i.contractedGross : i.contractedContributionWages);
        taxableRecurring -= roundTo(applyRate(recurringBase, r.employeeRatePercent, { percent: true }), s.rounding);
      }
    }
    if (er > 0n) lines.push({ code: `${r.code}_ER`, name: Number(r.employeeRatePercent) === 0 ? r.name : `${r.name} (employer)`, kind: 'employer', amount: fromMinor(er), explanation: `${r.employerRatePercent}% of ${on}` });
  }
  taxableNow = max(0n, taxableNow);
  taxableRecurring = max(0n, taxableRecurring);

  const months = BigInt(Math.max(1, i.tax.monthsRemaining));
  const projected = i.tax.ytdTaxable + taxableNow + taxableRecurring * (months - 1n);
  let projectedOut: Minor | null = null;
  let annualTax: Minor | null = null;
  let incomeTax = 0n;
  let regionalTax = 0n;

  if (i.apply.incomeTax && s.incomeTax) {
    const t = s.incomeTax;
    const a = annualGenericTax(projected, t, s.rounding);
    projectedOut = projected;
    annualTax = a.tax;
    const due = max(0n, a.tax - i.tax.ytdTax);
    incomeTax = roundTo(divRound(due, months), s.rounding);
    const parts = [a.levy > 0n ? `levy ${fmt(a.levy)}` : '', a.surcharge > 0n ? `surcharge ${fmt(a.surcharge)}` : ''].filter(Boolean).join(', ');
    explanation.push(`Projected taxable pay this tax year ${fmt(projected)}; after the allowance ${fmt(a.taxable)}; ${t.name} for the year ${fmt(a.tax)}${parts ? ` (includes ${parts})` : ''}.`);
    if (t.reviewAbove !== null && projected > toMinor(t.reviewAbove)) warnings.push(`Projected taxable pay is above ${fmt(toMinor(t.reviewAbove))}. ${t.reviewNote || 'Check this employee’s tax by hand.'}`);
    if (incomeTax > 0n) lines.push({ code: 'TAX', name: t.name, kind: 'deduction', amount: fromMinor(incomeTax), explanation: `(${fmt(a.tax)} - ${fmt(i.tax.ytdTax)} already withheld) / ${months} month(s) left` });
  }

  if (i.apply.regional && i.apply.region) {
    const rule = s.regionalTaxes[i.apply.region];
    if (rule) {
      const a = annualGenericTax(projected, rule, s.rounding);
      const due = max(0n, a.tax - i.tax.ytdRegionalTax);
      regionalTax = roundTo(divRound(due, months), s.rounding);
      explanation.push(`${rule.name} for the year ${fmt(a.tax)} on ${fmt(a.taxable)}.`);
      if (regionalTax > 0n) lines.push({ code: 'REGION_TAX', name: rule.name, kind: 'deduction', amount: fromMinor(regionalTax), explanation: `(${fmt(a.tax)} - ${fmt(i.tax.ytdRegionalTax)} already withheld) / ${months} month(s) left` });
    } else {
      explanation.push(`No regional tax is set for ${i.apply.region}.`);
    }
  }

  return { lines, explanation, warnings, taxableNow, projected: projectedOut, annualTax, incomeTax, regionalTax };
}

/** Employer contributions a generic scheme expects on a contracted monthly salary (for the salary preview). */
export function genericEmployerEstimate(s: GenericStatutory, monthlyGross: Minor, monthlyContributionWages: Minor, enrolled: boolean): Minor {
  return sum(
    s.contributions
      .filter((r) => r.appliesTo === 'everyone' || enrolled)
      .map((r) => roundTo(applyRate(contributionBase(r, r.base === 'gross' ? monthlyGross : monthlyContributionWages), r.employerRatePercent, { percent: true }), s.rounding)),
  );
}

/** First day of the tax year that contains `date`, for a tax year starting in `startMonth` (1 to 12). */
export function taxYearStart(date: string, startMonth: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}-01`;
}

/** Months left in the tax year including the month of `date` (the first month = 12, the last = 1). */
export function taxYearMonthsRemaining(date: string, startMonth: number): number {
  const m = Number(date.slice(5, 7));
  return 12 - ((m - startMonth + 12) % 12);
}
