import { describe, expect, it } from 'vitest';
import { buildSalary, computePay, DEFAULT_IN_STATUTORY, type PayComponentInput, type PayrollInput } from './payroll-engine';
import { type GenericStatutory, taxYearMonthsRemaining, taxYearStart } from './payroll-countries';
import { anyStatutorySchema, genericStatutorySchema } from './schemas/payroll';
import { customStatutory, packFor, STATUTORY_PACKS, startingNotice, startingStatutory, statutorySwitches } from './statutory-packs';

const pack = (cc: string) => packFor(cc)!.settings as GenericStatutory;
const comp = (code: string, monthly: string, extra: Partial<PayComponentInput> = {}): PayComponentInput => ({ code, name: code, kind: 'earning', monthly, prorate: true, taxable: true, pfWage: false, ...extra });
const input = (over: Partial<PayrollInput>): PayrollInput => ({
  currency: 'GBP', month: 4, daysInPeriod: 30, employedDays: 30, lopDays: '0', components: [], adjustments: [], reimbursements: [],
  statutory: pack('GB'), apply: { pf: true, esi: false, pt: false, tds: true, ptState: null }, tax: { monthsRemaining: 12, ytdTaxable: '0', ytdTds: '0' }, ...over,
});
const line = (r: ReturnType<typeof computePay>, code: string) => r.lines.find((l) => l.code === code)?.amount;

describe('tax years', () => {
  it('start in the configured month', () => {
    expect(taxYearStart('2026-03-15', 4)).toBe('2025-04-01');
    expect(taxYearStart('2026-07-01', 7)).toBe('2026-07-01');
    expect(taxYearStart('2026-06-30', 7)).toBe('2025-07-01');
    expect(taxYearStart('2026-11-18', 1)).toBe('2026-01-01');
    expect(taxYearMonthsRemaining('2026-07-01', 7)).toBe(12);
    expect(taxYearMonthsRemaining('2027-06-01', 7)).toBe(1);
    expect(taxYearMonthsRemaining('2026-12-01', 1)).toBe(1);
    expect(taxYearMonthsRemaining('2026-04-01', 4)).toBe(12);
  });
});

describe('country packs', () => {
  it('every pack is valid input and India keeps its own scheme', () => {
    for (const p of STATUTORY_PACKS) expect(anyStatutorySchema.safeParse(packFor(p.countryCode)!.settings).success, p.countryCode).toBe(true);
    expect(startingStatutory('IN').settings).toEqual(DEFAULT_IN_STATUTORY);
    expect(genericStatutorySchema.safeParse(DEFAULT_IN_STATUTORY).success).toBe(false);
  });

  it('any other country starts from a blank custom scheme', () => {
    const s = startingStatutory('DE', { taxYearStartMonth: 1, currency: 'EUR' });
    expect(s.pack).toBeNull();
    expect(s.settings).toMatchObject({ kind: 'generic', countryCode: 'DE', contributions: [], rounding: 'cent' });
    expect(customStatutory('JP', { currency: 'JPY' }).rounding).toBe('whole');
    expect(startingNotice('DE', null)).toMatch(/no ready-made pack/);
    expect(startingNotice('KW', null, 'KWD')).toMatch(/two decimal places/);
    expect(startingNotice('GB', s.pack ?? startingStatutory('GB').pack)).toMatch(/local payroll advisor/);
  });

  it('describes what the salary switches mean in each country', () => {
    expect(statutorySwitches(DEFAULT_IN_STATUTORY)).toMatchObject({ pf: 'Provident Fund', employerInCtc: true });
    expect(statutorySwitches(pack('AE'))).toEqual({ pf: 'UAE national (GPSSA pension)', esi: null, pt: null, tds: null, employerInCtc: false });
    expect(statutorySwitches(pack('US'))).toMatchObject({ pf: 'Enrolled in the 401(k) plan', pt: 'Regional income tax (by work location)', tds: 'Federal income tax' });
    expect(statutorySwitches(pack('AU')).pf).toBeNull();
  });
});

describe('generic scheme: United Kingdom', () => {
  const gb = input({ components: [comp('BASIC', '3000.00', { pfWage: true })] });

  it('works out PAYE, National Insurance and pension for a month', () => {
    const r = computePay(gb);
    expect(line(r, 'NI_EE')).toBe('156.16'); // 8% of (3,000 - 1,048)
    expect(line(r, 'NIUEL_EE')).toBeUndefined();
    expect(line(r, 'NIER_ER')).toBe('387.45'); // 15% of (3,000 - 417)
    expect(line(r, 'PENSION_EE')).toBe('124.00'); // 5% of (3,000 - 520)
    expect(line(r, 'PENSION_ER')).toBe('74.40');
    expect(r.taxableThisMonth).toBe('2876.00'); // pension comes off taxable pay
    expect(r.projectedAnnualTaxable).toBe('34512.00');
    expect(r.annualTax).toBe('4388.40'); // 20% of (34,512 - 12,570)
    expect(line(r, 'TAX')).toBe('365.70');
    expect(r.incomeTax).toBe('365.70');
    expect(r.net).toBe('2354.14');
    expect(r.employerContributions).toBe('461.85');
    expect(r.lines.some((l) => l.code.startsWith('PF') || l.code === 'TDS')).toBe(false);
  });

  it('is cumulative over the tax year', () => {
    const r = computePay({ ...gb, month: 5, daysInPeriod: 31, employedDays: 31, tax: { monthsRemaining: 11, ytdTaxable: '2876.00', ytdTds: '365.70' } });
    expect(line(r, 'TAX')).toBe('365.70');
  });

  it('leaves the pension out for people not enrolled, and flags high earners', () => {
    const r = computePay({ ...gb, apply: { ...gb.apply, pf: false } });
    expect(line(r, 'PENSION_EE')).toBeUndefined();
    const high = computePay({ ...gb, components: [comp('BASIC', '10000.00')] });
    expect(line(high, 'NI_EE')).toBe('251.28'); // 8% of (4,189 - 1,048)
    expect(line(high, 'NIUEL_EE')).toBe('116.22'); // 2% of (10,000 - 4,189)
    expect(high.warnings.join(' ')).toMatch(/personal allowance tapers/);
  });

  it('prorates pay and contributions for loss-of-pay days', () => {
    const r = computePay({ ...gb, lopDays: '15' });
    expect(r.gross).toBe('1500.00');
    expect(line(r, 'NI_EE')).toBe('36.16'); // 8% of (1,500 - 1,048)
  });
});

describe('generic scheme: other packs', () => {
  it('United States: FICA, federal withholding and state tax by region', () => {
    const r = computePay(input({
      currency: 'USD', month: 1, daysInPeriod: 31, employedDays: 31, statutory: pack('US'), components: [comp('BASIC', '10000.00')],
      apply: { pf: false, esi: false, pt: true, tds: true, ptState: 'Illinois' },
    }));
    expect(line(r, 'SS_EE')).toBe('620.00');
    expect(line(r, 'SS_ER')).toBe('620.00');
    expect(line(r, 'MEDICARE_EE')).toBe('145.00');
    expect(line(r, 'ADDMED_EE')).toBeUndefined();
    expect(line(r, 'K401_EE')).toBeUndefined();
    expect(r.annualTax).toBe('17570.00'); // on 120,000 - 16,100
    expect(line(r, 'TAX')).toBe('1464.17');
    expect(line(r, 'REGION_TAX')).toBe('495.00'); // 4.95% of 120,000
    expect(r.regionalTax).toBe('495.00');
    expect(r.net).toBe('7275.83');
    const texas = computePay(input({ currency: 'USD', month: 1, daysInPeriod: 31, employedDays: 31, statutory: pack('US'), components: [comp('BASIC', '10000.00')], apply: { pf: false, esi: false, pt: true, tds: true, ptState: 'Texas' } }));
    expect(line(texas, 'REGION_TAX')).toBeUndefined();
    expect(texas.explanation.join(' ')).toMatch(/No regional tax is set for Texas/);
  });

  it('United States: the Social Security wage base caps the contribution', () => {
    const r = computePay(input({ currency: 'USD', month: 1, daysInPeriod: 31, employedDays: 31, statutory: pack('US'), components: [comp('BASIC', '20000.00')], apply: { pf: true, esi: false, pt: false, tds: false, ptState: null } }));
    expect(line(r, 'SS_EE')).toBe('953.25'); // 6.2% of 15,375
    expect(line(r, 'ADDMED_EE')).toBe('30.00'); // 0.9% of (20,000 - 16,666.67), rounded to the cent
    expect(line(r, 'K401_EE')).toBe('1000.00');
  });

  it('Singapore: CPF for members only, whole dollars, with the wage ceiling', () => {
    const sg = input({ currency: 'SGD', month: 1, daysInPeriod: 31, employedDays: 31, statutory: pack('SG'), components: [comp('BASIC', '6000.00')] });
    const r = computePay(sg);
    expect(line(r, 'CPF_EE')).toBe('1200.00');
    expect(line(r, 'CPF_ER')).toBe('1020.00');
    expect(line(r, 'SDL_ER')).toBe('11.00'); // 0.25% of 4,500 = 11.25, whole dollars
    expect(line(r, 'TAX')).toBeUndefined();
    expect(line(computePay({ ...sg, components: [comp('BASIC', '9000.00')] }), 'CPF_EE')).toBe('1600.00');
    const foreigner = computePay({ ...sg, apply: { ...sg.apply, pf: false } });
    expect(foreigner.lines.filter((l) => l.kind !== 'earning').map((l) => l.code)).toEqual(['SDL_ER']);
    expect(line(computePay({ ...sg, components: [comp('BASIC', '700.00')] }), 'CPF_EE')).toBeUndefined();
  });

  it('United Arab Emirates and Saudi Arabia: contributions on contribution wages for nationals', () => {
    const comps = [comp('BASIC', '20000.00', { pfWage: true }), comp('HOUSING', '5000.00', { pfWage: true }), comp('TRANSPORT', '2000.00')];
    const ae = computePay(input({ currency: 'AED', month: 1, daysInPeriod: 31, employedDays: 31, statutory: pack('AE'), components: comps }));
    expect(line(ae, 'GPSSA_EE')).toBe('2750.00'); // 11% of 25,000
    expect(line(ae, 'GPSSA_ER')).toBe('3125.00');
    expect(line(ae, 'TAX')).toBeUndefined();
    const sa = computePay(input({ currency: 'SAR', month: 1, daysInPeriod: 31, employedDays: 31, statutory: pack('SA'), components: comps, apply: { pf: false, esi: false, pt: false, tds: true, ptState: null } }));
    expect(sa.lines.filter((l) => l.kind === 'employer' || l.kind === 'deduction').map((l) => [l.code, l.amount])).toEqual([['OCCHAZ_ER', '500.00']]);
  });

  it('Australia: July tax year, Medicare levy and super', () => {
    const r = computePay(input({ currency: 'AUD', month: 7, daysInPeriod: 31, employedDays: 31, statutory: pack('AU'), components: [comp('BASIC', '8000.00', { pfWage: true })] }));
    expect(line(r, 'SUPER_ER')).toBe('960.00');
    expect(r.annualTax).toBe('21240.00'); // 19,320 slab tax + 1,920 Medicare levy
    expect(line(r, 'TAX')).toBe('1770.00');
  });

  it('a custom scheme with no rules pays gross', () => {
    const r = computePay(input({ currency: 'EUR', statutory: customStatutory('DE'), components: [comp('BASIC', '4000.00')] }));
    expect(r.net).toBe('4000.00');
    expect(r.deductions).toBe('0.00');
  });
});

describe('salary split outside India', () => {
  it('treats the annual amount as gross pay and estimates employer contributions on top', () => {
    const lines = [{ code: 'BASIC', name: 'Basic', kind: 'earning' as const, calc: 'percent_of_ctc' as const, value: '50', isBasic: true }, { code: 'SPECIAL', name: 'Special', kind: 'earning' as const, calc: 'balance' as const, value: '0' }];
    const s = buildSalary('36000', lines, { pf: true, settings: pack('GB') });
    expect(s.components.map((c) => c.monthly)).toEqual(['1500.00', '1500.00']);
    expect(s.employerInCtc).toBe(false);
    expect(s.employerPfMonthly).toBe('461.85');
    expect(buildSalary('900000', lines, { pf: true, settings: DEFAULT_IN_STATUTORY }).employerInCtc).toBe(true);
  });
});
