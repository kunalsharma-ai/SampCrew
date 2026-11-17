import { describe, expect, it } from 'vitest';
import { deductionText, halfDays, isSameDayLeave, latePolicyInput, nextTier, reminderText, sameDayLeavePolicyInput, tierFor } from './discipline';

const tiers = latePolicyInput.parse({ enabled: true, tiers: [{ reminders: 5, basis: 'days', value: 1 }, { reminders: 3, basis: 'percent', value: '5.0' }] }).tiers;

describe('late-coming rules', () => {
  it('sorts tiers, normalises values and refuses duplicates, bad percentages and quarter days', () => {
    expect(tiers).toEqual([{ reminders: 3, basis: 'percent', value: '5' }, { reminders: 5, basis: 'days', value: '1' }]);
    expect(latePolicyInput.safeParse({ enabled: true, tiers: [{ reminders: 3, basis: 'days', value: '1' }, { reminders: 3, basis: 'percent', value: '2' }] }).success).toBe(false);
    expect(latePolicyInput.safeParse({ enabled: true, tiers: [{ reminders: 3, basis: 'percent', value: '0' }] }).success).toBe(false);
    expect(latePolicyInput.safeParse({ enabled: true, tiers: [{ reminders: 3, basis: 'days', value: '0.25' }] }).success).toBe(false);
    expect(latePolicyInput.parse({ enabled: false })).toMatchObject({ autoReminders: true, minLateMinutes: 1, email: true, notifyManager: false, tiers: [] });
  });

  it('applies only the highest tier reached and names the next one', () => {
    expect(tierFor(2, tiers)).toBeNull();
    expect(tierFor(3, tiers)?.value).toBe('5');
    expect(tierFor(4, tiers)?.reminders).toBe(3);
    expect(tierFor(9, tiers)?.reminders).toBe(5);
    expect(nextTier(3, tiers)?.reminders).toBe(5);
    expect(nextTier(5, tiers)).toBeNull();
  });

  it('explains a reminder in plain words', () => {
    const t = reminderText({ workDate: '2026-11-17', lateMinutes: 25, firstIn: '09:25', shiftStart: '09:00', note: null, count: 3, tiers, manual: false });
    expect(t).toBe(
      "You arrived at 09:25 on 2026-11-17, 25 minutes after your shift start of 09:00. This is late reminder 3 this month. Because you reached 3 reminders, 5% of the month's gross pay will be deducted from this month's salary. At 5 reminders, 1 day's pay is deducted.",
    );
    expect(reminderText({ workDate: '2026-11-17', lateMinutes: null, firstIn: null, shiftStart: null, note: 'Missed the briefing', count: 1, tiers: [], manual: true })).toBe(
      'This is about your arrival on 2026-11-17. Note from your manager: Missed the briefing This is late reminder 1 this month.',
    );
  });
});

describe('same-day leave', () => {
  it('counts leave starting today, and backdated leave when the rule says so', () => {
    expect(isSameDayLeave('2026-11-17', '2026-11-17', false)).toBe(true);
    expect(isSameDayLeave('2026-11-16', '2026-11-17', false)).toBe(false);
    expect(isSameDayLeave('2026-11-16', '2026-11-17', true)).toBe(true);
    expect(isSameDayLeave('2026-11-18', '2026-11-17', true)).toBe(false);
  });

  it('takes penalties in whole or half days', () => {
    expect(halfDays.parse('2')).toBe('2');
    expect(halfDays.parse(3.5)).toBe('3.5');
    expect(halfDays.parse('3.50')).toBe('3.5');
    expect(halfDays.safeParse('1.2').success).toBe(false);
    expect(halfDays.safeParse('0').success).toBe(false);
    expect(halfDays.safeParse('32').success).toBe(false);
    expect(sameDayLeavePolicyInput.parse({ enabled: true })).toMatchObject({ mode: 'manual', penaltyDays: '1', includeBackdated: true, exemptLeaveTypeIds: [] });
    expect(deductionText('days', '3.5')).toBe("3.5 days' pay");
    expect(deductionText('days', '1')).toBe("1 day's pay");
  });
});
