/**
 * The payroll engine: pure functions, exact decimal arithmetic (integer paise), and a plain-language explanation
 * for every amount. The API feeds it one employee-month; nothing here touches a database or a clock.
 *
 * India statutory defaults (`DEFAULT_IN_STATUTORY`) are starting values that each workspace reviews and edits,
 * stored with an effective date. SampCrew does not claim they are current law for any period; see
 * docs/phases/phase-5.md.
 *
 * Rules (each covered by golden tests in payroll-engine.spec.ts):
 * - Proration: calendar-day method. Paid days = days employed in the month minus loss-of-pay days. A component
 *   marked `prorate` is paid monthly x paid days / days in the month. Fixed deductions are not prorated.
 * - Provident Fund: on the month's earned PF wages (components marked `pfWage`, usually Basic and DA), capped at
 *   the wage ceiling when `restrictToCeiling`. Employee and employer contributions at their rates, rounded to the
 *   rupee. The employer's share is split into pension (EPS, on wages up to the ceiling) and the rest (EPF).
 * - ESI: applies when the contracted monthly gross is at or below the ceiling. Contributions on the month's
 *   earned gross, rounded up to the next rupee.
 * - Professional tax: by the work location's state, from that state's monthly gross slabs, with a separate
 *   February amount where a state has one.
 * - Income tax (TDS), new regime: projected annual taxable income = taxable pay so far this financial year +
 *   this month's taxable pay + the regular monthly taxable pay for the rest of the year. Less the standard
 *   deduction, tax by slabs, a full rebate up to the rebate limit with marginal relief just above it, plus cess.
 *   This month's TDS = (annual tax - TDS already deducted) / months left including this one, rounded to the rupee.
 * - Reimbursements (approved expenses) are paid on top and are not taxable.
 */
import { applyRate, divRound, formatMoney, fromMinor, max, min, type Minor, prorate, sum, toMinor, toWhole } from './money';
import { type GenericStatutory, genericEmployerEstimate, genericStatutory, isGenericStatutory, type LineKind, type PayLine, slabTax, type TaxSlab, taxYearMonthsRemaining, taxYearStart } from './payroll-countries';

export { slabTax, isGenericStatutory, taxYearStart, taxYearMonthsRemaining };
export type { TaxSlab, LineKind, PayLine, GenericStatutory };

export interface Slab { upTo: string | null; amount: string; februaryAmount?: string }

export interface StatutorySettings {
  pf: { employeeRatePercent: string; employerRatePercent: string; epsRatePercent: string; wageCeiling: string; restrictToCeiling: boolean };
  esi: { employeeRatePercent: string; employerRatePercent: string; grossCeiling: string };
  /** Monthly slabs on gross pay, keyed by state name as written on the location (e.g. "Maharashtra"). */
  pt: { states: Record<string, Slab[]> };
  tds: { regime: 'new'; standardDeduction: string; slabs: TaxSlab[]; rebateLimit: string; cessPercent: string; surchargeThreshold: string };
}

/** The settings a legal entity saves: India's scheme, or the rules-based scheme every other country uses. */
export type AnyStatutory = StatutorySettings | GenericStatutory;

/** Month the tax year starts for a scheme (India: April). */
export const taxYearStartMonthOf = (s: AnyStatutory) => (isGenericStatutory(s) ? s.taxYearStartMonth : 4);

/**
 * Starting values for India. They follow the commonly published figures (EPF 12% with a ₹15,000 wage ceiling,
 * EPS 8.33%, ESI 0.75% / 3.25% up to ₹21,000 gross, Maharashtra and Karnataka professional tax, and the new
 * income tax regime as announced in the Union Budget 2025). Every workspace must check them for the period it
 * pays and change them where needed.
 */
export const DEFAULT_IN_STATUTORY: StatutorySettings = {
  pf: { employeeRatePercent: '12', employerRatePercent: '12', epsRatePercent: '8.33', wageCeiling: '15000', restrictToCeiling: true },
  esi: { employeeRatePercent: '0.75', employerRatePercent: '3.25', grossCeiling: '21000' },
  pt: {
    states: {
      Maharashtra: [{ upTo: '7500', amount: '0' }, { upTo: '10000', amount: '175' }, { upTo: null, amount: '200', februaryAmount: '300' }],
      Karnataka: [{ upTo: '24999.99', amount: '0' }, { upTo: null, amount: '200' }],
    },
  },
  tds: {
    regime: 'new',
    standardDeduction: '75000',
    slabs: [
      { upTo: '400000', ratePercent: '0' }, { upTo: '800000', ratePercent: '5' }, { upTo: '1200000', ratePercent: '10' }, { upTo: '1600000', ratePercent: '15' },
      { upTo: '2000000', ratePercent: '20' }, { upTo: '2400000', ratePercent: '25' }, { upTo: null, ratePercent: '30' },
    ],
    rebateLimit: '1200000',
    cessPercent: '4',
    surchargeThreshold: '5000000',
  },
};

// ---- Salary breakdown ---------------------------------------------------------------------------------

export type CalcMethod = 'fixed' | 'percent_of_ctc' | 'percent_of_basic' | 'balance';
export interface StructureLine { code: string; name: string; kind: 'earning' | 'deduction'; calc: CalcMethod; value: string; isBasic?: boolean }
export interface SalaryComponent { code: string; name: string; kind: 'earning' | 'deduction'; monthly: string; annual: string }

/**
 * Splits an annual cost to company (CTC) into monthly components. Fixed values are annual amounts; percentages
 * are of the annual CTC or of Basic. The single `balance` line takes what is left after the other earnings and
 * the employer's PF contribution, so the components plus employer PF add up to the CTC. Monthly amounts are
 * whole rupees; the balance line absorbs the rounding.
 */
export function buildSalary(annualCtc: string, lines: StructureLine[], opts: { pf: boolean; settings: AnyStatutory }): { components: SalaryComponent[]; employerPfMonthly: string; employerInCtc: boolean; warnings: string[] } {
  const ctcMonthly = divRound(toMinor(annualCtc), 12n);
  const warnings: string[] = [];
  const basicLine = lines.find((l) => l.isBasic);
  if (!basicLine) throw new Error('The structure needs a Basic component');
  if (basicLine.calc === 'percent_of_basic' || basicLine.calc === 'balance') throw new Error('Basic must be a fixed amount or a percentage of CTC');
  if (lines.filter((l) => l.calc === 'balance').length > 1) throw new Error('Only one component can take the balance');

  const monthlyOf = (l: StructureLine, basic: Minor): Minor => {
    if (l.calc === 'fixed') return toWhole(divRound(toMinor(l.value), 12n));
    if (l.calc === 'percent_of_ctc') return toWhole(applyRate(ctcMonthly, l.value, { percent: true }));
    if (l.calc === 'percent_of_basic') return toWhole(applyRate(basic, l.value, { percent: true }));
    return 0n;
  };
  const basic = monthlyOf(basicLine, 0n);
  const out = new Map<string, Minor>();
  for (const l of lines) if (l.calc !== 'balance') out.set(l.code, l.isBasic ? basic : monthlyOf(l, basic));

  // India: the CTC includes employer PF. Elsewhere the annual amount is the gross salary, and employer contributions
  // are paid on top of it (shown as an estimate).
  const generic = isGenericStatutory(opts.settings);
  let employerPf = 0n;
  if (!isGenericStatutory(opts.settings)) {
    const pf = opts.settings.pf;
    const pfWage = pf.restrictToCeiling ? min(basic, toMinor(pf.wageCeiling)) : basic;
    employerPf = opts.pf ? toWhole(applyRate(pfWage, pf.employerRatePercent, { percent: true })) : 0n;
  }
  const earnings = sum(lines.filter((l) => l.kind === 'earning' && l.calc !== 'balance').map((l) => out.get(l.code)!));
  const balanceLine = lines.find((l) => l.calc === 'balance');
  const rest = ctcMonthly - earnings - employerPf;
  const what = generic ? 'the annual salary' : 'the CTC';
  if (balanceLine) {
    if (rest < 0n) throw new Error(`The components add up to more than ${what} by ${formatMoney(-rest * 12n, 'INR').replace('INR ', '')} a year`);
    out.set(balanceLine.code, rest);
  } else if (rest !== 0n) {
    warnings.push(`Components${generic ? '' : ' and employer PF'} differ from ${what} by ${fromMinor(rest)} a month; add a balance component to absorb it.`);
  }
  let employerMonthly = employerPf;
  if (isGenericStatutory(opts.settings)) {
    const gross = sum(lines.filter((l) => l.kind === 'earning').map((l) => out.get(l.code)!));
    employerMonthly = genericEmployerEstimate(opts.settings, gross, basic, opts.pf);
  }
  return {
    components: lines.map((l) => ({ code: l.code, name: l.name, kind: l.kind, monthly: fromMinor(out.get(l.code)!), annual: fromMinor(out.get(l.code)! * 12n) })),
    employerPfMonthly: fromMinor(employerMonthly),
    employerInCtc: !generic,
    warnings,
  };
}

// ---- One employee-month --------------------------------------------------------------------------------

export interface PayComponentInput { code: string; name: string; kind: 'earning' | 'deduction'; monthly: string; prorate: boolean; taxable: boolean; pfWage: boolean }
export interface PayrollInput {
  currency: string;
  /** 1 to 12 */
  month: number;
  daysInPeriod: number;
  /** Calendar days in the month the person was employed (joining and exit). */
  employedDays: number;
  /** Loss-of-pay days, in steps of 0.5 ("1.50"). */
  lopDays: string;
  components: PayComponentInput[];
  adjustments: { kind: 'earning' | 'deduction'; label: string; amount: string; taxable: boolean }[];
  reimbursements: { label: string; amount: string }[];
  /**
   * Attendance penalties for the month (late coming, same-day leave): a percentage of the month's gross pay, or days of
   * pay at the contracted monthly gross / days in the month. Each one is a deduction line.
   */
  penalties?: { label: string; basis: 'percent' | 'days'; value: string; note?: string }[];
  /**
   * India's scheme or a generic one. For a generic scheme the switches mean: pf = enrolled in the contributions
   * marked "enrolled", tds = income tax, pt = regional tax (ptState = the work location's region), esi = unused.
   */
  statutory: AnyStatutory;
  apply: { pf: boolean; esi: boolean; pt: boolean; tds: boolean; ptState: string | null };
  /** ytdTds is income tax already withheld this tax year; ytdRegionalTax only matters for a generic scheme. */
  tax: { monthsRemaining: number; ytdTaxable: string; ytdTds: string; ytdRegionalTax?: string };
}
export interface PayrollResult {
  paidDays: string;
  lines: PayLine[];
  gross: string;
  deductions: string;
  reimbursements: string;
  net: string;
  employerContributions: string;
  costToCompany: string;
  taxableThisMonth: string;
  projectedAnnualTaxable: string | null;
  annualTax: string | null;
  /** Income tax withheld this month (TDS in India) and regional tax (generic schemes only). */
  incomeTax: string;
  regionalTax: string;
  explanation: string[];
  warnings: string[];
}

const dayText = (h: Minor) => fromMinor(h).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
const halves = (d: string) => {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(d)) throw new Error(`Invalid day count: ${d}`);
  return toMinor(d); // hundredths of a day, same scale as paise
};

/** Annual income tax under the new regime, with rebate, marginal relief and cess; rounded to the rupee. */
export function annualTaxNewRegime(grossTaxable: Minor, t: StatutorySettings['tds']): { taxable: Minor; tax: Minor; notes: string[] } {
  const notes: string[] = [];
  const taxable = max(0n, grossTaxable - toMinor(t.standardDeduction));
  let tax = slabTax(taxable, t.slabs);
  const rebateLimit = toMinor(t.rebateLimit);
  if (taxable <= rebateLimit) {
    if (tax > 0n) notes.push(`No tax: income up to ${formatMoney(rebateLimit, 'INR')} gets a full rebate.`);
    tax = 0n;
  } else if (tax > taxable - rebateLimit) {
    notes.push(`Marginal relief: tax limited to the income above ${formatMoney(rebateLimit, 'INR')}.`);
    tax = taxable - rebateLimit;
  }
  const cess = applyRate(tax, t.cessPercent, { percent: true });
  return { taxable, tax: toWhole(tax + cess), notes };
}

export function computePay(i: PayrollInput): PayrollResult {
  const cur = i.currency;
  const fmt = (m: Minor) => formatMoney(m, cur);
  const explanation: string[] = [];
  const warnings: string[] = [];
  if (i.daysInPeriod < 28 || i.daysInPeriod > 31) throw new Error('A pay period is one calendar month');
  if (i.employedDays < 0 || i.employedDays > i.daysInPeriod) throw new Error('Employed days must be within the month');

  const employed = BigInt(i.employedDays) * 100n;
  let lop = halves(i.lopDays);
  if (lop > employed) {
    warnings.push(`Loss-of-pay days (${i.lopDays}) were more than the days employed; capped at ${i.employedDays}.`);
    lop = employed;
  }
  const paid = employed - lop;
  const period = BigInt(i.daysInPeriod) * 100n;
  explanation.push(
    i.employedDays < i.daysInPeriod
      ? `Employed ${i.employedDays} of ${i.daysInPeriod} days this month.`
      : `Employed for the whole month (${i.daysInPeriod} days).`,
  );
  if (lop > 0n) explanation.push(`${dayText(lop)} loss-of-pay day(s), so ${dayText(paid)} paid days.`);

  const lines: PayLine[] = [];
  let pfWage = 0n;
  let contractedPfWage = 0n;
  let taxableNow = 0n;
  let taxableRecurring = 0n;
  let contractedGross = 0n;
  for (const c of i.components) {
    const monthly = toMinor(c.monthly);
    if (c.kind === 'earning') {
      contractedGross += monthly;
      const amount = c.prorate ? prorate(monthly, paid, period) : monthly;
      if (c.pfWage) {
        pfWage += amount;
        contractedPfWage += monthly;
      }
      if (c.taxable) {
        taxableNow += amount;
        taxableRecurring += monthly;
      }
      lines.push({
        code: c.code, name: c.name, kind: 'earning', amount: fromMinor(amount), taxable: c.taxable,
        explanation: c.prorate && paid !== period ? `${fmt(monthly)} x ${dayText(paid)} / ${i.daysInPeriod} days` : `${fmt(monthly)} a month`,
      });
    } else {
      lines.push({ code: c.code, name: c.name, kind: 'deduction', amount: fromMinor(toMinor(c.monthly)), explanation: 'Fixed monthly deduction' });
    }
  }
  for (const [n, a] of i.adjustments.entries()) {
    const amount = toMinor(a.amount);
    if (a.kind === 'earning' && a.taxable) taxableNow += amount;
    lines.push({ code: `ADJ${n + 1}`, name: a.label, kind: a.kind, amount: fromMinor(amount), taxable: a.kind === 'earning' ? a.taxable : undefined, explanation: 'One-off adjustment for this run' });
  }
  const earned = sum(lines.filter((l) => l.kind === 'earning').map((l) => toMinor(l.amount)));

  let projected: Minor | null = null;
  let annualTax: Minor | null = null;
  let incomeTax = 0n;
  let regionalTax = 0n;
  if (isGenericStatutory(i.statutory)) {
    const g = genericStatutory({
      settings: i.statutory, currency: cur, earned, contributionWages: pfWage, contractedGross, contractedContributionWages: contractedPfWage,
      taxableNow, taxableRecurring,
      apply: { enrolled: i.apply.pf, incomeTax: i.apply.tds, regional: i.apply.pt, region: i.apply.ptState },
      tax: { monthsRemaining: i.tax.monthsRemaining, ytdTaxable: toMinor(i.tax.ytdTaxable), ytdTax: toMinor(i.tax.ytdTds), ytdRegionalTax: toMinor(i.tax.ytdRegionalTax ?? '0') },
    });
    lines.push(...g.lines);
    explanation.push(...g.explanation);
    warnings.push(...g.warnings);
    taxableNow = g.taxableNow;
    projected = g.projected;
    annualTax = g.annualTax;
    incomeTax = g.incomeTax;
    regionalTax = g.regionalTax;
  } else {
    const india = i.statutory;
    // Provident Fund
    if (i.apply.pf && pfWage > 0n) {
      const s = india.pf;
      const ceiling = toMinor(s.wageCeiling);
      const base = s.restrictToCeiling ? min(pfWage, ceiling) : pfWage;
      const employee = toWhole(applyRate(base, s.employeeRatePercent, { percent: true }));
      const employer = toWhole(applyRate(base, s.employerRatePercent, { percent: true }));
      const eps = min(employer, toWhole(applyRate(min(base, ceiling), s.epsRatePercent, { percent: true })));
      const capped = s.restrictToCeiling && pfWage > ceiling ? ` (PF wages ${fmt(pfWage)}, capped at ${fmt(ceiling)})` : '';
      lines.push({ code: 'PF_EE', name: 'Provident Fund', kind: 'deduction', amount: fromMinor(employee), explanation: `${s.employeeRatePercent}% of ${fmt(base)}${capped}` });
      lines.push({ code: 'PF_ER_EPS', name: 'Employer pension (EPS)', kind: 'employer', amount: fromMinor(eps), explanation: `${s.epsRatePercent}% of ${fmt(min(base, ceiling))}` });
      lines.push({ code: 'PF_ER_EPF', name: 'Employer PF (EPF)', kind: 'employer', amount: fromMinor(employer - eps), explanation: `${s.employerRatePercent}% of ${fmt(base)} less the pension share` });
    }

    // ESI
    if (i.apply.esi) {
      const s = india.esi;
      const ceiling = toMinor(s.grossCeiling);
      if (contractedGross <= ceiling) {
        const employee = toWhole(applyRate(earned, s.employeeRatePercent, { percent: true, rounding: 'up' }), 'up');
        const employer = toWhole(applyRate(earned, s.employerRatePercent, { percent: true, rounding: 'up' }), 'up');
        lines.push({ code: 'ESI_EE', name: 'ESI', kind: 'deduction', amount: fromMinor(employee), explanation: `${s.employeeRatePercent}% of ${fmt(earned)}, rounded up` });
        lines.push({ code: 'ESI_ER', name: 'Employer ESI', kind: 'employer', amount: fromMinor(employer), explanation: `${s.employerRatePercent}% of ${fmt(earned)}, rounded up` });
      } else {
        explanation.push(`No ESI: monthly gross ${fmt(contractedGross)} is above ${fmt(ceiling)}.`);
      }
    }

    // Professional tax
    if (i.apply.pt) {
      const slabs = i.apply.ptState ? india.pt.states[i.apply.ptState] : undefined;
      if (!slabs) {
        warnings.push(i.apply.ptState ? `No professional tax slabs set for ${i.apply.ptState}; none deducted.` : 'The work location has no state set; no professional tax deducted.');
      } else {
        const slab = slabs.find((s) => s.upTo === null || earned <= toMinor(s.upTo))!;
        const amount = i.month === 2 && slab.februaryAmount ? slab.februaryAmount : slab.amount;
        if (toMinor(amount) > 0n) {
          lines.push({ code: 'PT', name: 'Professional tax', kind: 'deduction', amount: fromMinor(toMinor(amount)), explanation: `${i.apply.ptState} slab for gross ${fmt(earned)}${i.month === 2 && slab.februaryAmount ? ' (February amount)' : ''}` });
        }
      }
    }

    // Income tax
    if (i.apply.tds) {
      const months = BigInt(Math.max(1, i.tax.monthsRemaining));
      projected = toMinor(i.tax.ytdTaxable) + taxableNow + taxableRecurring * (months - 1n);
      const t = annualTaxNewRegime(projected, india.tds);
      annualTax = t.tax;
      const remaining = max(0n, t.tax - toMinor(i.tax.ytdTds));
      const tds = toWhole(divRound(remaining, months));
      explanation.push(`Projected taxable pay this financial year ${fmt(projected)}; after the standard deduction ${fmt(t.taxable)}; tax with cess ${fmt(t.tax)} (new regime).`, ...t.notes);
      if (projected > toMinor(india.tds.surchargeThreshold)) warnings.push('Projected income is above the surcharge threshold; surcharge is not calculated. Review TDS by hand.');
      incomeTax = tds;
      if (tds > 0n) {
        lines.push({ code: 'TDS', name: 'Income tax (TDS)', kind: 'deduction', amount: fromMinor(tds), explanation: `(${fmt(t.tax)} - ${fmt(toMinor(i.tax.ytdTds))} already deducted) / ${months} month(s) left` });
      }
    }
  }

  // Attendance penalties: after statutory deductions, so they never change PF, ESI, PT or TDS.
  for (const [n, p] of (i.penalties ?? []).entries()) {
    let amount: Minor;
    let how: string;
    if (p.basis === 'percent') {
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(p.value) || Number(p.value) <= 0 || Number(p.value) > 100) throw new Error(`Invalid penalty percentage: ${p.value}`);
      amount = applyRate(earned, p.value, { percent: true });
      how = `${p.value}% of gross pay ${fmt(earned)}`;
    } else {
      const d = halves(p.value);
      amount = prorate(contractedGross, d, period);
      how = `${fmt(contractedGross)} a month / ${i.daysInPeriod} days x ${dayText(d)} day(s)`;
    }
    amount = toWhole(amount);
    if (amount <= 0n) continue;
    lines.push({ code: `PEN${n + 1}`, name: p.label, kind: 'deduction', amount: fromMinor(amount), explanation: p.note ? `${how}. ${p.note}` : how });
  }
  if (i.penalties?.length) explanation.push(`${i.penalties.length} attendance penalt${i.penalties.length === 1 ? 'y' : 'ies'} deducted this month.`);

  for (const [n, r] of i.reimbursements.entries()) {
    lines.push({ code: `REIMB${n + 1}`, name: r.label, kind: 'reimbursement', amount: fromMinor(toMinor(r.amount)), explanation: 'Approved expense claim, not taxable' });
  }

  const deductions = sum(lines.filter((l) => l.kind === 'deduction').map((l) => toMinor(l.amount)));
  const reimb = sum(lines.filter((l) => l.kind === 'reimbursement').map((l) => toMinor(l.amount)));
  const employerC = sum(lines.filter((l) => l.kind === 'employer').map((l) => toMinor(l.amount)));
  const net = earned + reimb - deductions;
  if (net < 0n) warnings.push(`Deductions are more than pay by ${fmt(-net)}. Hold this payslip or change the adjustments.`);
  return {
    paidDays: fromMinor(paid),
    lines,
    gross: fromMinor(earned),
    deductions: fromMinor(deductions),
    reimbursements: fromMinor(reimb),
    net: fromMinor(net),
    employerContributions: fromMinor(employerC),
    costToCompany: fromMinor(earned + employerC),
    taxableThisMonth: fromMinor(taxableNow),
    projectedAnnualTaxable: projected === null ? null : fromMinor(projected),
    annualTax: annualTax === null ? null : fromMinor(annualTax),
    incomeTax: fromMinor(incomeTax),
    regionalTax: fromMinor(regionalTax),
    explanation,
    warnings,
  };
}

/** Financial year (April to March) helpers for India. Other countries use taxYearStart / taxYearMonthsRemaining. */
export const fyStart = (date: string) => taxYearStart(date, 4);
/** Months left in the financial year including the month of `date` (April = 12, March = 1). */
export const fyMonthsRemaining = (date: string) => taxYearMonthsRemaining(date, 4);
