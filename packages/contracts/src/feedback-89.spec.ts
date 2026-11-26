import { describe, expect, it } from 'vitest';
import { classifyWorkMode, idleLabel, sessionPolicyInput, unverifiedReason, UNVERIFIED_BRIDGE_MINUTES, type ClassifyInput } from './index';
import { fromLocal, hhmm } from './zoned-time';

const IST = 'Asia/Kolkata';
const at = (t: string) => fromLocal('2026-03-10', hhmm(t), IST);
const base = (over: Partial<ClassifyInput>): ClassifyInput => ({
  timeZone: IST, now: at('23:00'), dayOpen: false, rules: { minOfficeMinutes: 60, minRemoteMinutes: 60, transition: 'split' }, punches: [], ...over,
});

describe('issue #89: a location that could not be read is settled by a verified one soon after', () => {
  it('an unverified check-in followed by a verified location update is no longer pending', () => {
    const r = classifyWorkMode(base({
      punches: [{ at: at('09:00'), direction: 'in', zone: 'unverified', place: null }, { at: at('18:00'), direction: 'out', zone: 'office', place: 'Pune Office' }],
      checkpoints: [{ at: at('09:05'), zone: 'office', place: 'Pune Office' }],
    }));
    expect(r).toMatchObject({ state: 'office', officeMinutes: 540, unverifiedMinutes: 0 });
  });

  it('while the day is open, pressing Update my location right after an unverified check-in shows office', () => {
    const r = classifyWorkMode(base({
      dayOpen: true, now: at('09:30'),
      punches: [{ at: at('09:00'), direction: 'in', zone: 'unverified', place: null }],
      checkpoints: [{ at: at('09:02'), zone: 'office', place: 'Pune Office' }],
    }));
    expect(r.state).toBe('office');
  });

  it('a long stretch with no verified reading still waits for HR', () => {
    const r = classifyWorkMode(base({
      punches: [{ at: at('09:00'), direction: 'in', zone: 'unverified', place: null }, { at: at('18:00'), direction: 'out', zone: 'office', place: null }],
    }));
    expect(UNVERIFIED_BRIDGE_MINUTES).toBe(120);
    expect(r.state).toBe('pending_verification');
  });

  it('the reason tells the person what to do', () => {
    expect(unverifiedReason('denied')).toMatch(/Allow location/);
    expect(unverifiedReason('poor_accuracy', { accuracyM: 2400, maxAccuracyM: 150 })).toMatch(/2\.4 km.*150 m/);
    expect(unverifiedReason('unavailable')).toMatch(/location services/);
  });
});

describe('issue #89: one auto sign-out time for everyone', () => {
  it('only the listed choices are accepted, and 0 turns it off', () => {
    expect(sessionPolicyInput.safeParse({ idleMinutes: 30 }).success).toBe(true);
    expect(sessionPolicyInput.safeParse({ idleMinutes: 7 }).success).toBe(false);
    expect(idleLabel(null)).toMatch(/off|never/i);
    expect(idleLabel(60)).toMatch(/1 hour/);
  });
});
