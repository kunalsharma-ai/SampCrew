/**
 * Offline punch rules shared by the mobile app (which queues punches) and the API (which accepts them).
 *
 * A phone records each punch with its wall-clock time and a reading of the app's monotonic clock, which the
 * user cannot change. When the queue is sent, the app adds its monotonic clock again, so the server can work
 * out the real time of the punch from its own clock. A punch whose phone time disagrees is flagged for
 * review with both times kept; nothing is changed silently.
 */

/** Offline punches older than this are refused; the person asks for a correction instead. */
export const OFFLINE_MAX_AGE_HOURS = 72;
/** A punch may be stamped this far in the future (phone clocks drift). */
export const FUTURE_SKEW_MS = 2 * 60_000;
/** Difference between the two clocks that counts as a changed phone clock. */
export const CLOCK_TOLERANCE_MS = 2 * 60_000;
/** Most punches accepted in one sync request. */
export const SYNC_BATCH_MAX = 50;

export type RiskFlag = 'offline' | 'clock_changed' | 'clock_unverified' | 'mock_location';
export const RISK_FLAGS: readonly RiskFlag[] = ['offline', 'clock_changed', 'clock_unverified', 'mock_location'];

export type AgeCheck = { ok: true } | { ok: false; reason: 'in_future' | 'too_old' };

export function checkAge(occurredAtMs: number, nowMs: number, maxAgeHours = OFFLINE_MAX_AGE_HOURS): AgeCheck {
  if (occurredAtMs > nowMs + FUTURE_SKEW_MS) return { ok: false, reason: 'in_future' };
  if (nowMs - occurredAtMs > maxAgeHours * 3_600_000) return { ok: false, reason: 'too_old' };
  return { ok: true };
}

export interface ClockReadings {
  /** The phone's wall-clock time when the punch was captured. */
  capturedWallMs: number;
  /** The app's monotonic clock when the punch was captured. It only counts while the app keeps running. */
  capturedElapsedMs?: number;
  /** Random id of the app run that captured the punch; the monotonic clock restarts with every run. */
  capturedRunId?: string;
  /** The app's monotonic clock and run id when the batch was sent. */
  sentElapsedMs?: number;
  sentRunId?: string;
  /** The server's time when the batch arrived. */
  serverNowMs: number;
}

export interface CaptureTime {
  /** Time recorded for the punch. */
  capturedAtMs: number;
  /** How it was worked out: from the server clock and the phone's monotonic clock, or the phone's wall clock alone. */
  basis: 'monotonic' | 'device_clock';
  flag: RiskFlag | null;
}

/**
 * Works out when an offline punch happened. When the same app run captured and sent the punch, the time is the
 * server's clock minus the time elapsed on the app's monotonic clock, which a changed phone clock cannot
 * affect; if that differs from the phone's own timestamp the punch is flagged 'clock_changed' (both times are
 * kept). When the app restarted in between, the monotonic clock cannot be compared, so the phone's timestamp
 * is used and the punch is flagged 'clock_unverified'.
 */
export function resolveCaptureTime(r: ClockReadings): CaptureTime {
  if (r.capturedElapsedMs === undefined || r.sentElapsedMs === undefined || !r.capturedRunId || !r.sentRunId) {
    return { capturedAtMs: r.capturedWallMs, basis: 'device_clock', flag: 'clock_unverified' };
  }
  const elapsed = r.sentElapsedMs - r.capturedElapsedMs;
  if (r.capturedRunId !== r.sentRunId || elapsed < 0) return { capturedAtMs: r.capturedWallMs, basis: 'device_clock', flag: 'clock_unverified' };
  const derived = r.serverNowMs - elapsed;
  return { capturedAtMs: derived, basis: 'monotonic', flag: Math.abs(derived - r.capturedWallMs) > CLOCK_TOLERANCE_MS ? 'clock_changed' : null };
}

/** Idempotency key for a queued punch: the same punch sent twice is recorded once. */
export function punchEventId(deviceId: string, sequence: number): string {
  return `${deviceId}:${sequence}`;
}
