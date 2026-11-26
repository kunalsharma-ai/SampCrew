import { describe, expect, it } from 'vitest';
import { classifyWorkMode, resolveZone, workModeLabel, workModeSettingsInput, DEFAULT_WORK_MODE_SETTINGS, type ClassifyInput, type ModePunch, type WorkPlace } from './work-mode';
import { fromLocal, hhmm } from './zoned-time';

const IST = 'Asia/Kolkata';
const D = '2026-03-10';
const at = (t: string) => fromLocal(D, hhmm(t), IST);
const rules = { minOfficeMinutes: 60, minRemoteMinutes: 60, transition: 'split' as const };
const run = (punches: [string, 'in' | 'out', ModePunch['zone'], string?][], over: Partial<ClassifyInput> = {}) =>
  classifyWorkMode({
    timeZone: IST, now: at('23:00'), dayOpen: false, rules,
    punches: punches.map(([t, direction, zone, place]) => ({ at: at(t), direction, zone, place: place ?? null })),
    ...over,
  });

const office: WorkPlace = { id: 'o1', name: 'Pune Office', kind: 'office', lat: 18.5204, lon: 73.8567, radiusM: 200, countsAs: 'office' };
const client: WorkPlace = { id: 's1', name: 'Client HQ', kind: 'site', lat: 18.6, lon: 73.9, radiusM: 150, countsAs: 'office' };

describe('where a punch was', () => {
  it('inside an office geofence is office; outside every place is remote', () => {
    expect(resolveZone({ lat: 18.5205, lon: 73.8568, accuracyM: 20 }, [office], { maxAccuracyM: 150 })).toMatchObject({ zone: 'office', verification: 'verified', place: { name: 'Pune Office' } });
    expect(resolveZone({ lat: 18.55, lon: 73.8567, accuracyM: 20 }, [office], { maxAccuracyM: 150 })).toMatchObject({ zone: 'remote', verification: 'verified', place: null });
  });

  it('an approved site counts as its own setting', () => {
    expect(resolveZone({ lat: 18.6001, lon: 73.9, accuracyM: 10 }, [office, client], { maxAccuracyM: 150 })).toMatchObject({ zone: 'office', place: { kind: 'site', name: 'Client HQ' } });
    expect(resolveZone({ lat: 18.6001, lon: 73.9, accuracyM: 10 }, [office, { ...client, countsAs: 'remote' }], { maxAccuracyM: 150 }).zone).toBe('remote');
  });

  it('no reading, a refused permission, a mock location or a vague reading near the fence is unverified, never home', () => {
    expect(resolveZone(null, [office], { maxAccuracyM: 150, status: 'denied' })).toMatchObject({ zone: 'unverified', verification: 'denied' });
    expect(resolveZone(null, [office], { maxAccuracyM: 150, status: 'timeout' })).toMatchObject({ zone: 'unverified', verification: 'unavailable' });
    expect(resolveZone({ lat: 18.5205, lon: 73.8568, accuracyM: 5, mock: true }, [office], { maxAccuracyM: 150 })).toMatchObject({ zone: 'unverified', verification: 'mock_location' });
    // 400 m away with a 600 m accuracy circle: could be either.
    expect(resolveZone({ lat: 18.5240, lon: 73.8567, accuracyM: 600 }, [office], { maxAccuracyM: 150 })).toMatchObject({ zone: 'unverified', verification: 'poor_accuracy' });
  });

  it('a vague reading is still decided when it is certainly inside or certainly outside', () => {
    expect(resolveZone({ lat: 18.5204, lon: 73.8567, accuracyM: 180 }, [{ ...office, radiusM: 500 }], { maxAccuracyM: 150 }).zone).toBe('office');
    expect(resolveZone({ lat: 18.70, lon: 73.8567, accuracyM: 900 }, [office], { maxAccuracyM: 150 })).toMatchObject({ zone: 'remote', verification: 'verified' });
  });
});

describe('classifying a day', () => {
  it('in and out at the office is office; at home is remote', () => {
    expect(run([['09:00', 'in', 'office', 'Pune Office'], ['18:00', 'out', 'office', 'Pune Office']])).toMatchObject({ state: 'office', officeMinutes: 540, remoteMinutes: 0, places: ['Pune Office'] });
    expect(run([['09:00', 'in', 'remote'], ['18:00', 'out', 'remote']])).toMatchObject({ state: 'remote', officeMinutes: 0, remoteMinutes: 540 });
  });

  it('in at the office and out from home is hybrid, the time between split by the rule', () => {
    const r = run([['09:00', 'in', 'office', 'Pune Office'], ['18:00', 'out', 'remote']]);
    expect(r).toMatchObject({ state: 'hybrid', officeMinutes: 270, remoteMinutes: 270 });
    expect(r.transitions).toHaveLength(1);
    expect(run([['09:00', 'in', 'office'], ['18:00', 'out', 'remote']], { rules: { ...rules, transition: 'check_in' } })).toMatchObject({ state: 'office', officeMinutes: 540 });
  });

  it('a location update in the day makes the split exact', () => {
    const r = run([['09:00', 'in', 'remote'], ['18:00', 'out', 'remote']], { checkpoints: [{ at: at('11:00'), zone: 'office', place: 'Pune Office' }, { at: at('15:00'), zone: 'remote' }] });
    // Readings at 09:00 home, 11:00 office, 15:00 home, 18:00 home: each move between two readings is split.
    expect(r).toMatchObject({ state: 'hybrid', officeMinutes: 60 + 120, remoteMinutes: 60 + 120 + 180 });
  });

  it('a short time away (a lunch outside) does not make the day hybrid', () => {
    const r = run([['09:00', 'in', 'office'], ['13:00', 'out', 'office'], ['13:10', 'in', 'remote'], ['13:50', 'out', 'remote'], ['14:00', 'in', 'office'], ['18:00', 'out', 'office']]);
    expect(r.state).toBe('office');
    expect(r.remoteMinutes).toBe(40);
    expect(r.issues).toContain('short_remote_stay');
  });

  it('any unverified check-in or check-out is pending verification, with the verified guess kept', () => {
    const r = run([['09:00', 'in', 'office'], ['18:00', 'out', 'unverified']]);
    expect(r).toMatchObject({ state: 'pending_verification', guess: 'office', unverifiedMinutes: 270 });
    expect(r.issues).toContain('location_unverified');
  });

  it('a day still open is provisional and counts up to now', () => {
    const r = run([['09:00', 'in', 'office']], { dayOpen: true, now: at('12:00') });
    expect(r).toMatchObject({ state: 'office', provisional: true, officeMinutes: 180 });
  });

  it('just checked in, the day is where the check-in was', () => {
    expect(run([['09:00', 'in', 'office']], { dayOpen: true, now: at('09:00') })).toMatchObject({ state: 'office', provisional: true, officeMinutes: 0 });
    expect(run([['09:00', 'in', 'unverified']], { dayOpen: true, now: at('09:00') })).toMatchObject({ state: 'pending_verification', provisional: true });
  });

  it('a missing check-out after the day is not counted and is flagged', () => {
    const r = run([['09:00', 'in', 'office']]);
    expect(r).toMatchObject({ state: null, provisional: false });
    expect(r.issues).toContain('missing_check_out');
  });

  it('a correction punch takes the zone of the other end of its interval', () => {
    expect(run([['09:00', 'in', 'office'], ['18:00', 'out', 'neutral']])).toMatchObject({ state: 'office', officeMinutes: 540 });
    expect(run([['09:00', 'in', 'neutral'], ['18:00', 'out', 'neutral']])).toMatchObject({ state: 'pending_verification' });
  });

  it('approved work from home with no punches counts as remote', () => {
    expect(run([], { approvedRemote: 'full' })).toMatchObject({ state: 'remote', officeMinutes: 0 });
  });

  it('hybrid minimums are configurable', () => {
    const p: [string, 'in' | 'out', 'office' | 'remote'][] = [['09:00', 'in', 'office'], ['11:00', 'out', 'office'], ['12:00', 'in', 'remote'], ['13:30', 'out', 'remote']];
    expect(run(p).state).toBe('hybrid');
    expect(run(p, { rules: { ...rules, minRemoteMinutes: 120 } }).state).toBe('office');
  });
});

describe('labels and settings', () => {
  it('custom names never change the stored value', () => {
    const labels = { office: 'Office Attendance', remote: 'Remote Attendance', hybrid: 'Hybrid Attendance' };
    expect(workModeLabel('office', labels)).toBe('Office Attendance');
    expect(workModeLabel('pending_verification', labels)).toBe('Pending verification');
    expect(workModeLabel(null)).toBe('Not classified');
    expect(workModeSettingsInput.safeParse({ ...DEFAULT_WORK_MODE_SETTINGS }).success).toBe(true);
    expect(workModeSettingsInput.safeParse({ ...DEFAULT_WORK_MODE_SETTINGS, labels: { ...labels, office: 'x' } }).success).toBe(false);
  });
});
