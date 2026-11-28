import { describe, expect, it } from 'vitest';
import { defaultRequestCategories, hoursBetween, requestDays, requestInput, requestLeaveInput, requestRef, requestStatusMessage, requestTimeLabel, requestTitle, requestWhen } from './requests';

const A = '0b9e4a1c-2f3d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1c0f5b2d-3e4f-4a6b-9c0d-1e2f3a4b5c6d';
const C = '2d1a6c3e-4f5a-4b7c-8d1e-2f3a4b5c6d7e';
const T = '3e2b7d4f-5a6b-4c8d-9e2f-3a4b5c6d7e8f';
const base = { reason: 'Plumber visiting at home', startDate: '2026-12-01', primaryApproverId: A };

describe('staff requests', () => {
  it('words a request the same on every screen', () => {
    expect(requestRef('3f9a21bc-0000-4000-8000-000000000000')).toBe('REQ-3F9A21');
    expect(requestRef('3f9a21bc-0000-4000-8000-000000000000', 'leave')).toBe('LV-3F9A21');
    expect(requestDays('2026-11-28', '2026-11-30')).toBe(3);
    expect(requestDays('2026-11-28')).toBe(1);
    expect(requestTimeLabel('09:30')).toBe('9:30 AM');
    expect(requestTimeLabel('16:05')).toBe('4:05 PM');
    expect(requestTimeLabel('00:00')).toBe('12:00 AM');
    expect(requestWhen({ kind: 'wfh', startDate: '2026-11-28', endDate: '2026-11-30' })).toBe('28 Nov 2026 to 30 Nov 2026 (3 days)');
    expect(requestWhen({ kind: 'early_leave', startDate: '2026-12-01', startTime: '16:30' })).toMatch(/^1 Dec 2026, .* 4:30 PM$/);
    expect(requestTitle('other', 'Laptop upgrade')).toBe('Laptop upgrade');
    expect(requestTitle('wfh')).toBe('Work from home');
    expect(hoursBetween('10:00', '12:30')).toBe(2.5);
  });

  it('tells the requester where the request stands, for each workflow', () => {
    expect(requestStatusMessage('pending', { approved: 1, total: 3, waitingOn: 'Manish Arora' })).toBe('Waiting for 2 of 3 approvers (Manish Arora).');
    expect(requestStatusMessage('pending', { approved: 0, total: 2, workflow: 'any' })).toMatch(/any one of 2/);
    expect(requestStatusMessage('approved', { approved: 2, total: 2 })).toBe('Approved by every approver.');
    expect(requestStatusMessage('approved', { approved: 1, total: 2, workflow: 'any' }, 'Simran')).toBe('Approved by Simran.');
    expect(requestStatusMessage('rejected', { approved: 0, total: 2 }, 'Simran')).toMatch(/Rejected by Simran.*reason/);
    expect(requestStatusMessage('changes_requested', { approved: 0, total: 2 }, 'Simran')).toMatch(/asked for changes/);
  });

  it('keeps approvers and CC participants apart and checks dates and times', () => {
    expect(requestInput.safeParse({ ...base, kind: 'wfh', endDate: '2026-12-03', additionalApproverIds: [B], ccIds: [C] }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', endDate: '2026-11-30' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'late_coming' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'late_coming', startTime: '10:30' }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'early_leave', startTime: '16:00', endDate: '2026-12-02' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'comp_off' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'comp_off', workedOn: '2026-11-22' }).success).toBe(true);
    expect(requestInput.safeParse({ ...base, kind: 'other' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'leave' }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', primaryApproverId: undefined }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', additionalApproverIds: [A] }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', additionalApproverIds: [B], ccIds: [B] }).success).toBe(false);
    expect(requestInput.safeParse({ ...base, kind: 'wfh', reason: 'no' }).success).toBe(false);
  });

  it('takes full day, half day and hourly leave', () => {
    const leave = { leaveTypeId: T, startDate: '2026-12-01', endDate: '2026-12-01', reason: 'Family function out of town', primaryApproverId: A };
    expect(requestLeaveInput.safeParse(leave).success).toBe(true);
    expect(requestLeaveInput.safeParse({ ...leave, duration: 'half' }).success).toBe(false);
    expect(requestLeaveInput.safeParse({ ...leave, duration: 'half', startHalf: 'second_half' }).success).toBe(true);
    expect(requestLeaveInput.safeParse({ ...leave, duration: 'hours' }).success).toBe(false);
    expect(requestLeaveInput.safeParse({ ...leave, duration: 'hours', startTime: '10:00', endTime: '12:00' }).success).toBe(true);
    expect(requestLeaveInput.safeParse({ ...leave, duration: 'hours', startTime: '10:00', endTime: '12:00', endDate: '2026-12-02' }).success).toBe(false);
    expect(requestLeaveInput.safeParse({ ...leave, endDate: '2026-11-30' }).success).toBe(false);
  });

  it('starts with the spec\'s categories on, and none of them duplicated', () => {
    const cats = defaultRequestCategories();
    for (const k of ['wfh', 'leave', 'early_leave', 'late_coming', 'comp_off', 'attendance_regularization', 'other']) expect(cats.find((c) => c.kind === k)?.enabled).toBe(true);
    expect(new Set(cats.map((c) => c.key)).size).toBe(cats.length);
    expect(cats.some((c) => c.kind === 'leave')).toBe(true);
  });
});
