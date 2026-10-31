import { describe, expect, it } from 'vitest';
import { accrualsDue, applyRounding, countLeaveDays, fromH, toH, yearEnd } from './leave-math';

const weekdays = { weeklyOffs: [0, 6], holidays: new Set<string>() };

describe('decimal day quantities', () => {
  it('round-trips without floating point error', () => {
    expect(fromH(toH('1.5'))).toBe('1.50');
    expect(fromH(toH('0.1') + toH('0.2'))).toBe('0.30');
    expect(fromH(toH('-2.25'))).toBe('-2.25');
    expect(() => toH('1.234')).toThrow();
  });
  it('rounds to the nearest half day', () => {
    expect(applyRounding(124, 'half_day')).toBe(100);
    expect(applyRounding(125, 'half_day')).toBe(150);
    expect(applyRounding(175, 'half_day')).toBe(200);
    expect(applyRounding(133, 'none')).toBe(133);
  });
});

describe('counting leave days', () => {
  it('skips weekends', () => {
    // Fri 2026-11-06 to Tue 2026-11-10 = Fri, Mon, Tue
    expect(countLeaveDays({ startDate: '2026-11-06', endDate: '2026-11-10', startHalf: 'full', endHalf: 'full' }, weekdays)).toBe(300);
  });
  it('skips holidays but not optional ones (the caller passes only mandatory dates)', () => {
    const cal = { weeklyOffs: [0, 6], holidays: new Set(['2026-12-25']) };
    expect(countLeaveDays({ startDate: '2026-12-24', endDate: '2026-12-28', startHalf: 'full', endHalf: 'full' }, cal)).toBe(200);
  });
  it('counts half days at either end', () => {
    expect(countLeaveDays({ startDate: '2026-11-09', endDate: '2026-11-11', startHalf: 'second_half', endHalf: 'first_half' }, weekdays)).toBe(200);
    expect(countLeaveDays({ startDate: '2026-11-09', endDate: '2026-11-09', startHalf: 'second_half', endHalf: 'full' }, weekdays)).toBe(50);
    expect(countLeaveDays({ startDate: '2026-11-09', endDate: '2026-11-09', startHalf: 'full', endHalf: 'first_half' }, weekdays)).toBe(50);
  });
  it('a half day on a weekend counts as zero', () => {
    expect(countLeaveDays({ startDate: '2026-11-07', endDate: '2026-11-09', startHalf: 'second_half', endHalf: 'full' }, weekdays)).toBe(100);
  });
  it('supports six-day work weeks', () => {
    const sixDay = { weeklyOffs: [0], holidays: new Set<string>() };
    expect(countLeaveDays({ startDate: '2026-11-02', endDate: '2026-11-08', startHalf: 'full', endHalf: 'full' }, sixDay)).toBe(600);
  });
});

describe('accrual', () => {
  const monthly = { accrualMethod: 'monthly' as const, annualEntitlement: toH('12'), rounding: 'none' as const };
  const longServing = { dateOfJoining: '2020-04-01', lastWorkingDay: null };

  it('credits one twelfth on the first of each month up to the as-of date', () => {
    const c = accrualsDue(monthly, longServing, '2026-03-15');
    expect(c.map((x) => [x.key, x.effectiveOn, fromH(x.quantity)])).toEqual([
      ['M2026-01', '2026-01-01', '1.00'],
      ['M2026-02', '2026-02-01', '1.00'],
      ['M2026-03', '2026-03-01', '1.00'],
    ]);
  });
  it('prorates the joining month by calendar days employed', () => {
    // Joined 16 Nov: 15 of 30 days -> 0.5 of a month -> 0.50 day of a 12-day entitlement
    const c = accrualsDue(monthly, { dateOfJoining: '2026-11-16', lastWorkingDay: null }, '2026-12-01');
    expect(c.map((x) => [x.key, fromH(x.quantity)])).toEqual([['M2026-11', '0.50'], ['M2026-12', '1.00']]);
  });
  it('stops after the last working day and prorates the exit month', () => {
    const c = accrualsDue(monthly, { dateOfJoining: '2020-01-01', lastWorkingDay: '2026-02-14' }, '2026-06-01');
    expect(c.map((x) => [x.key, fromH(x.quantity)])).toEqual([['M2026-01', '1.00'], ['M2026-02', '0.50']]);
  });
  it('applies half-day rounding to each credit', () => {
    const p = { accrualMethod: 'monthly' as const, annualEntitlement: toH('15'), rounding: 'half_day' as const };
    // 15/12 = 1.25 -> 1.50 (halves round up)
    expect(accrualsDue(p, longServing, '2026-01-01').map((x) => fromH(x.quantity))).toEqual(['1.50']);
  });
  it('credits up-front entitlement on 1 January, prorated for joiners', () => {
    const p = { accrualMethod: 'annual_upfront' as const, annualEntitlement: toH('20'), rounding: 'half_day' as const };
    expect(accrualsDue(p, longServing, '2026-01-01').map((x) => [x.key, x.effectiveOn, fromH(x.quantity)])).toEqual([['Y2026', '2026-01-01', '20.00']]);
    // Joined 2 Jul 2026: 183 of 365 days -> 10.03 -> 10.00
    expect(accrualsDue(p, { dateOfJoining: '2026-07-02', lastWorkingDay: null }, '2026-07-02').map((x) => fromH(x.quantity))).toEqual(['10.00']);
    expect(accrualsDue(p, { dateOfJoining: '2026-07-02', lastWorkingDay: null }, '2026-07-01')).toEqual([]);
  });
  it('credits nothing for policies without accrual or before joining', () => {
    expect(accrualsDue({ ...monthly, accrualMethod: 'none' }, longServing, '2026-06-01')).toEqual([]);
    expect(accrualsDue(monthly, { dateOfJoining: '2027-01-10', lastWorkingDay: null }, '2026-12-31')).toEqual([]);
  });
  it('is stable: the same inputs always produce the same keys', () => {
    expect(accrualsDue(monthly, longServing, '2026-05-20')).toEqual(accrualsDue(monthly, longServing, '2026-05-20'));
  });
});

describe('year end', () => {
  it('carries forward up to the cap and lapses the rest', () => {
    expect(yearEnd(toH('12.5'), toH('10'))).toEqual({ carry: 1000, lapse: 250 });
    expect(yearEnd(toH('4'), toH('10'))).toEqual({ carry: 400, lapse: 0 });
    expect(yearEnd(toH('4'), 0)).toEqual({ carry: 0, lapse: 400 });
  });
  it('carries a negative balance forward in full', () => {
    expect(yearEnd(toH('-1.5'), toH('10'))).toEqual({ carry: -150, lapse: 0 });
  });
});
