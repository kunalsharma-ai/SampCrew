import { Injectable } from '@nestjs/common';
import { attendanceEngine, zonedTime, type DayResult, type ShiftRule } from '@crew/contracts';
import type { TenantTx } from '../../platform/database/mongo.service';
import { displayName } from '../employees/employee-view';

const { computeDay, dayWindowStart, ENGINE_VERSION } = attendanceEngine;
const { addDays, hhmm } = zonedTime;

export interface ShiftRow {
  id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  grace_late_minutes: number;
  grace_early_minutes: number;
  half_day_minutes: number;
  full_day_minutes: number;
  overtime_enabled: boolean;
  overtime_min_minutes: number;
  color: string;
  archived_at?: Date | null;
}

export interface PolicyRow {
  id: string;
  location_id: string | null;
  web_punch: boolean;
  mobile_punch: boolean;
  qr_punch: boolean;
  geofence_mode: 'off' | 'warn' | 'enforce';
  default_shift_id: string | null;
  overtime_requires_approval: boolean;
  early_window_minutes: number;
  correction_window_days: number;
}

export interface EmployeeCtx {
  id: string;
  membership_id: string | null;
  name: string;
  code: string;
  status: string;
  date_of_joining: string;
  last_working_day: string | null;
  legal_entity_id: string | null;
  department_id: string | null;
  location_id: string | null;
  /** The person's own usual shift, set when they were registered for attendance; used before the policy's shift. */
  default_shift_id: string | null;
  tz: string;
  fence: { lat: number; lon: number; radiusM: number } | null;
}

export const DEFAULT_POLICY: Omit<PolicyRow, 'id'> = {
  location_id: null, web_punch: true, mobile_punch: true, qr_punch: true, geofence_mode: 'warn', default_shift_id: null,
  overtime_requires_approval: true, early_window_minutes: 240, correction_window_days: 30,
};

export const toRule = (s: ShiftRow): ShiftRule => ({
  startMinutes: hhmm(s.start_time),
  endMinutes: hhmm(s.end_time),
  breakMinutes: s.break_minutes,
  graceLateMinutes: s.grace_late_minutes,
  graceEarlyMinutes: s.grace_early_minutes,
  halfDayMinutes: s.half_day_minutes,
  fullDayMinutes: s.full_day_minutes,
  overtimeEnabled: s.overtime_enabled,
  overtimeMinMinutes: s.overtime_min_minutes,
});

/**
 * True when an employee's day falls inside a live payroll lock for their legal entity or the whole workspace (the
 * attendance_is_locked function in PostgreSQL).
 */
export async function isLocked(tx: TenantTx, employeeId: string, date: string): Promise<boolean> {
  return (await lockedDates(tx, employeeId, date, date)).has(date);
}

/** The dates between from and to (inclusive) that are inside a live lock for the employee. */
export async function lockedDates(tx: TenantTx, employeeId: string, from: string, to: string): Promise<Set<string>> {
  const e = await tx.collection('employees').findOne({ id: employeeId }, { projection: { current_legal_entity_id: 1 } });
  const out = new Set<string>();
  if (!e) return out;
  const periods = await tx.collection('attendance_periods').find({
    unlocked_at: null,
    period_start: { $lte: to },
    period_end: { $gte: from },
    legal_entity_id: { $in: [null, e.current_legal_entity_id ?? null] },
  });
  for (const p of periods) {
    for (let d = p.period_start > from ? p.period_start : from; d <= to && d <= p.period_end; d = addDays(d, 1)) out.add(d);
  }
  return out;
}

/**
 * Which employee each raw event belongs to: its own employee, else the enrolment-number mapping, a mapping for the
 * event's own machine before one for every machine. Events nobody is mapped to are left out.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function eventEmployees(tx: TenantTx, events: Record<string, any>[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unmapped = events.filter((ev) => !ev.employee_id && ev.device_user_id);
  const mappings = unmapped.length ? await tx.collection('device_user_mappings').find({ device_user_id: { $in: [...new Set(unmapped.map((ev) => ev.device_user_id))] } }) : [];
  for (const ev of events) {
    if (ev.employee_id) {
      out.set(ev.id, ev.employee_id);
      continue;
    }
    const own = mappings.find((m) => m.device_user_id === ev.device_user_id && m.device_id && m.device_id === ev.device_id);
    const any = mappings.find((m) => m.device_user_id === ev.device_user_id && !m.device_id);
    const m = own ?? any;
    if (m) out.set(ev.id, m.employee_id);
  }
  return out;
}

export interface PlannedDay {
  shift: ShiftRow | null;
  dayType: 'working' | 'weekly_off' | 'holiday';
  source: 'roster' | 'policy' | 'none';
  holidayName: string | null;
}

/**
 * Loads what the attendance engine needs (shift, calendar, leave and punches) and writes attendance_days.
 * Days are derived data: they are recomputed whenever an input changes and never edited by hand.
 */
@Injectable()
export class AttendanceDaysService {
  async employee(tx: TenantTx, id: string): Promise<EmployeeCtx | undefined> {
    const e = await tx.collection('employees').findOne({ id });
    if (!e) return undefined;
    const location = e.current_location_id ? await tx.collection('locations').findOne({ id: e.current_location_id }) : undefined;
    const entity = e.current_legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }) : undefined;
    const tenant = await tx.collection('tenants').findOne({});
    const lat = location?.latitude ?? null;
    const lon = location?.longitude ?? null;
    const radius = location?.geofence_radius_m ?? null;
    return {
      id: e.id,
      membership_id: e.membership_id ?? null,
      name: displayName(e as never),
      code: e.employee_code,
      status: e.status,
      date_of_joining: e.date_of_joining,
      last_working_day: e.last_working_day ?? null,
      legal_entity_id: e.current_legal_entity_id ?? null,
      department_id: e.current_department_id ?? null,
      location_id: e.current_location_id ?? null,
      default_shift_id: e.default_shift_id ?? null,
      tz: location?.timezone ?? entity?.timezone ?? tenant?.timezone,
      fence: lat !== null && lon !== null && radius ? { lat: Number(lat), lon: Number(lon), radiusM: radius } : null,
    };
  }

  async policy(tx: TenantTx, locationId: string | null): Promise<PolicyRow> {
    // The location's own policy, else the workspace default.
    const rows = await tx.collection<PolicyRow>('attendance_policies').find({ location_id: { $in: [locationId, null] } });
    const p = rows.find((x) => x.location_id !== null && x.location_id === locationId) ?? rows.find((x) => x.location_id === null);
    return p ?? { id: '', ...DEFAULT_POLICY };
  }

  private async calendar(tx: TenantTx, e: EmployeeCtx) {
    // The location's calendar, else the legal entity's, else the workspace default.
    const calendars = await tx.collection('holiday_calendars').find({
      $or: [...(e.location_id ? [{ location_id: e.location_id }] : []), ...(e.legal_entity_id ? [{ location_id: null, legal_entity_id: e.legal_entity_id }] : []), { is_default: true }],
    });
    const cal =
      calendars.find((c) => e.location_id && c.location_id === e.location_id) ??
      calendars.find((c) => !c.location_id && e.legal_entity_id && c.legal_entity_id === e.legal_entity_id) ??
      calendars.find((c) => c.is_default);
    return cal ? { id: cal.id as string, weeklyOffs: (cal.weekly_offs as number[]).map(Number) } : { id: null, weeklyOffs: [0, 6] };
  }

  /** The planned shift and day type for each date in a range (published roster or manual assignment, else policy default). */
  async plan(tx: TenantTx, e: EmployeeCtx, from: string, to: string): Promise<Map<string, PlannedDay>> {
    const policy = await this.policy(tx, e.location_id);
    const cal = await this.calendar(tx, e);
    const shifts = new Map((await tx.collection<ShiftRow>('shift_templates').find({})).map((s) => [s.id, s]));
    // Manual assignments, and assignments from published rosters.
    const rows = await tx.collection('shift_assignments').find({ employee_id: e.id, work_date: { $gte: from, $lte: to } });
    const rosterIds = [...new Set(rows.map((a) => a.roster_id).filter(Boolean))];
    const published = new Set(rosterIds.length ? (await tx.collection('rosters').find({ id: { $in: rosterIds }, status: 'published' }, { projection: { _id: 1 } })).map((x) => x.id) : []);
    const assigned = new Map(rows.filter((a) => !a.roster_id || published.has(a.roster_id)).map((a) => [a.work_date as string, (a.shift_template_id as string | null) ?? null]));
    const holidays = cal.id
      ? new Map(
          (await tx.collection('holidays').find({ calendar_id: cal.id, is_optional: false, holiday_date: { $gte: from, $lte: to } })).map((h) => [h.holiday_date as string, h.name as string]),
        )
      : new Map<string, string>();
    const ownShift = e.default_shift_id ? shifts.get(e.default_shift_id) : undefined;
    const fallback = ownShift && !ownShift.archived_at ? ownShift : policy.default_shift_id ? shifts.get(policy.default_shift_id) ?? null : null;
    const out = new Map<string, PlannedDay>();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const holidayName = holidays.get(d) ?? null;
      if (assigned.has(d)) {
        const id = assigned.get(d);
        const shift = id ? shifts.get(id) ?? null : null;
        out.set(d, { shift, dayType: holidayName ? 'holiday' : shift ? 'working' : 'weekly_off', source: 'roster', holidayName });
      } else {
        const weekday = new Date(`${d}T00:00:00Z`).getUTCDay();
        out.set(d, { shift: fallback, dayType: holidayName ? 'holiday' : cal.weeklyOffs.includes(weekday) ? 'weekly_off' : 'working', source: fallback ? 'policy' : 'none', holidayName });
      }
    }
    return out;
  }

  private async leaveParts(tx: TenantTx, employeeId: string, from: string, to: string) {
    const rows = await tx.collection<{ start_date: string; end_date: string; start_half: string; end_half: string; id: string }>('leave_requests').find({
      employee_id: employeeId,
      status: 'approved',
      end_date: { $gte: from },
      start_date: { $lte: to },
    });
    const out = new Map<string, 'full' | 'first_half' | 'second_half'>();
    for (const r of rows) {
      for (let d = r.start_date; d <= r.end_date; d = addDays(d, 1)) {
        if (d < from || d > to) continue;
        out.set(d, d === r.start_date && r.start_half === 'second_half' ? 'second_half' : d === r.end_date && r.end_half === 'first_half' ? 'first_half' : 'full');
      }
    }
    return out;
  }

  /** Raw punches for one employee between two instants, from every source. */
  async punches(tx: TenantTx, employeeId: string, fromMs: number, toMs: number) {
    // The person's own punches, and machine punches under an enrolment number they hold.
    const numbers = await tx.collection('device_user_mappings').distinct<string>('device_user_id', { employee_id: employeeId });
    const events = await tx.collection('attendance_events').find(
      {
        captured_at: { $gte: new Date(fromMs), $lt: new Date(toMs) },
        $or: [{ employee_id: employeeId }, ...(numbers.length ? [{ employee_id: null, device_user_id: { $in: numbers } }] : [])],
      },
      { sort: { captured_at: 1 } },
    );
    const owner = await eventEmployees(tx, events);
    const mine = events.filter((ev) => owner.get(ev.id) === employeeId);
    const devices = new Map(
      (await tx.collection('attendance_devices').find({ id: { $in: [...new Set(mine.map((ev) => ev.device_id).filter(Boolean))] } }, { projection: { name: 1 } })).map((d) => [d.id as string, d.name as string]),
    );
    return mine.map((ev) => ({
      id: ev.id as string,
      captured_at: ev.captured_at as Date,
      direction: ev.direction as 'in' | 'out' | 'unknown',
      source: ev.source as string,
      geofence_result: (ev.geofence_result as string | null) ?? null,
      device_name: devices.get(ev.device_id) ?? null,
      correction_id: (ev.correction_id as string | null) ?? null,
      verify_method: (ev.verify_method as string | null) ?? null,
      note: (ev.note as string | null) ?? null,
      risk_flags: (ev.risk_flags as string[]) ?? [],
    }));
  }

  /** The instants whose punches belong to a work day. */
  async window(tx: TenantTx, e: EmployeeCtx, date: string, plan?: Map<string, PlannedDay>) {
    const p = plan ?? (await this.plan(tx, e, date, addDays(date, 1)));
    const policy = await this.policy(tx, e.location_id);
    const startOf = (d: string) => {
      const s = p.get(d)?.shift;
      return dayWindowStart(d, e.tz, s ? toRule(s) : null, policy.early_window_minutes);
    };
    return { from: startOf(date), to: startOf(addDays(date, 1)) };
  }

  /**
   * Before recomputing many people's days in one transaction. PostgreSQL needed an advisory lock here so two bulk
   * recomputes could not deadlock; MongoDB has no lock waits: when two transactions write the same day one gets a
   * write conflict and is retried from the start. Kept so callers state the intent.
   */
  async lockBulk(_tx: TenantTx) {}

  /** Recomputes and stores days for one employee. Locked days are left as they are. Returns the computed days. */
  async recompute(tx: TenantTx, employeeId: string, from: string, to: string, now = Date.now()): Promise<Map<string, DayResult>> {
    const e = await this.employee(tx, employeeId);
    const results = new Map<string, DayResult>();
    if (!e) return results;
    const plan = await this.plan(tx, e, from, addDays(to, 1));
    const leave = await this.leaveParts(tx, e.id, from, to);
    const policy = await this.policy(tx, e.location_id);
    const approvedOt = new Map(
      (await tx.collection('overtime_claims').find({ employee_id: e.id, status: 'approved', work_date: { $gte: from, $lte: to } })).map((r) => [r.work_date as string, r.minutes as number]),
    );
    const locked = await lockedDates(tx, e.id, from, to);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (locked.has(d)) continue;
      const day = plan.get(d)!;
      const win = await this.window(tx, e, d, plan);
      const punches = await this.punches(tx, e.id, win.from, win.to);
      const employed = d >= e.date_of_joining && (!e.last_working_day || d <= e.last_working_day);
      const r = computeDay({
        workDate: d, timeZone: e.tz, shift: day.shift ? toRule(day.shift) : null, dayType: day.dayType, leave: leave.get(d) ?? null,
        punches: punches.map((p) => ({ at: p.captured_at.getTime(), direction: p.direction, outsideGeofence: p.geofence_result === 'outside' })),
        now, employed,
      });
      if (day.holidayName && r.explanation[0] === 'Holiday.') r.explanation[0] = `Holiday: ${day.holidayName}.`;
      // Without approval rules, computed overtime counts as approved; otherwise only approved claims do.
      const approved = policy.overtime_requires_approval ? Math.min(approvedOt.get(d) ?? 0, r.overtimeMinutes) : r.overtimeMinutes;
      const values = {
        shift_template_id: day.shift?.id ?? null,
        day_type: day.dayType,
        leave_part: leave.get(d) ?? null,
        status: r.status,
        first_in: r.firstIn ? new Date(r.firstIn) : null,
        last_out: r.lastOut ? new Date(r.lastOut) : null,
        worked_minutes: r.workedMinutes,
        break_minutes: r.breakMinutes,
        late_minutes: r.lateMinutes,
        early_leave_minutes: r.earlyLeaveMinutes,
        overtime_minutes: r.overtimeMinutes,
        approved_overtime_minutes: approved,
        flags: r.flags,
        explanation: r.explanation,
        punch_count: r.punchesUsed,
        engine_version: ENGINE_VERSION,
        computed_at: new Date(),
      };
      await tx.collection('attendance_days').upsert({ employee_id: e.id, work_date: d }, { employee_id: e.id, work_date: d, ...values }, { $set: values });
      results.set(d, r);
    }
    return results;
  }

  /** The work dates a punch at this instant could belong to (its local date, and the day before for night shifts). */
  /**
   * The work day an instant belongs to. Just after midnight this is usually still yesterday, because a day's
   * window runs until the next day's window opens (by default 4 hours before its shift starts).
   */
  async workDateAt(tx: TenantTx, e: EmployeeCtx, atMs: number): Promise<string> {
    const local = zonedTime.toLocal(atMs, e.tz).date;
    const win = await this.window(tx, e, local);
    return atMs < win.from ? addDays(local, -1) : local;
  }

  datesFor(e: EmployeeCtx, atMs: number): [string, string] {
    const local = zonedTime.toLocal(atMs, e.tz).date;
    return [addDays(local, -1), local];
  }
}
