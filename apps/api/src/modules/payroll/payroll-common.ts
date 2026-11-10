import { leaveMath, type payrollEngine, type WorkCalendar } from '@crew/contracts';
import type { TenantTx } from '../../platform/database/mongo.service';
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
export async function statutoryOn(tx: TenantTx, legalEntityId: string, date: string): Promise<StatutoryRow | undefined> {
  const row = await tx.collection('statutory_settings').findOne({ legal_entity_id: legalEntityId, effective_from: { $lte: date } }, { sort: { effective_from: -1 } });
  return row ? { id: row.id, legal_entity_id: row.legal_entity_id, effective_from: row.effective_from, lop_source: row.lop_source, settings: row.settings } : undefined;
}

export async function legalEntity(tx: TenantTx, id: string) {
  const le = await tx.collection<{ id: string; name: string; legal_name: string; currency: string; country_code: string }>('legal_entities').findOne({ id });
  if (!le) throw Errors.notFound('Legal entity');
  return { id: le.id, name: le.name, legal_name: le.legal_name, currency: le.currency, country_code: le.country_code };
}

/** The holiday calendar for an employee: their location's, else their legal entity's, else the workspace default. */
export async function calendarFor(tx: TenantTx, legalEntityId: string | null, locationId: string | null): Promise<WorkCalendar> {
  const candidates = await tx.collection('holiday_calendars').find({
    $or: [...(locationId ? [{ location_id: locationId }] : []), ...(legalEntityId ? [{ location_id: null, legal_entity_id: legalEntityId }] : []), { is_default: true }],
  });
  const rank = (c: Record<string, unknown>) => (locationId && c.location_id === locationId ? 0 : legalEntityId && !c.location_id && c.legal_entity_id === legalEntityId ? 1 : 2);
  const cal = candidates.sort((a, b) => rank(a) - rank(b))[0];
  if (!cal) return { weeklyOffs: [0, 6], holidays: new Set() };
  const hs = await tx.collection('holidays').find({ calendar_id: cal.id, is_optional: false }, { projection: { holiday_date: 1 } });
  return { weeklyOffs: (cal.weekly_offs as number[]).map(Number), holidays: new Set(hs.map((h) => h.holiday_date as string)) };
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
  tx: TenantTx,
  e: { id: string; legal_entity_id: string | null; location_id: string | null },
  from: string,
  to: string,
  source: 'attendance_and_leave' | 'leave_only',
): Promise<LopResult> {
  const r: LopResult = { total: 0, absent: 0, halfDays: 0, unpaidLeave: 0, missingPunch: 0, source, notes: [] };
  if (to < from) return r;
  const cal = await calendarFor(tx, e.legal_entity_id, e.location_id);
  const unpaid = await tx.collection('leave_types').find({ paid: false }, { projection: { name: 1 } });
  const leaves = await tx.collection<{ start_date: string; end_date: string; start_half: 'full' | 'second_half'; end_half: 'full' | 'first_half' }>('leave_requests').find({
    employee_id: e.id, status: 'approved', leave_type_id: { $in: unpaid.map((t) => t.id) }, start_date: { $lte: to }, end_date: { $gte: from },
  });
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
    const days = (await tx.collection('attendance_days').find({ employee_id: e.id, work_date: { $gte: from, $lte: to }, day_type: 'working' }, { sort: { work_date: 1 } }))
      .map((d) => ({ status: d.status as string, leave_part: (d.leave_part ?? null) as string | null, punch_count: Number(d.punch_count), d: d.work_date as string }));
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

/** ABAC fields for rows that belong to a legal entity only (runs, statutory settings): team, department and location grants match none. */
export const ENTITY_FIELDS = (field: string) => ({ legalEntityId: field, membershipId: '_no_membership', departmentId: '_no_department', locationId: '_no_location' });
