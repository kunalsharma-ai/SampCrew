import { Injectable } from '@nestjs/common';
import { attendanceEngine, zonedTime, type DayResult, type ShiftRule } from '@crew/contracts';
import { many, one, type Tx } from '../../platform/database/database.service';

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

/** Employee id a raw event belongs to: its own employee, else the enrolment-number mapping (device-specific first). */
export const EVENT_EMPLOYEE = `coalesce(ev.employee_id, (
  select m.employee_id from device_user_mappings m
   where m.device_user_id = ev.device_user_id and (m.device_id = ev.device_id or m.device_id is null)
   order by m.device_id nulls last limit 1))`;

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
  async employee(tx: Tx, id: string): Promise<EmployeeCtx | undefined> {
    const e = await one<Omit<EmployeeCtx, 'fence'> & { lat: string | null; lon: string | null; radius: number | null }>(
      tx,
      `select e.id, e.membership_id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, e.employee_code as code, e.status,
              e.date_of_joining, e.last_working_day, e.current_legal_entity_id as legal_entity_id, e.current_department_id as department_id,
              e.current_location_id as location_id, e.default_shift_id, coalesce(l.timezone, le.timezone, t.timezone) as tz,
              l.latitude as lat, l.longitude as lon, l.geofence_radius_m as radius
         from employees e join tenants t on t.id = e.tenant_id
         left join locations l on l.id = e.current_location_id left join legal_entities le on le.id = e.current_legal_entity_id
        where e.id = $1`,
      [id],
    );
    if (!e) return undefined;
    const { lat, lon, radius, ...rest } = e;
    return { ...rest, fence: lat !== null && lon !== null && radius ? { lat: Number(lat), lon: Number(lon), radiusM: radius } : null };
  }

  async policy(tx: Tx, locationId: string | null): Promise<PolicyRow> {
    const p = await one<PolicyRow>(
      tx,
      `select * from attendance_policies where location_id = $1 or location_id is null order by location_id nulls last limit 1`,
      [locationId],
    );
    return p ?? { id: '', ...DEFAULT_POLICY };
  }

  private async calendar(tx: Tx, e: EmployeeCtx) {
    const cal = await one<{ id: string; weekly_offs: number[] }>(
      tx,
      `select id, weekly_offs from holiday_calendars
        where (location_id = $2) or (location_id is null and legal_entity_id = $1) or is_default
        order by (location_id = $2) desc nulls last, (legal_entity_id = $1) desc nulls last, is_default desc limit 1`,
      [e.legal_entity_id, e.location_id],
    );
    return cal ? { id: cal.id, weeklyOffs: cal.weekly_offs.map(Number) } : { id: null, weeklyOffs: [0, 6] };
  }

  /** The planned shift and day type for each date in a range (published roster or manual assignment, else policy default). */
  async plan(tx: Tx, e: EmployeeCtx, from: string, to: string): Promise<Map<string, PlannedDay>> {
    const policy = await this.policy(tx, e.location_id);
    const cal = await this.calendar(tx, e);
    const shifts = new Map((await many<ShiftRow>(tx, 'select * from shift_templates')).map((s) => [s.id, s]));
    const assigned = new Map(
      (await many<{ work_date: string; shift_template_id: string | null }>(
        tx,
        `select a.work_date, a.shift_template_id from shift_assignments a left join rosters r on r.id = a.roster_id
          where a.employee_id = $1 and a.work_date between $2 and $3 and (a.roster_id is null or r.status = 'published')`,
        [e.id, from, to],
      )).map((a) => [a.work_date, a.shift_template_id]),
    );
    const holidays = cal.id
      ? new Map((await many<{ d: string; name: string }>(tx, 'select holiday_date as d, name from holidays where calendar_id = $1 and not is_optional and holiday_date between $2 and $3', [cal.id, from, to])).map((h) => [h.d, h.name]))
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

  private async leaveParts(tx: Tx, employeeId: string, from: string, to: string) {
    const rows = await many<{ start_date: string; end_date: string; start_half: string; end_half: string; id: string }>(
      tx,
      `select id, start_date, end_date, start_half, end_half from leave_requests where employee_id = $1 and status = 'approved' and end_date >= $2 and start_date <= $3`,
      [employeeId, from, to],
    );
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
  async punches(tx: Tx, employeeId: string, fromMs: number, toMs: number) {
    return many<{ id: string; captured_at: Date; direction: 'in' | 'out' | 'unknown'; source: string; geofence_result: string | null; device_name: string | null; correction_id: string | null; verify_method: string | null; note: string | null; risk_flags: string[] }>(
      tx,
      `select ev.id, ev.captured_at, ev.direction, ev.source, ev.geofence_result, d.name as device_name, ev.correction_id, ev.verify_method, ev.note, ev.risk_flags
         from attendance_events ev left join attendance_devices d on d.id = ev.device_id
        where ev.captured_at >= $2 and ev.captured_at < $3 and ${EVENT_EMPLOYEE} = $1
        order by ev.captured_at`,
      [employeeId, new Date(fromMs), new Date(toMs)],
    );
  }

  /** The instants whose punches belong to a work day. */
  async window(tx: Tx, e: EmployeeCtx, date: string, plan?: Map<string, PlannedDay>) {
    const p = plan ?? (await this.plan(tx, e, date, addDays(date, 1)));
    const policy = await this.policy(tx, e.location_id);
    const startOf = (d: string) => {
      const s = p.get(d)?.shift;
      return dayWindowStart(d, e.tz, s ? toRule(s) : null, policy.early_window_minutes);
    };
    return { from: startOf(date), to: startOf(addDays(date, 1)) };
  }

  /**
   * Taken before recomputing many people's days in one transaction (team view, HR jobs, recompute requests). Two such
   * transactions writing the same people's days in different orders would deadlock, so they take turns within a
   * workspace. Single-person recomputes (punches, leave approvals, corrections) take the same lock shared, before
   * writing any day: they run alongside each other, but never alongside a bulk recompute. The workflow load test
   * found that a bulk run and a leave approval could otherwise each hold a day the other needed.
   */
  async lockBulk(tx: Tx) {
    await tx.query(`select pg_advisory_xact_lock(hashtext('crew.attendance_days.bulk'), hashtext(app_tenant_id()::text))`);
  }

  private async lockShared(tx: Tx) {
    await tx.query(`select pg_advisory_xact_lock_shared(hashtext('crew.attendance_days.bulk'), hashtext(app_tenant_id()::text))`);
  }

  /** Recomputes and stores days for one employee. Locked days are left as they are. Returns the computed days. */
  async recompute(tx: Tx, employeeId: string, from: string, to: string, now = Date.now()): Promise<Map<string, DayResult>> {
    // Re-entrant: a bulk recompute already holds the lock exclusively, and taking it shared again is free.
    await this.lockShared(tx);
    const e = await this.employee(tx, employeeId);
    const results = new Map<string, DayResult>();
    if (!e) return results;
    const plan = await this.plan(tx, e, from, addDays(to, 1));
    const leave = await this.leaveParts(tx, e.id, from, to);
    const policy = await this.policy(tx, e.location_id);
    const approvedOt = new Map(
      (await many<{ work_date: string; minutes: number }>(tx, `select work_date, minutes from overtime_claims where employee_id = $1 and status = 'approved' and work_date between $2 and $3`, [e.id, from, to])).map((r) => [r.work_date, r.minutes]),
    );
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if ((await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, d]))!.locked) continue;
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
      await tx.query(
        `insert into attendance_days (tenant_id, employee_id, work_date, shift_template_id, day_type, leave_part, status, first_in, last_out, worked_minutes,
                                      break_minutes, late_minutes, early_leave_minutes, overtime_minutes, approved_overtime_minutes, flags, explanation, punch_count, engine_version, computed_at)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
         on conflict (tenant_id, employee_id, work_date) do update set
           shift_template_id = excluded.shift_template_id, day_type = excluded.day_type, leave_part = excluded.leave_part, status = excluded.status,
           first_in = excluded.first_in, last_out = excluded.last_out, worked_minutes = excluded.worked_minutes, break_minutes = excluded.break_minutes,
           late_minutes = excluded.late_minutes, early_leave_minutes = excluded.early_leave_minutes, overtime_minutes = excluded.overtime_minutes,
           approved_overtime_minutes = excluded.approved_overtime_minutes, flags = excluded.flags, explanation = excluded.explanation,
           punch_count = excluded.punch_count, engine_version = excluded.engine_version, computed_at = now()`,
        [
          e.id, d, day.shift?.id ?? null, day.dayType, leave.get(d) ?? null, r.status, r.firstIn ? new Date(r.firstIn) : null, r.lastOut ? new Date(r.lastOut) : null,
          r.workedMinutes, r.breakMinutes, r.lateMinutes, r.earlyLeaveMinutes, r.overtimeMinutes, approved, r.flags, JSON.stringify(r.explanation), r.punchesUsed, ENGINE_VERSION,
        ],
      );
      results.set(d, r);
    }
    return results;
  }

  /** The work dates a punch at this instant could belong to (its local date, and the day before for night shifts). */
  /**
   * The work day an instant belongs to. Just after midnight this is usually still yesterday, because a day's
   * window runs until the next day's window opens (by default 4 hours before its shift starts).
   */
  async workDateAt(tx: Tx, e: EmployeeCtx, atMs: number): Promise<string> {
    const local = zonedTime.toLocal(atMs, e.tz).date;
    const win = await this.window(tx, e, local);
    return atMs < win.from ? addDays(local, -1) : local;
  }

  datesFor(e: EmployeeCtx, atMs: number): [string, string] {
    const local = zonedTime.toLocal(atMs, e.tz).date;
    return [addDays(local, -1), local];
  }
}
