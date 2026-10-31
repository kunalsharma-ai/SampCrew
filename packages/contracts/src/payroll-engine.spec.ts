import { describe, expect, it } from 'vitest';
import { applyRate, divRound, formatMoney, fromMinor, toMinor } from './money';
import { annualTaxNewRegime, buildSalary, computePay, DEFAULT_IN_STATUTORY, fyMonthsRemaining, fyStart, type PayComponentInput, type PayrollInput } from './payroll-engine';

const comp = (code: string, monthly: string, o: Partial<PayComponentInput> = {}): PayComponentInput => ({ code, name: code, kind: 'earning', monthly, prorate: true, taxable: true, pfWage: code === 'BASIC', ...o });
const input = (o: Partial<PayrollInput> = {}): PayrollInput => ({
  currency: 'INR', month: 10, daysInPeriod: 31, employedDays: 31, lopDays: '0', components: [], adjustments: [], reimbursements: [],
  statutory: DEFAULT_IN_STATUTORY, apply: { pf: true, esi: true, pt: true, tds: true, ptState: 'Maharashtra' },
  tax: { monthsRemaining: 6, ytdTaxable: '0', ytdTds: '0' }, ...o,
});
const line = (r: ReturnType<typeof computePay>, code: string) => r.lines.find((l) => l.code === code)?.amount;

describe('money', () => {
  it('parses, prints and rounds exactly', () => {
    expect(toMinor('1234.5')).toBe(123450n);
    expect(fromMinor(-5n)).toBe('-0.05');
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n, 'up')).toBe(2n);
    expect(divRound(5n, 3n, 'down')).toBe(1n);
    expect(applyRate(toMinor('0.10'), '3', { percent: true })).toBe(0n); // 0.3 paise rounds to 0
    expect(fromMinor(toMinor('0.1') + toMinor('0.2'))).toBe('0.30'); // no floating point drift
    expect(formatMoney(toMinor('2600000'), 'INR')).toBe('INR 26,00,000.00');
    expect(formatMoney(toMinor('2600000'), 'GBP')).toBe('GBP 2,600,000.00');
    expect(() => toMinor('1.234')).toThrow();
  });
  it('knows the Indian financial year', () => {
    expect(fyStart('2026-10-15')).toBe('2026-04-01');
    expect(fyStart('2027-02-01')).toBe('2026-04-01');
    expect([fyMonthsRemaining('2026-04-01'), fyMonthsRemaining('2026-10-01'), fyMonthsRemaining('2027-03-01')]).toEqual([12, 6, 1]);
  });
});

describe('salary breakdown', () => {
  const lines = [
    { code: 'BASIC', name: 'Basic', kind: 'earning' as const, calc: 'percent_of_ctc' as const, value: '50', isBasic: true },
    { code: 'HRA', name: 'HRA', kind: 'earning' as const, calc: 'percent_of_basic' as const, value: '40' },
    { code: 'SPECIAL', name: 'Special allowance', kind: 'earning' as const, calc: 'balance' as const, value: '0' },
  ];
  it('splits CTC so components plus employer PF add up exactly', () => {
    const s = buildSalary('900000', lines, { pf: true, settings: DEFAULT_IN_STATUTORY });
    expect(s.components.map((c) => [c.code, c.monthly])).toEqual([['BASIC', '37500.00'], ['HRA', '15000.00'], ['SPECIAL', '20700.00']]);
    expect(s.employerPfMonthly).toBe('1800.00');
    expect(buildSalary('900000', lines, { pf: false, settings: DEFAULT_IN_STATUTORY }).components[2]!.monthly).toBe('22500.00');
  });
  it('refuses a structure larger than the CTC, and one without Basic', () => {
    expect(() => buildSalary('100000', [...lines.slice(0, 2), { code: 'CAR', name: 'Car', kind: 'earning', calc: 'fixed', value: '200000' }, lines[2]!], { pf: true, settings: DEFAULT_IN_STATUTORY })).toThrow(/more than the CTC/);
    expect(() => buildSalary('100000', lines.slice(1), { pf: true, settings: DEFAULT_IN_STATUTORY })).toThrow(/Basic/);
  });
});

describe('payroll engine', () => {
  it('pays a full month with PF on the capped wage, Maharashtra PT and no TDS under the rebate', () => {
    const r = computePay(input({ components: [comp('BASIC', '25000'), comp('HRA', '10000'), comp('SPECIAL', '12000')], tax: { monthsRemaining: 6, ytdTaxable: '282000', ytdTds: '0' } }));
    expect(r.gross).toBe('47000.00');
    expect([line(r, 'PF_EE'), line(r, 'PF_ER_EPS'), line(r, 'PF_ER_EPF')]).toEqual(['1800.00', '1250.00', '550.00']);
    expect(line(r, 'ESI_EE')).toBeUndefined();
    expect(line(r, 'PT')).toBe('200.00');
    expect(line(r, 'TDS')).toBeUndefined();
    expect(r.net).toBe('45000.00');
    expect(r.costToCompany).toBe('48800.00');
    expect(r.explanation.join(' ')).toMatch(/No ESI/);
  });

  it('spreads new-regime tax over the remaining months', () => {
    const r = computePay(input({ month: 4, daysInPeriod: 30, employedDays: 30, components: [comp('BASIC', '100000'), comp('SPECIAL', '100000')], tax: { monthsRemaining: 12, ytdTaxable: '0', ytdTds: '0' } }));
    expect(r.projectedAnnualTaxable).toBe('2400000.00');
    expect(r.annualTax).toBe('292500.00');
    expect(line(r, 'TDS')).toBe('24375.00');
    expect(r.net).toBe('173625.00');
  });

  it('takes TDS already deducted into account', () => {
    const r = computePay(input({ month: 10, components: [comp('BASIC', '100000'), comp('SPECIAL', '100000')], apply: { pf: false, esi: false, pt: false, tds: true, ptState: null }, tax: { monthsRemaining: 6, ytdTaxable: '1200000', ytdTds: '146250' } }));
    expect(line(r, 'TDS')).toBe('24375.00');
  });

  it('gives a full rebate up to the limit and marginal relief just above it', () => {
    const only = { pf: false, esi: false, pt: false, tds: true, ptState: null };
    const at = computePay(input({ month: 3, daysInPeriod: 31, components: [comp('BASIC', '100000')], apply: only, tax: { monthsRemaining: 1, ytdTaxable: '1175000', ytdTds: '0' } }));
    expect(at.annualTax).toBe('0.00');
    const above = computePay(input({ month: 3, daysInPeriod: 31, components: [comp('BASIC', '100000')], apply: only, tax: { monthsRemaining: 1, ytdTaxable: '1180000', ytdTds: '0' } }));
    expect(above.annualTax).toBe('5200.00'); // 5,000 above the limit + 4% cess
    expect(line(above, 'TDS')).toBe('5200.00');
    expect(annualTaxNewRegime(toMinor('1275000'), DEFAULT_IN_STATUTORY.tds).notes.join()).toMatch(/full rebate/);
  });

  it('prorates by paid days after loss of pay, in half days', () => {
    const r = computePay(input({ month: 9, daysInPeriod: 30, employedDays: 30, lopDays: '2.5', components: [comp('BASIC', '30000'), comp('HRA', '12000')], apply: { pf: true, esi: true, pt: false, tds: false, ptState: null } }));
    expect(r.paidDays).toBe('27.50');
    expect([line(r, 'BASIC'), line(r, 'HRA')]).toEqual(['27500.00', '11000.00']);
    expect(line(r, 'PF_EE')).toBe('1800.00');
    expect(r.explanation.join(' ')).toMatch(/2\.5 loss-of-pay day\(s\), so 27\.5 paid days/);
  });

  it('prorates a joiner by calendar days employed', () => {
    const r = computePay(input({ employedDays: 16, components: [comp('BASIC', '31000')], apply: { pf: false, esi: false, pt: false, tds: false, ptState: null } }));
    expect(r.gross).toBe('16000.00');
    expect(r.explanation[0]).toMatch(/16 of 31/);
  });

  it('applies ESI under the ceiling, rounding up, and the February PT amount', () => {
    const r = computePay(input({ month: 2, daysInPeriod: 28, employedDays: 28, components: [comp('BASIC', '10000'), comp('SPECIAL', '7999')], tax: { monthsRemaining: 2, ytdTaxable: '0', ytdTds: '0' } }));
    expect([line(r, 'ESI_EE'), line(r, 'ESI_ER')]).toEqual(['135.00', '585.00']);
    expect([line(r, 'PF_EE'), line(r, 'PF_ER_EPS'), line(r, 'PF_ER_EPF')]).toEqual(['1200.00', '833.00', '367.00']);
    expect(line(r, 'PT')).toBe('300.00');
  });

  it('uses Karnataka slabs and warns when a state has none', () => {
    const ka = (gross: string) => computePay(input({ components: [comp('SPECIAL', gross)], apply: { pf: false, esi: false, pt: true, tds: false, ptState: 'Karnataka' } }));
    expect(line(ka('25000'), 'PT')).toBe('200.00');
    expect(line(ka('24000'), 'PT')).toBeUndefined();
    const none = computePay(input({ components: [comp('SPECIAL', '30000')], apply: { pf: false, esi: false, pt: true, tds: false, ptState: 'Goa' } }));
    expect(none.warnings.join()).toMatch(/No professional tax slabs set for Goa/);
  });

  it('adds one-off adjustments and untaxed reimbursements, and flags a negative net', () => {
    const base = { components: [comp('BASIC', '20000')], apply: { pf: false, esi: false, pt: false, tds: false, ptState: null } };
    const r = computePay(input({ ...base, adjustments: [{ kind: 'earning', label: 'Diwali bonus', amount: '5000', taxable: true }], reimbursements: [{ label: 'Travel', amount: '1234.56' }] }));
    expect(r.gross).toBe('25000.00');
    expect(r.taxableThisMonth).toBe('25000.00');
    expect(r.reimbursements).toBe('1234.56');
    expect(r.net).toBe('26234.56');
    const neg = computePay(input({ ...base, adjustments: [{ kind: 'deduction', label: 'Advance recovery', amount: '25000', taxable: false }] }));
    expect(neg.net).toBe('-5000.00');
    expect(neg.warnings.join()).toMatch(/Deductions are more than pay/);
  });

  it('caps loss of pay at the days employed and keeps fixed deductions whole', () => {
    const r = computePay(input({ employedDays: 10, lopDays: '12', components: [comp('BASIC', '31000'), { code: 'CANTEEN', name: 'Canteen', kind: 'deduction', monthly: '500', prorate: false, taxable: false, pfWage: false }], apply: { pf: false, esi: false, pt: false, tds: false, ptState: null } }));
    expect(r.paidDays).toBe('0.00');
    expect(r.gross).toBe('0.00');
    expect(line(r, 'CANTEEN')).toBe('500.00');
    expect(r.warnings.join()).toMatch(/capped/);
  });
});
