/**
 * The attendance engine: turns one employee's raw punches for one work day into a day record. It is a pure
 * function so the same inputs always give the same result, every rule can be tested on its own, and the
 * explanation shown to the employee is produced by the same code that made the decision.
 *
 * Raw punches are never changed. Corrections add punches (source "correction"); the day is recomputed.
 */
import { fmtHhmm, fromLocal, toLocal } from './zoned-time';

export const ENGINE_VERSION = 1;

export type Direction = 'in' | 'out' | 'unknown';
export type DayType = 'working' | 'weekly_off' | 'holiday';
export type LeavePart = 'full' | 'first_half' | 'second_half';

export const DAY_STATUSES = [
  'present', 'half_day', 'absent', 'missing_punch', 'on_leave', 'half_day_leave', 'holiday', 'weekly_off', 'in_progress', 'not_joined',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const DAY_FLAGS = ['late', 'early_leave', 'missing_in', 'missing_out', 'off_day_work', 'short_hours', 'overtime', 'outside_geofence', 'duplicate_punches'] as const;
export type DayFlag = (typeof DAY_FLAGS)[number];

export interface ShiftRule {
  /** Local start and end, minutes after midnight. An end at or before the start means the shift ends the next day. */
  startMinutes: number;
  endMinutes: number;
  /** Unpaid break. Any shortfall of punched breaks is deducted once the person worked more than a half day plus the break. */
  breakMinutes: number;
  graceLateMinutes: number;
  graceEarlyMinutes: number;
  /** Worked minutes needed for a half day and for a full day. */
  halfDayMinutes: number;
  fullDayMinutes: number;
  overtimeEnabled: boolean;
  /** Overtime below this is ignored. */
  overtimeMinMinutes: number;
}

export interface EnginePunch {
  at: number; // epoch ms
  direction: Direction;
  outsideGeofence?: boolean;
}

export interface DayInput {
  workDate: string;
  timeZone: string;
  shift: ShiftRule | null;
  dayType: DayType;
  leave: LeavePart | null;
  punches: EnginePunch[];
  /** Instant now; a day whose window has not closed yet is "in progress" rather than absent or missing a punch. */
  now: number;
  /** Before the joining date or after the last working day there is nothing to compute. */
  employed: boolean;
  /** Punches closer together than this are treated as one (a double tap on a device). */
  duplicateWindowSeconds?: number;
}

export interface DayResult {
  status: DayStatus;
  firstIn: number | null;
  lastOut: number | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  flags: DayFlag[];
  punchesUsed: number;
  /** Plain-language reasons, in order, so anyone can see why the day came out as it did. */
  explanation: string[];
}

/** The minutes a shift is scheduled to last, end exclusive, crossing midnight when needed. */
export function shiftLength(s: Pick<ShiftRule, 'startMinutes' | 'endMinutes'>): number {
  return s.endMinutes > s.startMinutes ? s.endMinutes - s.startMinutes : s.endMinutes + 1440 - s.startMinutes;
}

/**
 * The span of instants whose punches belong to a work day: from `earlyWindowMinutes` before the shift starts
 * (or local midnight with no shift) until the next day's window opens, so no punch counts twice.
 */
export function dayWindowStart(workDate: string, tz: string, shift: Pick<ShiftRule, 'startMinutes'> | null, earlyWindowMinutes: number): number {
  return shift ? fromLocal(workDate, shift.startMinutes - earlyWindowMinutes, tz) : fromLocal(workDate, 0, tz);
}

const mins = (ms: number) => Math.floor(ms / 60_000);

export function computeDay(input: DayInput): DayResult {
  const explanation: string[] = [];
  const flags = new Set<DayFlag>();
  const tz = input.timeZone;
  const clock = (ms: number) => fmtHhmm(toLocal(ms, tz).minutes);
  const empty = (status: DayStatus, why: string): DayResult => ({
    status, firstIn: null, lastOut: null, workedMinutes: 0, breakMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, flags: [], punchesUsed: 0, explanation: [why],
  });
  if (!input.employed) return empty('not_joined', 'Not employed on this date.');

  // 1. Order punches and drop double taps.
  const dupMs = (input.duplicateWindowSeconds ?? 120) * 1000;
  const sorted = [...input.punches].sort((a, b) => a.at - b.at);
  const punches: EnginePunch[] = [];
  for (const p of sorted) {
    const prev = punches[punches.length - 1];
    if (prev && p.at - prev.at < dupMs && (p.direction === prev.direction || p.direction === 'unknown' || prev.direction === 'unknown')) {
      flags.add('duplicate_punches');
      continue;
    }
    punches.push(p);
  }
  if (flags.has('duplicate_punches')) explanation.push(`Ignored ${sorted.length - punches.length} repeated punch(es) within ${dupMs / 60_000} minutes of the one before.`);
  if (punches.some((p) => p.outsideGeofence)) {
    flags.add('outside_geofence');
    explanation.push('At least one punch was recorded outside the location geofence.');
  }

  // 2. Pair punches into worked intervals. Known directions are respected; unknown ones alternate in, out.
  const intervals: [number, number][] = [];
  let open: number | null = null;
  let orphanOut = 0;
  for (const p of punches) {
    const dir = p.direction === 'unknown' ? (open === null ? 'in' : 'out') : p.direction;
    if (dir === 'in') {
      if (open !== null) {
        // Two "in" punches in a row: the first one never got its "out".
        flags.add('missing_out');
        explanation.push(`Punch in at ${clock(open)} has no matching punch out before the next punch in.`);
      }
      open = p.at;
    } else if (open === null) {
      orphanOut++;
      flags.add('missing_in');
      explanation.push(`Punch out at ${clock(p.at)} has no matching punch in.`);
    } else {
      intervals.push([open, p.at]);
      open = null;
    }
  }
  const s = input.shift;
  const closesAt = s ? fromLocal(input.workDate, s.startMinutes, tz) + (shiftLength(s) + 6 * 60) * 60_000 : fromLocal(input.workDate, 24 * 60, tz);
  const stillGoing = input.now < closesAt;
  if (open !== null) {
    if (stillGoing) {
      // Count time so far for a person who is still at work today.
      intervals.push([open, Math.max(open, input.now)]);
      explanation.push(`Punched in at ${clock(open)} and has not punched out yet.`);
    } else {
      flags.add('missing_out');
      explanation.push(`Punch in at ${clock(open)} has no punch out.`);
    }
  }

  const firstIn = intervals[0]?.[0] ?? null;
  const lastOut = !(open !== null && stillGoing) ? (intervals[intervals.length - 1]?.[1] ?? null) : null;
  let worked = intervals.reduce((t, [a, b]) => t + mins(b - a), 0);
  let breaks = 0;
  for (let i = 1; i < intervals.length; i++) breaks += mins(intervals[i]![0] - intervals[i - 1]![1]);

  // 3. Days that are not working days.
  const isOff = input.dayType !== 'working';
  if (isOff && !intervals.length && !orphanOut) {
    return empty(input.dayType === 'holiday' ? 'holiday' : 'weekly_off', input.dayType === 'holiday' ? 'Holiday.' : 'Weekly off.');
  }
  if (input.leave === 'full' && !intervals.length && !orphanOut) return empty('on_leave', 'On approved leave for the full day.');

  // 4. Scheduled unpaid break.
  const halfMin = s?.halfDayMinutes ?? 240;
  const fullMin = s?.fullDayMinutes ?? 480;
  // Only once the person has worked more than a half day plus the break, so a half day is not cut short by it.
  if (s && s.breakMinutes > 0 && breaks < s.breakMinutes && worked >= halfMin + s.breakMinutes) {
    const deduct = Math.min(s.breakMinutes - breaks, worked);
    worked -= deduct;
    breaks += deduct;
    explanation.push(`Deducted ${deduct} minutes of unpaid break${breaks > deduct ? ' not covered by punched breaks' : ''}.`);
  }

  // 5. Late arrival and early leaving, against the shift.
  let late = 0;
  let early = 0;
  if (s && !isOff && firstIn !== null) {
    const start = fromLocal(input.workDate, s.startMinutes, tz);
    const end = start + shiftLength(s) * 60_000;
    const lateBy = mins(firstIn - start);
    // Half-day leave in the first half excuses a late start; in the second half it excuses leaving early.
    if (lateBy > s.graceLateMinutes && input.leave !== 'first_half') {
      late = lateBy;
      flags.add('late');
      explanation.push(`Arrived at ${clock(firstIn)}, ${lateBy} minutes after the shift start of ${fmtHhmm(s.startMinutes)} (grace ${s.graceLateMinutes} min).`);
    }
    if (lastOut !== null) {
      const earlyBy = mins(end - lastOut);
      if (earlyBy > s.graceEarlyMinutes && input.leave !== 'second_half') {
        early = earlyBy;
        flags.add('early_leave');
        explanation.push(`Left at ${clock(lastOut)}, ${earlyBy} minutes before the shift end of ${fmtHhmm(s.endMinutes)} (grace ${s.graceEarlyMinutes} min).`);
      }
    }
  }

  // 6. Overtime: everything on a day off, or time beyond the scheduled shift (minus its break) on a working day.
  let overtime = 0;
  if (s?.overtimeEnabled && !(open !== null && stillGoing)) {
    const scheduled = isOff ? 0 : shiftLength(s) - s.breakMinutes;
    const extra = worked - scheduled;
    if (extra >= Math.max(1, s.overtimeMinMinutes)) {
      overtime = extra;
      flags.add('overtime');
      explanation.push(isOff ? `Worked ${extra} minutes on a ${input.dayType === 'holiday' ? 'holiday' : 'weekly off'}; all of it counts as overtime.` : `Worked ${extra} minutes beyond the scheduled ${scheduled} minutes.`);
    } else if (extra > 0 && !isOff) {
      explanation.push(`${extra} minutes beyond the shift is below the overtime minimum of ${s.overtimeMinMinutes} minutes.`);
    }
  }

  // 7. Status.
  let status: DayStatus;
  const incomplete = flags.has('missing_in') || flags.has('missing_out');
  if (isOff) {
    flags.add('off_day_work');
    status = input.dayType === 'holiday' ? 'holiday' : 'weekly_off';
    explanation.push(`Worked ${worked} minutes on a ${input.dayType === 'holiday' ? 'holiday' : 'weekly off'}.`);
  } else if (open !== null && stillGoing) {
    status = 'in_progress';
  } else if (!intervals.length && !orphanOut && !incomplete) {
    if (stillGoing) {
      status = 'in_progress';
      explanation.push('No punches yet today.');
    } else {
      status = 'absent';
      explanation.push(input.leave ? 'No punches on the half of the day not covered by leave.' : 'No punches on a working day.');
    }
  } else if (incomplete) {
    status = 'missing_punch';
    explanation.push('A punch is missing, so the day needs a correction before it counts.');
  } else if (input.leave === 'first_half' || input.leave === 'second_half') {
    if (worked >= halfMin) {
      status = 'half_day_leave';
      explanation.push(`Half-day leave plus ${worked} minutes worked (half day needs ${halfMin}).`);
    } else {
      status = 'absent';
      flags.add('short_hours');
      explanation.push(`Half-day leave, but only ${worked} minutes worked out of the ${halfMin} needed for the other half.`);
    }
  } else if (worked >= fullMin) {
    status = 'present';
    explanation.push(`Worked ${worked} minutes (full day needs ${fullMin}).`);
  } else if (worked >= halfMin) {
    status = 'half_day';
    flags.add('short_hours');
    explanation.push(`Worked ${worked} minutes: at least the ${halfMin} for a half day, short of the ${fullMin} for a full day.`);
  } else {
    status = 'absent';
    flags.add('short_hours');
    explanation.push(`Worked only ${worked} minutes, less than the ${halfMin} needed for a half day.`);
  }

  return {
    status,
    firstIn,
    lastOut,
    workedMinutes: worked,
    breakMinutes: breaks,
    lateMinutes: late,
    earlyLeaveMinutes: early,
    overtimeMinutes: overtime,
    flags: DAY_FLAGS.filter((f) => flags.has(f)),
    punchesUsed: punches.length,
    explanation,
  };
}

/** Distance in metres between two coordinates (haversine), for geofence checks. */
export function distanceMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/**
 * Geofence decision for a punch. The reported accuracy counts in the person's favour up to the radius itself,
 * so a weak GPS fix near the boundary is not treated as outside, but a fix with no useful accuracy is "unknown".
 */
export function geofenceCheck(fence: { lat: number; lon: number; radiusM: number }, fix: { lat: number; lon: number; accuracyM?: number | null }) {
  const distance = Math.round(distanceMetres(fence.lat, fence.lon, fix.lat, fix.lon));
  const accuracy = fix.accuracyM ?? 0;
  if (accuracy > 1000) return { result: 'unknown' as const, distance };
  return { result: distance - Math.min(accuracy, fence.radiusM) <= fence.radiusM ? ('inside' as const) : ('outside' as const), distance };
}
