import { describe, expect, it } from 'vitest';
import { bidInput, bidSendInput, clientInput, formatAmount, priceBid } from './staffing';

const base = { onCostPct: '13', overheadPct: '5', targetMarginPct: '18', durationMonths: 12 };

describe('priceBid', () => {
  it('derives the bill rate from the target margin, rounded up to a whole unit', () => {
    const p = priceBid({ ...base, lines: [{ roleTitle: 'Recruiter', headcount: 5, payMonthly: '40000' }] });
    const l = p.lines[0]!;
    // 40000 + 13% + 5% = 47200 loaded; 47200 / 0.82 = 57560.97... -> 57561
    expect(l.loadedCostMonthly).toBe('47200.00');
    expect(l.billMonthly).toBe('57561.00');
    expect(l.billDerived).toBe(true);
    expect(l.monthlyRevenue).toBe('287805.00');
    expect(l.monthlyCost).toBe('236000.00');
    expect(l.monthlyMargin).toBe('51805.00');
    expect(l.marginPct).toBe('18.00');
    expect(l.markupPct).toBe('21.95');
    expect(l.belowTarget).toBe(false);
    expect(p.contractRevenue).toBe('3453660.00');
    expect(p.contractMargin).toBe('621660.00');
    expect(p.headcount).toBe(5);
  });

  it('uses a given bill rate and flags margins below target or below cost', () => {
    const p = priceBid({
      ...base,
      lines: [
        { roleTitle: 'Team lead', headcount: 1, payMonthly: '90000', billMonthly: '130000' },
        { roleTitle: 'Associate', headcount: 10, payMonthly: '25000', billMonthly: '29000' },
      ],
    });
    expect(p.lines[0]!.marginPct).toBe('18.31');
    expect(p.lines[0]!.belowTarget).toBe(false);
    // 25000 x 1.18 = 29500 loaded > 29000 bill: loss-making line
    expect(p.lines[1]!.monthlyMargin).toBe('-5000.00');
    expect(p.lines[1]!.marginPct).toBe('-1.72');
    expect(p.lines[1]!.belowTarget).toBe(true);
    expect(p.monthlyRevenue).toBe('420000.00');
    expect(p.monthlyCost).toBe('401200.00');
    expect(p.marginPct).toBe('4.48');
    expect(p.belowTarget).toBe(true);
    expect(p.lossMaking).toBe(false);
  });

  it('is exact with paise and zero overheads', () => {
    const p = priceBid({ onCostPct: '0', overheadPct: '0', targetMarginPct: '0', durationMonths: 3, lines: [{ roleTitle: 'Analyst', headcount: 3, payMonthly: '33333.33' }] });
    expect(p.lines[0]!.billMonthly).toBe('33334.00');
    expect(p.contractCost).toBe('299999.97');
    expect(p.lossMaking).toBe(false);
  });

  it('refuses a 100% target margin', () => {
    expect(() => priceBid({ ...base, targetMarginPct: '100', lines: [{ roleTitle: 'X', headcount: 1, payMonthly: '1' }] })).toThrow();
  });
});

describe('staffing schemas', () => {
  const valid = {
    clientId: '00000000-0000-4000-8000-000000000001', legalEntityId: '00000000-0000-4000-8000-000000000002', title: 'Recruiters for Q1',
    startDate: '2026-12-01', durationMonths: 6, onCostPct: '13', overheadPct: '5', targetMarginPct: '18',
    lines: [{ roleTitle: 'Recruiter', headcount: 5, payMonthly: '40000' }],
  };
  it('accepts a bid and defaults the mode and currency', () => {
    const b = bidInput.parse(valid);
    expect(b.mode).toBe('advanced');
    expect(b.currency).toBe('INR');
  });
  it('refuses empty lines, zero pay, unknown fields and a 100% margin', () => {
    expect(bidInput.safeParse({ ...valid, lines: [] }).success).toBe(false);
    expect(bidInput.safeParse({ ...valid, lines: [{ roleTitle: 'R', headcount: 1, payMonthly: '0' }] }).success).toBe(false);
    expect(bidInput.safeParse({ ...valid, cost: 1 }).success).toBe(false);
    expect(bidInput.safeParse({ ...valid, targetMarginPct: '100' }).success).toBe(false);
  });
  it('validates clients and sending', () => {
    expect(clientInput.parse({ name: 'Acme Logistics', currency: 'usd' }).currency).toBe('USD');
    expect(clientInput.safeParse({ name: 'A' }).success).toBe(false);
    expect(bidSendInput.safeParse({ to: 'buyer@acme.test', subject: 'Proposal', message: 'Hi', sendAt: '2026-12-01T09:00:00+05:30' }).success).toBe(true);
    expect(bidSendInput.safeParse({ to: 'not-an-email', subject: 'Proposal', message: 'Hi' }).success).toBe(false);
  });
});

describe('formatAmount', () => {
  it('groups INR the Indian way and others in thousands', () => {
    expect(formatAmount('3453660.00')).toBe('34,53,660.00');
    expect(formatAmount('999.5')).toBe('999.50');
    expect(formatAmount('1234567.00', 'USD')).toBe('1,234,567.00');
    expect(formatAmount('-5000.00')).toBe('-5,000.00');
  });
});
