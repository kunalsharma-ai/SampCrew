import { describe, expect, it } from 'vitest';
import { computeDay, dayWindowStart, geofenceCheck, shiftLength, type DayInput, type ShiftRule } from './attendance-engine';
import { addDays, fromLocal, hhmm, offsetMinutes, toLocal } from './zoned-time';

const IST = 'Asia/Kolkata';
const D = '2026-03-10'; // a Tuesday
const at = (time: string, date = D, tz = IST) => fromLocal(date, hhmm(time), tz);
const general: ShiftRule = {
  startMinutes: hhmm('09:00'), endMinutes: hhmm('18:00'), breakMinutes: 60, graceLateMinutes: 10, graceEarlyMinutes: 10,
  halfDayMinutes: 240, fullDayMinutes: 480, overtimeEnabled: false, overtimeMinMinutes: 30,
};
const later = at('23:59', addDays(D, 2));
const day = (over: Partial<DayInput> & { times?: (string | [string, 'in' | 'out' | 'unknown'])[] }): ReturnType<typeof computeDay> => {
  const { times = [], ...rest } = over;
  return computeDay({
    workDate: D, timeZone: IST, shift: general, dayType: 'working', leave: null, now: later, employed: true,
    punches: times.map((t) => (typeof t === 'string' ? { at: at(t), direction: 'unknown' as const } : { at: at(t[0]), direction: t[1] })),
    ...rest,
  });
};

describe('zoned time', () => {
  it('converts local wall-clock time to instants and back, with and without daylight saving', () => {
    expect(new Date(fromLocal('2026-03-10', hhmm('09:00'), IST)).toISOString()).toBe('2026-03-10T03:30:00.000Z');
    expect(new Date(fromLocal('2026-01-15', hhmm('09:00'), 'Europe/London')).toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(new Date(fromLocal('2026-07-01', hhmm('09:00'), 'Europe/London')).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(60);
    expect(toLocal(Date.parse('2026-03-10T20:00:00Z'), IST)).toMatchObject({ date: '2026-03-11', minutes: hhmm('01:30') });
    // Minutes past 24:00 roll into the next day (night shifts).
    expect(new Date(fromLocal('2026-03-10', 24 * 60 + hhmm('06:00'), IST)).toISOString()).toBe('2026-03-11T00:30:00.000Z');
    // 01:30 does not exist in London on the spring-forward day; it lands on a valid instant, not an error.
    expect(Number.isFinite(fromLocal('2026-03-29', hhmm('01:30'), 'Europe/London'))).toBe(true);
  });
});

describe('attendance engine', () => {
  it('a normal day: present, scheduled break deducted, no late or early', () => {
    const r = day({ times: ['08:55', '18:05'] });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 550 - 60, breakMinutes: 60, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, flags: [] });
    expect(r.explanation.join(' ')).toContain('Deducted 60 minutes of unpaid break');
  });

  it('late arrival counts from the shift start once it is past the grace period', () => {
    expect(day({ times: ['09:08', '18:00'] }).lateMinutes).toBe(0);
    const r = day({ times: ['09:25', '18:30'] });
    expect(r).toMatchObject({ status: 'present', lateMinutes: 25, flags: ['late'] });
    expect(r.explanation).toContain('Arrived at 09:25, 25 minutes after the shift start of 09:00 (grace 10 min).');
  });

  it('early leaving is measured against the shift end', () => {
    // Leaving 30 minutes early also drops below the full-day minimum.
    expect(day({ times: ['09:00', '17:30'] })).toMatchObject({ earlyLeaveMinutes: 30, flags: ['early_leave', 'short_hours'], status: 'half_day', workedMinutes: 450 });
    expect(day({ times: ['09:00', '17:55'] }).earlyLeaveMinutes).toBe(0);
  });

  it('punched breaks count, and only the shortfall against the scheduled break is deducted', () => {
    const r = day({ times: ['09:00', '13:00', '13:30', '18:00'] });
    expect(r).toMatchObject({ workedMinutes: 510 - 30, breakMinutes: 60 });
    const long = day({ times: ['09:00', '13:00', '14:30', '18:00'] });
    expect(long).toMatchObject({ workedMinutes: 450, breakMinutes: 90 });
  });

  it('a missing punch out makes the day "missing punch" once the day is over', () => {
    const r = day({ times: [['09:00', 'in']] });
    expect(r).toMatchObject({ status: 'missing_punch', flags: ['missing_out'], lastOut: null });
  });

  it('a punch out with no punch in is flagged', () => {
    expect(day({ times: [['18:00', 'out']] })).toMatchObject({ status: 'missing_punch', flags: ['missing_in'] });
  });

  it('a day still under way is "in progress", counting time so far', () => {
    const r = day({ times: [['09:00', 'in']], now: at('12:00') });
    expect(r).toMatchObject({ status: 'in_progress', workedMinutes: 180, lastOut: null, flags: [] });
    expect(day({ times: [], now: at('08:00') }).status).toBe('in_progress');
  });

  it('no punches on a working day is absent; days off and holidays are not', () => {
    expect(day({ times: [] })).toMatchObject({ status: 'absent', explanation: ['No punches on a working day.'] });
    expect(day({ times: [], dayType: 'weekly_off' }).status).toBe('weekly_off');
    expect(day({ times: [], dayType: 'holiday' }).status).toBe('holiday');
  });

  it('work on a holiday is all overtime when the shift allows overtime', () => {
    const r = day({ times: ['10:00', '14:00'], dayType: 'holiday', shift: { ...general, overtimeEnabled: true } });
    expect(r).toMatchObject({ status: 'holiday', workedMinutes: 240, overtimeMinutes: 240, flags: ['off_day_work', 'overtime'] });
  });

  it('overtime is time beyond the scheduled shift, ignored below the minimum', () => {
    const ot = { ...general, overtimeEnabled: true };
    expect(day({ times: ['09:00', '19:30'], shift: ot })).toMatchObject({ workedMinutes: 570, overtimeMinutes: 90, flags: ['overtime'] });
    const r = day({ times: ['09:00', '18:20'], shift: ot });
    expect(r.overtimeMinutes).toBe(0);
    expect(r.explanation.join(' ')).toContain('below the overtime minimum of 30 minutes');
    expect(day({ times: ['09:00', '19:30'] }).overtimeMinutes).toBe(0); // overtime disabled on the shift
  });

  it('night shifts across midnight', () => {
    const night: ShiftRule = { ...general, startMinutes: hhmm('22:00'), endMinutes: hhmm('06:00'), breakMinutes: 30, fullDayMinutes: 450 };
    expect(shiftLength(night)).toBe(480);
    const r = computeDay({
      workDate: D, timeZone: IST, shift: night, dayType: 'working', leave: null, now: later, employed: true,
      punches: [{ at: at('21:55'), direction: 'in' }, { at: at('06:10', addDays(D, 1)), direction: 'out' }],
    });
    expect(r).toMatchObject({ status: 'present', workedMinutes: 495 - 30, lateMinutes: 0, earlyLeaveMinutes: 0 });
    // Still on shift at 02:00 the next morning.
    const during = computeDay({
      workDate: D, timeZone: IST, shift: night, dayType: 'working', leave: null, now: at('02:00', addDays(D, 1)), employed: true,
      punches: [{ at: at('22:20'), direction: 'in' }],
    });
    expect(during).toMatchObject({ status: 'in_progress', lateMinutes: 20 });
  });

  it('repeated taps on a device count once', () => {
    const r = day({ times: ['09:00', '09:01', '18:00', '18:00'] });
    expect(r).toMatchObject({ status: 'present', punchesUsed: 2, flags: ['duplicate_punches'] });
  });

  it('known directions are respected; two ins in a row leave the first without an out', () => {
    const r = day({ times: [['08:00', 'in'], ['09:00', 'in'], ['18:00', 'out']] });
    expect(r.flags).toContain('missing_out');
    expect(r.status).toBe('missing_punch');
  });

  it('half-day leave excuses the half it covers', () => {
    const r = day({ times: ['13:30', '18:00'], leave: 'first_half' });
    expect(r).toMatchObject({ status: 'half_day_leave', lateMinutes: 0 });
    expect(day({ times: ['09:00', '13:00'], leave: 'second_half' })).toMatchObject({ status: 'half_day_leave', earlyLeaveMinutes: 0 });
    expect(day({ times: [], leave: 'full' }).status).toBe('on_leave');
    expect(day({ times: [], leave: 'first_half' }).status).toBe('absent');
  });

  it('short days are half days or absent by the shift thresholds', () => {
    expect(day({ times: ['09:00', '14:30'] })).toMatchObject({ status: 'half_day', flags: ['early_leave', 'short_hours'] });
    expect(day({ times: ['09:00', '11:00'] })).toMatchObject({ status: 'absent', workedMinutes: 120 });
  });

  it('nothing is computed outside employment', () => {
    expect(day({ times: ['09:00', '18:00'], employed: false }).status).toBe('not_joined');
  });

  it('works without a shift, using local calendar days and default thresholds', () => {
    expect(day({ times: ['10:00', '19:00'], shift: null })).toMatchObject({ status: 'present', workedMinutes: 540, lateMinutes: 0 });
  });

  it('the punch window opens before the shift and ends where the next day begins', () => {
    expect(dayWindowStart(D, IST, general, 240)).toBe(at('05:00'));
    expect(dayWindowStart(D, IST, null, 240)).toBe(at('00:00'));
  });
});

describe('geofence', () => {
  const fence = { lat: 18.5204, lon: 73.8567, radiusM: 200 };
  it('inside, outside and unknown', () => {
    expect(geofenceCheck(fence, { lat: 18.5205, lon: 73.8568 }).result).toBe('inside');
    expect(geofenceCheck(fence, { lat: 18.53, lon: 73.8567 })).toMatchObject({ result: 'outside' });
    // A 150 m accuracy circle that reaches into the fence is given the benefit of the doubt.
    expect(geofenceCheck(fence, { lat: 18.5234, lon: 73.8567, accuracyM: 150 }).result).toBe('inside');
    expect(geofenceCheck(fence, { lat: 18.6, lon: 73.8567, accuracyM: 5000 }).result).toBe('unknown');
  });
});
