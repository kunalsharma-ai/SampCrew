import { leaveMath, type payrollEngine, type WorkCalendar } from '@crew/contracts';
import { many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';

export type StatutorySettings = payrollEngine.StatutorySettings;

/** The calendar month 'YYYY-MM' as a pay period. */
export function monthPeriod(month: string) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, '0')}`, days, month: m, year: y };
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const periodLabel = (start: string) => `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;

export interface StatutoryRow {
  id: string;
  legal_entity_id: string;
  effective_from: string;
  lop_source: 'attendance_and_leave' | 'leave_only';
  settings: StatutorySettings;
}

/** The statutory settings a legal entity saved that are in effect on a date, if any. */
export async function statutoryOn(tx: Tx, legalEntityId: string, date: string): Promise<StatutoryRow | undefined> {
  return one<StatutoryRow>(
    tx,
    `select id, legal_entity_id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, lop_source, settings
       from statutory_settings where legal_entity_id = $1 and effective_from <= $2 order by effective_from desc limit 1`,
    [legalEntityId, date],
  );
}

export async function legalEntity(tx: Tx, id: string) {
  const le = await one<{ id: string; name: string; legal_name: string; currency: string; country_code: string }>(
    tx, 'select id, name, legal_name, currency, country_code from legal_entities where id = $1', [id],
  );
  if (!le) throw Errors.notFound('Legal entity');
  return le;
}

/** The holiday calendar for an employee: their location's, else their legal entity's, else the workspace default. */
export async function calendarFor(tx: Tx, legalEntityId: string | null, locationId: string | null): Promise<WorkCalendar> {
  const cal = await one<{ id: string; weekly_offs: number[] }>(
    tx,
    `select id, weekly_offs from holiday_calendars
      where (location_id = $2) or (location_id is null and legal_entity_id = $1) or is_default
      order by (location_id = $2) desc nulls last, (legal_entity_id = $1) desc nulls last, is_default desc limit 1`,
    [legalEntityId, locationId],
  );
  if (!cal) return { weeklyOffs: [0, 6], holidays: new Set() };
  const hs = await many<{ d: string }>(tx, `select to_char(holiday_date, 'YYYY-MM-DD') as d from holidays where calendar_id = $1 and not is_optional`, [cal.id]);
  return { weeklyOffs: cal.weekly_offs.map(Number), holidays: new Set(hs.map((h) => h.d)) };
}

/** Days of [start, end] the person was employed (joining date to last working day). */
export function employedDays(start: string, end: string, joined: string, lastDay: string | null) {
  const from = joined > start ? joined : start;
  const to = lastDay && lastDay < end ? lastDay : end;
  return to < from ? 0 : leaveMath.daysBetweenInclusive(from, to);
}

/** Hundredths of a day as "1.5". */
export const dayCount = (h: number) => (h / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

export interface LopResult {
  /** Hundredths of a day. */
  total: number;
  absent: number;
  halfDays: number;
  unpaidLeave: number;
  missingPunch: number;
  source: 'attendance_and_leave' | 'leave_only' | 'leave_only_no_attendance';
  notes: string[];
}

/**
 * Loss-of-pay days for one employee in a period.
 * - Unpaid leave: approved requests of an unpaid leave type, counted on working days inside the period
 *   (half days at the request's start or end count 0.5).
 * - From attendance (unless the entity takes loss of pay from leave only): an absent working day counts 1
 *   (0.5 when the other half was on leave), a half day counts 0.5. Missing punches count 0 and are flagged for
 *   review, because the person may have worked.
 * - When attendance has no punches at all for the person this period, attendance is treated as not in use for
 *   them and only unpaid leave counts, with a warning.
 */
export async function lossOfPay(
  tx: Tx,
  e: { id: string; legal_entity_id: string | null; location_id: string | null },
  from: string,
  to: string,
  source: 'attendance_and_leave' | 'leave_only',
): Promise<LopResult> {
  const r: LopResult = { total: 0, absent: 0, halfDays: 0, unpaidLeave: 0, missingPunch: 0, source, notes: [] };
  if (to < from) return r;
  const cal = await calendarFor(tx, e.legal_entity_id, e.location_id);
  const leaves = await many<{ start_date: string; end_date: string; start_half: 'full' | 'second_half'; end_half: 'full' | 'first_half'; name: string }>(
    tx,
    `select to_char(r.start_date, 'YYYY-MM-DD') as start_date, to_char(r.end_date, 'YYYY-MM-DD') as end_date, r.start_half, r.end_half, t.name
       from leave_requests r join leave_types t on t.id = r.leave_type_id
      where r.employee_id = $1 and r.status = 'approved' and not t.paid and r.start_date <= $3 and r.end_date >= $2`,
    [e.id, from, to],
  );
  for (const l of leaves) {
    const start = l.start_date < from ? from : l.start_date;
    const end = l.end_date > to ? to : l.end_date;
    const h = leaveMath.countLeaveDays(
      { startDate: start, endDate: end, startHalf: start === l.start_date ? l.start_half : 'full', endHalf: end === l.end_date ? l.end_half : 'full' },
      cal,
    );
    r.unpaidLeave += h;
  }
  if (r.unpaidLeave) r.notes.push(`${dayCount(r.unpaidLeave)} day(s) of approved unpaid leave.`);

  if (source === 'attendance_and_leave') {
    const days = await many<{ status: string; leave_part: string | null; punch_count: number; d: string }>(
      tx,
      `select status, leave_part, punch_count, to_char(work_date, 'YYYY-MM-DD') as d from attendance_days
        where employee_id = $1 and work_date between $2 and $3 and day_type = 'working'`,
      [e.id, from, to],
    );
    const punches = days.reduce((s, d) => s + d.punch_count, 0);
    if (!punches) {
      r.source = 'leave_only_no_attendance';
      r.notes.push('No attendance was recorded this month, so only unpaid leave counts as loss of pay.');
    } else {
      const missing: string[] = [];
      for (const d of days) {
        const halfLeave = d.leave_part === 'first_half' || d.leave_part === 'second_half';
        if (d.status === 'absent') r.absent += halfLeave ? 50 : 100;
        else if (d.status === 'half_day' && !halfLeave) r.halfDays += 50;
        else if (d.status === 'missing_punch') {
          r.missingPunch += 1;
          missing.push(d.d);
        }
      }
      if (r.absent) r.notes.push(`${dayCount(r.absent)} day(s) absent in attendance.`);
      if (r.halfDays) r.notes.push(`${dayCount(r.halfDays)} day(s) lost to half days in attendance.`);
      if (missing.length) r.notes.push(`Missing punches on ${missing.join(', ')} were not counted as loss of pay; review them.`);
    }
  }
  r.total = r.unpaidLeave + r.absent + r.halfDays;
  return r;
}

/** Turns a value for CSV output into a safe cell (quotes, and no spreadsheet formulas). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** ABAC columns for rows that belong to a legal entity only (runs, statutory settings). */
export const ENTITY_SCOPE = (col: string) => ({ legalEntityId: col, membershipId: 'null::uuid', departmentId: 'null::uuid', locationId: 'null::uuid' });
