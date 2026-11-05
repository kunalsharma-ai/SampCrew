import { describe, expect, it } from 'vitest';
import { allowedMoves, canMove, caseRef, dueAt, targetState } from './helpdesk-math';
import { checkAge, punchEventId, resolveCaptureTime } from './mobile-sync';

const H = 3_600_000;

describe('helpdesk case moves', () => {
  it('lets handlers work a case and requesters only confirm or reopen a resolution', () => {
    expect(allowedMoves('open', 'handler')).toEqual(['in_progress', 'waiting_on_employee', 'resolved']);
    expect(canMove('resolved', 'closed', 'requester')).toBe(true);
    expect(canMove('resolved', 'open', 'requester')).toBe(true);
    expect(canMove('open', 'resolved', 'requester')).toBe(false);
    expect(canMove('closed', 'open', 'handler')).toBe(false);
    expect(canMove('open', 'closed', 'handler')).toBe(false);
  });
  it('formats case references', () => {
    expect(caseRef(7)).toBe('HR-0007');
    expect(caseRef(12345)).toBe('HR-12345');
  });
});

describe('response targets', () => {
  it('scales targets by priority and skips missing ones', () => {
    expect(dueAt(0, 24, 'normal')).toBe(24 * H);
    expect(dueAt(0, 24, 'urgent')).toBe(12 * H);
    expect(dueAt(0, 24, 'low')).toBe(48 * H);
    expect(dueAt(0, null, 'high')).toBeNull();
  });
  it('reports on time, due soon, overdue, met and missed', () => {
    const t = { startMs: 0, dueMs: 10 * H, doneMs: null };
    expect(targetState({ ...t, nowMs: 5 * H })).toBe('on_time');
    expect(targetState({ ...t, nowMs: 8.5 * H })).toBe('due_soon');
    expect(targetState({ ...t, nowMs: 11 * H })).toBe('overdue');
    expect(targetState({ ...t, doneMs: 9 * H, nowMs: 20 * H })).toBe('met');
    expect(targetState({ ...t, doneMs: 12 * H, nowMs: 20 * H })).toBe('missed');
    expect(targetState({ startMs: 0, dueMs: null, doneMs: null, nowMs: 1 })).toBe('none');
    // At least one hour of warning on short targets.
    expect(targetState({ startMs: 0, dueMs: 2 * H, doneMs: null, nowMs: 1.1 * H })).toBe('due_soon');
  });
});

describe('offline punches', () => {
  const now = Date.UTC(2026, 10, 1, 9, 0);
  it('refuses punches from the future or older than three days', () => {
    expect(checkAge(now - 71 * H, now)).toEqual({ ok: true });
    expect(checkAge(now - 73 * H, now)).toEqual({ ok: false, reason: 'too_old' });
    expect(checkAge(now + 60_000, now)).toEqual({ ok: true });
    expect(checkAge(now + 5 * 60_000, now)).toEqual({ ok: false, reason: 'in_future' });
  });
  it('times a punch from the server clock when the same app run captured and sent it', () => {
    const r = resolveCaptureTime({ capturedWallMs: now - H, capturedElapsedMs: 1000, capturedRunId: 'run-aaaaaaaa', sentElapsedMs: 1000 + H, sentRunId: 'run-aaaaaaaa', serverNowMs: now });
    expect(r).toEqual({ capturedAtMs: now - H, basis: 'monotonic', flag: null });
  });
  it('flags a phone clock that was changed, keeping the trustworthy time', () => {
    // The phone said 06:00 but only 1 hour has passed on the monotonic clock before 09:00.
    const r = resolveCaptureTime({ capturedWallMs: now - 3 * H, capturedElapsedMs: 0, capturedRunId: 'run-aaaaaaaa', sentElapsedMs: H, sentRunId: 'run-aaaaaaaa', serverNowMs: now });
    expect(r).toEqual({ capturedAtMs: now - H, basis: 'monotonic', flag: 'clock_changed' });
  });
  it('cannot verify the time when the app restarted in between', () => {
    const r = resolveCaptureTime({ capturedWallMs: now - 2 * H, capturedElapsedMs: 50_000, capturedRunId: 'run-aaaaaaaa', sentElapsedMs: 1_000, sentRunId: 'run-bbbbbbbb', serverNowMs: now });
    expect(r).toEqual({ capturedAtMs: now - 2 * H, basis: 'device_clock', flag: 'clock_unverified' });
    expect(resolveCaptureTime({ capturedWallMs: now, serverNowMs: now }).flag).toBe('clock_unverified');
  });
  it('builds idempotency keys from the device and its counter', () => {
    expect(punchEventId('d1', 42)).toBe('d1:42');
  });
});
