import { describe, expect, it } from 'vitest';
import { evaluateReward, type RewardDay, type RewardRuleInput } from './rewards';

const perfect: RewardRuleInput = { name: 'Perfect', kind: 'perfect_attendance', description: null, icon: 'trophy', active: true, maxLateDays: 0, excusedLeaveTypeIds: ['sick'], allowHalfDays: false, minWorkingDays: 3 };
const onTime: RewardRuleInput = { ...perfect, name: 'On time', kind: 'punctuality', allowHalfDays: true };
const day = (date: string, status = 'present', extra: Partial<RewardDay> = {}): RewardDay => ({ date, dayType: 'working', status, lateMinutes: 0, ...extra });

describe('attendance rewards', () => {
  const month = [day('2026-10-01'), day('2026-10-02'), day('2026-10-03', 'weekly_off', { dayType: 'weekly_off' }), day('2026-10-05'), day('2026-10-06', 'holiday', { dayType: 'holiday' })];

  it('earns perfect attendance when every working day is present; holidays and weekly offs never count', () => {
    expect(evaluateReward(perfect, month, true)).toEqual({ status: 'earned', done: 3, total: 3, reason: null });
  });

  it('sick leave (an excused type) does not break it; other leave and absence do', () => {
    const sick = [...month, day('2026-10-07', 'on_leave', { leaveTypeId: 'sick' })];
    expect(evaluateReward(perfect, sick, true).status).toBe('earned');
    const casual = [...month, day('2026-10-07', 'on_leave', { leaveTypeId: 'casual' })];
    expect(evaluateReward(perfect, casual, true)).toMatchObject({ status: 'missed', reason: 'Leave on 2026-10-07' });
    expect(evaluateReward(perfect, [...month, day('2026-10-08', 'absent')], false)).toMatchObject({ status: 'missed', reason: 'Absent on 2026-10-08' });
  });

  it('an open month is on track until something breaks it', () => {
    expect(evaluateReward(perfect, month.slice(0, 2), false).status).toBe('on_track');
  });

  it('punctuality counts late arrivals against the allowance', () => {
    const late = [...month, day('2026-10-07', 'present', { lateMinutes: 12 })];
    expect(evaluateReward(onTime, late, true)).toMatchObject({ status: 'missed', reason: 'Late on 1 day' });
    expect(evaluateReward({ ...onTime, maxLateDays: 1 }, late, true)).toMatchObject({ status: 'earned', done: 3, total: 4 });
  });

  it('a month with too few working days (new joiner) is not eligible', () => {
    expect(evaluateReward({ ...perfect, minWorkingDays: 10 }, month, true)).toMatchObject({ status: 'not_eligible' });
  });
});
