/**
 * Country packs: starting values for a legal entity's statutory settings, picked from the entity's country.
 *
 * - India (IN) uses its own scheme (PF, ESI, professional tax, TDS) from payroll-engine.ts.
 * - A few markets have a ready-made pack in the generic scheme (payroll-countries.ts).
 * - Every other country starts from a blank custom pack: the workspace adds its own contributions, income tax
 *   slabs and regional taxes. Any country can be paid this way.
 *
 * These are SampCrew's built-in packs. They are copied into the database (collection statutory_packs) on every
 * deploy, where SAMPLEDGE edits them or adds countries in the Console (Statutory packs); workspaces read the packs
 * from the database. A pack edited in the Console is never overwritten by a deploy.
 *
 * Every figure here is a starting value from commonly published rates for the tax year named in `basis`. Rates,
 * thresholds and bands change every year and some depend on the person (age, residency, tax code, filing status).
 * A local payroll advisor must check them before the first run. SampCrew does not certify them as current law.
 */
import { DEFAULT_IN_STATUTORY, type AnyStatutory } from './payroll-engine';
import { type ContributionRule, type GenericStatutory, isGenericStatutory } from './payroll-countries';

export interface StatutoryPack {
  countryCode: string;
  country: string;
  currency: string;
  /** The period the starting values were taken for, e.g. "Tax year 2026-27". */
  basis: string;
  /** One line on what the pack covers. */
  summary: string;
  settings: AnyStatutory;
}

const rule = (r: Partial<ContributionRule> & Pick<ContributionRule, 'code' | 'name'>): ContributionRule => ({
  employeeRatePercent: '0', employerRatePercent: '0', base: 'gross', threshold: null, ceiling: null, eligibleFrom: null, appliesTo: 'everyone', reducesTaxablePay: false, ...r,
});

const GB: GenericStatutory = {
  kind: 'generic', countryCode: 'GB', taxYearStartMonth: 4, rounding: 'cent', enrolmentLabel: 'Enrolled in the workplace pension',
  contributions: [
    rule({ code: 'NI', name: 'National Insurance', employeeRatePercent: '8', threshold: '1048', ceiling: '4189' }),
    rule({ code: 'NIUEL', name: 'National Insurance above the upper limit', employeeRatePercent: '2', threshold: '4189' }),
    rule({ code: 'NIER', name: 'Employer National Insurance', employerRatePercent: '15', threshold: '417' }),
    rule({ code: 'PENSION', name: 'Workplace pension', employeeRatePercent: '5', employerRatePercent: '3', threshold: '520', ceiling: '4189', appliesTo: 'enrolled', reducesTaxablePay: true }),
  ],
  incomeTax: {
    name: 'Income tax (PAYE)', allowance: '0', levyPercent: '0', surchargePercent: '0',
    slabs: [{ upTo: '12570', ratePercent: '0' }, { upTo: '50270', ratePercent: '20' }, { upTo: '125140', ratePercent: '40' }, { upTo: null, ratePercent: '45' }],
    reviewAbove: '100000', reviewNote: 'The personal allowance tapers away above £100,000; check this employee’s PAYE by hand.',
  },
  regionalTaxes: {},
  notes:
    'Assumes tax code 1257L on a cumulative basis and National Insurance category A, worked out monthly. Not calculated: other tax codes, Scottish and Welsh income tax rates, student and postgraduate loans, salary sacrifice, the apprenticeship levy, statutory sick, maternity and paternity pay. Pension uses qualifying earnings with a net pay arrangement.',
};

const US: GenericStatutory = {
  kind: 'generic', countryCode: 'US', taxYearStartMonth: 1, rounding: 'cent', enrolmentLabel: 'Enrolled in the 401(k) plan',
  contributions: [
    rule({ code: 'SS', name: 'Social Security', employeeRatePercent: '6.2', employerRatePercent: '6.2', ceiling: '15375' }),
    rule({ code: 'MEDICARE', name: 'Medicare', employeeRatePercent: '1.45', employerRatePercent: '1.45' }),
    rule({ code: 'ADDMED', name: 'Additional Medicare tax', employeeRatePercent: '0.9', threshold: '16666.67' }),
    rule({ code: 'K401', name: '401(k) retirement plan', employeeRatePercent: '5', employerRatePercent: '3', appliesTo: 'enrolled', reducesTaxablePay: true }),
  ],
  incomeTax: {
    name: 'Federal income tax', allowance: '16100', levyPercent: '0', surchargePercent: '0',
    slabs: [
      { upTo: '12400', ratePercent: '10' }, { upTo: '50400', ratePercent: '12' }, { upTo: '105700', ratePercent: '22' }, { upTo: '201775', ratePercent: '24' },
      { upTo: '256225', ratePercent: '32' }, { upTo: '640600', ratePercent: '35' }, { upTo: null, ratePercent: '37' },
    ],
    reviewAbove: null, reviewNote: '',
  },
  regionalTaxes: {
    Illinois: { name: 'Illinois income tax', allowance: '0', slabs: [{ upTo: null, ratePercent: '4.95' }] },
    Pennsylvania: { name: 'Pennsylvania income tax', allowance: '0', slabs: [{ upTo: null, ratePercent: '3.07' }] },
  },
  notes:
    'Federal withholding uses the single filing status and the annual standard deduction, with no Form W-4 adjustments (other filing statuses, dependants, extra withholding). The Social Security wage base and the Additional Medicare threshold are spread evenly per month. State income tax is set per state on the work location’s region; Illinois and Pennsylvania are examples, states without income tax need nothing. Not calculated: FUTA and state unemployment, local taxes, benefits and garnishments. The 401(k) rates are an example plan.',
};

const AE: GenericStatutory = {
  kind: 'generic', countryCode: 'AE', taxYearStartMonth: 1, rounding: 'cent', enrolmentLabel: 'UAE national (GPSSA pension)',
  contributions: [
    rule({ code: 'GPSSA', name: 'GPSSA pension', employeeRatePercent: '11', employerRatePercent: '12.5', base: 'contribution_wages', ceiling: '70000', appliesTo: 'enrolled' }),
  ],
  incomeTax: null,
  regionalTaxes: {},
  notes:
    'There is no personal income tax. Pension contributions apply to UAE nationals in the private sector on their contribution salary (mark Basic and other contractual allowances as contribution wages). Not calculated: other GCC nationals under the GCC extension (add their home scheme as a contribution), end-of-service gratuity accruals and the WPS salary file.',
};

const SA: GenericStatutory = {
  kind: 'generic', countryCode: 'SA', taxYearStartMonth: 1, rounding: 'cent', enrolmentLabel: 'Saudi national (GOSI annuities and SANED)',
  contributions: [
    rule({ code: 'GOSI', name: 'GOSI annuities', employeeRatePercent: '9', employerRatePercent: '9', base: 'contribution_wages', ceiling: '45000', appliesTo: 'enrolled' }),
    rule({ code: 'SANED', name: 'SANED unemployment insurance', employeeRatePercent: '0.75', employerRatePercent: '0.75', base: 'contribution_wages', ceiling: '45000', appliesTo: 'enrolled' }),
    rule({ code: 'OCCHAZ', name: 'Occupational hazards', employerRatePercent: '2', base: 'contribution_wages', ceiling: '45000' }),
  ],
  incomeTax: null,
  regionalTaxes: {},
  notes:
    'There is no personal income tax. GOSI is on Basic plus housing (mark them as contribution wages). Saudi nationals who first joined GOSI after July 2024 have annuity rates that rise each year; change the rate for those people with a separate entity setting or an adjustment. Not calculated: end-of-service award accruals and the Mudad/WPS file.',
};

const QA: GenericStatutory = {
  kind: 'generic', countryCode: 'QA', taxYearStartMonth: 1, rounding: 'cent', enrolmentLabel: 'Qatari national (pension fund)',
  contributions: [
    rule({ code: 'PENSION', name: 'Social insurance pension', employeeRatePercent: '7', employerRatePercent: '14', base: 'contribution_wages', appliesTo: 'enrolled' }),
  ],
  incomeTax: null,
  regionalTaxes: {},
  notes: 'There is no personal income tax. Pension contributions apply to Qatari nationals. Not calculated: GCC nationals under the GCC extension, end-of-service gratuity and the WPS file.',
};

const SG: GenericStatutory = {
  kind: 'generic', countryCode: 'SG', taxYearStartMonth: 1, rounding: 'whole', enrolmentLabel: 'Singapore citizen or PR (CPF)',
  contributions: [
    rule({ code: 'CPF', name: 'CPF', employeeRatePercent: '20', employerRatePercent: '17', ceiling: '8000', eligibleFrom: '750', appliesTo: 'enrolled' }),
    rule({ code: 'SDL', name: 'Skills Development Levy', employerRatePercent: '0.25', ceiling: '4500' }),
  ],
  incomeTax: null,
  regionalTaxes: {},
  notes:
    'Employers do not withhold income tax for residents; it is reported yearly (IR8A). CPF rates are for employees aged 55 and below on ordinary wages; older employees, PRs in their first two years and wages between $50 and $750 have other rates. Not calculated: additional wages and the annual ceiling, the SDL minimum of $2, and self-help group funds (CDAC, ECF, MBMF, SINDA), which can be added as contributions.',
};

const AU: GenericStatutory = {
  kind: 'generic', countryCode: 'AU', taxYearStartMonth: 7, rounding: 'cent', enrolmentLabel: 'Salary sacrifice to super',
  contributions: [
    rule({ code: 'SUPER', name: 'Superannuation guarantee', employerRatePercent: '12', base: 'contribution_wages', ceiling: '20833' }),
  ],
  incomeTax: {
    name: 'PAYG withholding', allowance: '0', levyPercent: '2', surchargePercent: '0',
    slabs: [{ upTo: '18200', ratePercent: '0' }, { upTo: '45000', ratePercent: '15' }, { upTo: '135000', ratePercent: '30' }, { upTo: '190000', ratePercent: '37' }, { upTo: null, ratePercent: '45' }],
    reviewAbove: null, reviewNote: '',
  },
  regionalTaxes: {},
  notes:
    'Withholding is an annual estimate from resident tax rates with the tax-free threshold claimed plus the 2% Medicare levy; the ATO tax tables, the low income tax offset and the Medicare levy reduction give slightly different amounts. Super is on ordinary time earnings (mark them as contribution wages), with the maximum contribution base spread per month. Not calculated: HELP/STSL debts, non-residents and working holiday makers, state payroll tax and workers compensation.',
};

const PACKS: StatutoryPack[] = [
  { countryCode: 'IN', country: 'India', currency: 'INR', basis: 'Financial year 2025-26 (Union Budget 2025)', summary: 'Provident Fund, ESI, professional tax by state and income tax (TDS, new regime).', settings: DEFAULT_IN_STATUTORY },
  { countryCode: 'GB', country: 'United Kingdom', currency: 'GBP', basis: 'Tax year 2026-27', summary: 'PAYE income tax, employee and employer National Insurance, workplace pension.', settings: GB },
  { countryCode: 'US', country: 'United States', currency: 'USD', basis: 'Tax year 2026', summary: 'Federal income tax withholding, Social Security, Medicare, 401(k), state income tax by region.', settings: US },
  { countryCode: 'AE', country: 'United Arab Emirates', currency: 'AED', basis: 'Rates in force from October 2023', summary: 'No income tax; GPSSA pension for UAE nationals.', settings: AE },
  { countryCode: 'SA', country: 'Saudi Arabia', currency: 'SAR', basis: 'GOSI rates for existing contributors', summary: 'No income tax; GOSI annuities and SANED for Saudi nationals, occupational hazards for everyone.', settings: SA },
  { countryCode: 'QA', country: 'Qatar', currency: 'QAR', basis: 'Social insurance law 2022', summary: 'No income tax; pension for Qatari nationals.', settings: QA },
  { countryCode: 'SG', country: 'Singapore', currency: 'SGD', basis: 'CPF rates from January 2026', summary: 'CPF for citizens and PRs, Skills Development Levy; no monthly income tax withholding.', settings: SG },
  { countryCode: 'AU', country: 'Australia', currency: 'AUD', basis: 'Tax year 2026-27', summary: 'PAYG withholding with the Medicare levy, superannuation guarantee.', settings: AU },
];

/** SampCrew's built-in packs, with their settings, for the database sync. */
export const builtInStatutoryPacks = (): StatutoryPack[] => structuredClone(PACKS);

/**
 * Why a scheme cannot be saved for a country, or null when it can: India's scheme only for India, a generic scheme
 * only for its own country, unique contribution codes, rates, ranges and slabs the engine can use.
 */
export function statutorySchemeProblem(s: AnyStatutory, countryCode: string): { code: string; message: string } | null {
  const slabs = (list: { upTo: string | null }[], what: string) => {
    if (list[list.length - 1]!.upTo !== null) return { code: 'open_slab', message: `${what}: the last slab must have no upper limit` };
    let prev = -1;
    for (const sl of list.slice(0, -1)) {
      if (sl.upTo === null) return { code: 'open_slab', message: `${what}: only the last slab can have no upper limit` };
      if (Number(sl.upTo) <= prev) return { code: 'slab_order', message: `${what}: slab limits must rise` };
      prev = Number(sl.upTo);
    }
    return null;
  };
  if (!isGenericStatutory(s)) {
    if (countryCode !== 'IN') return { code: 'scheme_country', message: `India's PF, ESI and TDS scheme only applies to India. This is ${countryCode}; use its country's settings.` };
    for (const [state, list] of Object.entries(s.pt.states)) {
      const p = slabs(list, `Professional tax for ${state}`);
      if (p) return p;
    }
    return slabs(s.tds.slabs, 'Income tax slabs');
  }
  if (countryCode === 'IN') return { code: 'scheme_country', message: 'India uses the India scheme (PF, ESI, professional tax and TDS).' };
  if (s.countryCode !== countryCode) return { code: 'scheme_country', message: `These settings are for ${s.countryCode}, but the country is ${countryCode}.` };
  const codes = new Set<string>();
  for (const r of s.contributions) {
    if (codes.has(r.code)) return { code: 'contribution_code', message: `Two contributions use the code ${r.code}` };
    codes.add(r.code);
    if (Number(r.employeeRatePercent) === 0 && Number(r.employerRatePercent) === 0) return { code: 'contribution_rate', message: `${r.name}: give an employee or employer rate` };
    if (r.threshold !== null && r.ceiling !== null && Number(r.ceiling) <= Number(r.threshold)) return { code: 'contribution_range', message: `${r.name}: the ceiling must be above the threshold` };
  }
  if (s.incomeTax) {
    const p = slabs(s.incomeTax.slabs, `${s.incomeTax.name} slabs`);
    if (p) return p;
  }
  for (const [region, t] of Object.entries(s.regionalTaxes)) {
    const p = slabs(t.slabs, `${t.name} (${region}) slabs`);
    if (p) return p;
  }
  return null;
}

/** Countries with a built-in pack, India first. */
export const STATUTORY_PACKS: readonly Omit<StatutoryPack, 'settings'>[] = PACKS.map(({ settings: _s, ...rest }) => rest);

/** Currencies whose amounts have no minor unit; generic schemes round to whole units for them. */
export const ZERO_DECIMAL_CURRENCIES = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'] as const;
/** Currencies with three decimal places. SampCrew keeps amounts to two decimals, so pay in these is rounded to 0.01. */
export const THREE_DECIMAL_CURRENCIES = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const;

/** A blank generic scheme for a country without a pack: no contributions and no income tax until the workspace adds them. */
export function customStatutory(countryCode: string, opts: { taxYearStartMonth?: number; currency?: string } = {}): GenericStatutory {
  const month = opts.taxYearStartMonth && opts.taxYearStartMonth >= 1 && opts.taxYearStartMonth <= 12 ? opts.taxYearStartMonth : 1;
  return {
    kind: 'generic', countryCode, taxYearStartMonth: month,
    rounding: opts.currency && (ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(opts.currency) ? 'whole' : 'cent',
    enrolmentLabel: 'Enrolled in the pension or social security scheme',
    contributions: [],
    incomeTax: { name: 'Income tax', allowance: '0', slabs: [{ upTo: null, ratePercent: '0' }], levyPercent: '0', surchargePercent: '0', reviewAbove: null, reviewNote: '' },
    regionalTaxes: {},
    notes: '',
  };
}

export const packFor = (countryCode: string) => PACKS.find((p) => p.countryCode === countryCode);

/**
 * Starting values for a legal entity: its country's pack, else a blank custom scheme for that country. Pass the
 * packs read from the database; without them the built-in packs are used (tests, demo data).
 */
export function startingStatutory(
  countryCode: string,
  opts: { taxYearStartMonth?: number; currency?: string; packs?: readonly StatutoryPack[] } = {},
): { pack: Omit<StatutoryPack, 'settings'> | null; settings: AnyStatutory } {
  const p = (opts.packs ?? PACKS).find((x) => x.countryCode === countryCode);
  if (p) {
    const { settings, ...pack } = p;
    return { pack, settings: structuredClone(settings) };
  }
  return { pack: null, settings: customStatutory(countryCode, opts) };
}

/** The notice shown with starting values. */
export function startingNotice(countryCode: string, pack: Omit<StatutoryPack, 'settings'> | null, currency?: string): string {
  const three = currency && (THREE_DECIMAL_CURRENCIES as readonly string[]).includes(currency)
    ? ` Amounts in ${currency} are kept to two decimal places, not three.`
    : '';
  if (!pack) {
    return `SampCrew has no ready-made pack for ${countryCode}, so this is a blank custom scheme. Add the social security and pension contributions, income tax slabs and regional taxes that apply, with a local payroll advisor, before saving.${three}`;
  }
  return `Starting values for ${pack.country} (${pack.basis}) from commonly published figures. SampCrew does not certify them as current law. A local payroll advisor must check every rate, threshold and band for the period you pay, and change them where needed, before saving.${three}`;
}

/**
 * What the four per-employee switches on a salary mean under a scheme, or null where a switch does nothing.
 * The switches are stored as pf, esi, pt and tds for every country.
 */
export function statutorySwitches(s: AnyStatutory): { pf: string | null; esi: string | null; pt: string | null; tds: string | null; employerInCtc: boolean } {
  if (!isGenericStatutory(s)) return { pf: 'Provident Fund', esi: 'ESI when eligible', pt: 'Professional tax', tds: 'Income tax (TDS), new regime', employerInCtc: true };
  return {
    pf: s.contributions.some((r) => r.appliesTo === 'enrolled') ? s.enrolmentLabel : null,
    esi: null,
    pt: Object.keys(s.regionalTaxes).length ? 'Regional income tax (by work location)' : null,
    tds: s.incomeTax ? s.incomeTax.name : null,
    employerInCtc: false,
  };
}
