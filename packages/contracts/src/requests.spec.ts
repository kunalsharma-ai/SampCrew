import { describe, expect, it } from 'vitest';
import { halfFromTimes, requestDays, requestInput, requestRef, requestStatusMessage, requestTimeLabel, requestTitle, requestWhen } from './requests';

const A = '0b9e4a1c-2f3d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1c0f5b2d-3e4f-4a6b-9c0d-1e2f3a4b5c6d';
const base = { reason: 'Plumber visiting at home', startDate: '2026-12-01', approverMembershipIds: [A] };

describe('staff requests', () => {
  it('words a request the same on every screen', () => {
    expect(requestRef('3f9a21bc-0000-4000-8000-000000000000')).toBe('REQ-3F9A21');
    expect(requestDays('2026-11-28', '2026-11-30')).toBe(3);
    expect(requestDays('2026-11-28')).toBe(1);
    expect(requestTimeLabel('09:30')).toBe('9:30 AM');
    expect(requestTimeLabel('16:05')).toBe('4:05 PM');
    expect(requestTimeLabel('00:00')).toBe('12:00 AM');
    expect(requestWhen({ kind: 'wfh', startDate: '2026-11-28', endDate: '2026-11-30' })).toBe('28 Nov 2026 to 30 Nov 2026 (3 days)');
    expect(requestWhen({ kind: 'early_leave', startDate: '2026-12-01', startTime: '16:30' })).toMatch(/^1 Dec 2026, .* 4:30 PM$/);
    expect(requestTitle('other', 'Laptop upgrade')).toBe('Laptop upgrade');
    expect(requestTitle('wfh')).toBe('Work from home');
    expect(halfFromTimes('09:00')).toBe('first_half');
    expect(halfFromTimes('14:00')).toBe('second_half');
  });

  it('tells the requester where the request stands', () => {
    expect(requestStatusMessage('pending', { approved: 1, total: 3, waitingOn: 'Manish Arora' })).toBe('Waiting for 2 of 3 approvers (Manish Arora).');
    expect(requestStatusMessage('approved', { approved: 2, total: 2 }, { applied: false, leadsToLeave: true })).toMatch(/Apply for the leave now/);
    expect(requestStatusMessage('approved', { approved: 2, total: 2 }, { applied: true, leadsToLeave: true })).toMatch(/leave application has been sent/);
    expect(requestStatusMessage('rejected', { approved: 0, total: 2 })).toMatch(/reason/);
  });

  it('checks dates, times and approvers before a request is sent', () => {
    expect(requestInput.safeParse({ ...base, kind: 'wfh', endDate: '2026-12-03' }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', endDate: '2026-11-30' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'late_coming' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'late_coming', startTime: '10:30' }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'early_leave', startTime: '16:00', endDate: '2026-12-02' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'half_day', startTime: '10:00' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'half_day', startTime: '10:00', endTime: '09:00' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'comp_off' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'comp_off', workedOn: '2026-11-22' }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'other' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', approverMembershipIds: [] }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', approverMembershipIds: [A, A] }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', approverMembershipIds: [A, B] }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', reason: 'no' }).success).toBe(false);
  });
});
