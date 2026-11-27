/**
 * Attendance report templates (27 November 2026 feedback): the classic monthly reports HR prints or sends, built
 * from SampCrew's attendance days, punches and approved leave. Pure functions, so the API and the tests share them.
 *
 * - Monthly Attendance Report: a status code for every day (D01, D02 ...) per person.
 * - Monthly Present Report: the days each person was present, with a total.
 * - Monthly Summary Report: present, absent, work and overtime hours, each leave type, late and early, weekly offs, holidays.
 * - Monthly Performance Report: per person, the totals and each day's arrival, departure, hours, overtime, status, shift.
 * - Date-wise Performance Report: per person, one row per day with times, hours and paid or unpaid leave, and totals.
 * - In/Out Punch Report: up to six check-ins and check-outs a day with each duration, worked and basic hours, overtime.
 * - Monthly Leave Details: every approved leave in the period.
 */

export const ATTENDANCE_REPORT_KINDS = [
  'standard', 'monthly_attendance', 'monthly_present', 'monthly_summary', 'monthly_performance', 'datewise_performance', 'in_out', 'leave_details',
] as const;
export type AttendanceReportKind = (typeof ATTENDANCE_REPORT_KINDS)[number];

export const ATTENDANCE_REPORT_LABEL: Record<AttendanceReportKind, string> = {
  standard: 'Standard export (totals and date-wise)',
  monthly_attendance: 'Monthly Attendance Report',
  monthly_present: 'Monthly Present Report',
  monthly_summary: 'Monthly Summary Report',
  monthly_performance: 'Monthly Performance Report',
  datewise_performance: 'Employees Date-wise Performance Report',
  in_out: 'In/Out Punch Report',
  leave_details: 'Monthly Leave Details',
};

export const ATTENDANCE_REPORT_ABOUT: Record<AttendanceReportKind, string> = {
  standard: 'Every sheet: About, Employees (totals), Date-wise, HR Workspaces.',
  monthly_attendance: 'A status code for each day of the period per person (P, P-LT, A, WO, HO, leave code ...).',
  monthly_present: 'The days each person was present, with the total.',
  monthly_summary: 'One row per person: present, absent, hours, overtime, each leave type, late and early going, weekly offs and holidays.',
  monthly_performance: 'Per person: the period totals, then arrival, departure, working hours, overtime, status and shift for each day.',
  datewise_performance: 'Per person, one row per day: shift, arrival, late, departure, early, hours, overtime, paid and unpaid leave, remarks.',
  in_out: 'Up to six check-ins and check-outs a day, each duration, worked and basic hours, overtime and status.',
  leave_details: 'Every approved leave in the period with the person, department, designation, dates, leave and reason.',
};

/** What the codes mean, printed under the code reports. */
export const ATTENDANCE_CODE_LEGEND = 'P present · P-LT present, late · HD half day · A absent · MP missing punch · WO weekly off · WOP worked on weekly off · HO holiday · HP worked on holiday · a leave code (CL, SL ...) on leave · -H half-day leave';

export interface ReportPerson {
  employeeId: string;
  code: string;
  name: string;
  department: string;
  designation: string;
  joined: string;
  /** The person's card or enrolment number on attendance machines, when there is one. */
  cardNo?: string;
}

export interface ReportDay {
  employeeId: string;
  date: string;
  /** The stored day status: present, half_day, absent, missing_punch, on_leave, half_day_leave, holiday, weekly_off, in_progress, not_joined. */
  status: string;
  dayType: string;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  shiftCode: string | null;
  /** Shift length in minutes (basic hours), when a shift applies. */
  shiftMinutes: number | null;
  timeZone: string;
}

export interface ReportLeave {
  employeeId: string;
  typeCode: string;
  typeName: string;
  paid: boolean;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  reason: string | null;
}

export interface ReportPunch { employeeId: string; date: string; at: string; direction: 'in' | 'out' }

export interface ReportInput {
  company: string;
  from: string;
  to: string;
  printedAt: string;
  people: ReportPerson[];
  days: ReportDay[];
  leaves: ReportLeave[];
  punches: ReportPunch[];
  /** Leave type codes, in the order their columns appear in the summary. */
  leaveCodes: string[];
}

export type ReportCell = string | number;
export interface ReportTable { name: string; rows: ReportCell[][] }
export interface BuiltReport { title: string; subtitle: string; tables: ReportTable[] }

const WORKED = new Set(['present', 'half_day', 'in_progress', 'missing_punch']);

/** Every date from `from` to `to`, inclusive. */
export function reportDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

/** Minutes as H:MM (0 is empty unless `zero`). */
export function hhmm(minutes: number | null | undefined, zero = false): string {
  const m = Math.round(minutes ?? 0);
  if (!m && !zero) return '';
  const sign = m < 0 ? '-' : '';
  const a = Math.abs(m);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}

/** A time of day (HH:MM, 24 hours) in a time zone. */
export function clockIn(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** DD/MM/YYYY, as the printed reports show dates. */
export const dmy = (date: string) => (date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '');

/** The leave on a date for a person, if any (approved leave only is passed in). */
export function leaveOn(leaves: ReportLeave[], employeeId: string, date: string): ReportLeave | undefined {
  return leaves.find((l) => l.employeeId === employeeId && l.startDate <= date && l.endDate >= date);
}

/** The code a day prints as: P, P-LT, HD, A, MP, WO, WOP, HO, HP, a leave code, or a leave code with -H for half a day. */
export function dayCode(day: ReportDay | undefined, leave?: ReportLeave): string {
  if (!day) return leave ? leave.typeCode : '';
  const worked = WORKED.has(day.status) && (day.workedMinutes > 0 || !!day.firstIn);
  if (day.status === 'not_joined') return '';
  if (day.dayType === 'weekly_off' || day.status === 'weekly_off') return worked ? 'WOP' : 'WO';
  if (day.dayType === 'holiday' || day.status === 'holiday') return worked ? 'HP' : 'HO';
  if (day.status === 'on_leave') return leave?.typeCode ?? 'L';
  if (day.status === 'half_day_leave') return `${leave?.typeCode ?? 'L'}-H`;
  if (day.status === 'present' || day.status === 'in_progress') return day.lateMinutes > 0 ? 'P-LT' : 'P';
  if (day.status === 'half_day') return 'HD';
  if (day.status === 'missing_punch') return 'MP';
  if (day.status === 'absent') return 'A';
  return '';
}

/** The figures of one person over the period, as the summary and performance reports count them. */
export function personTotals(input: ReportInput, employeeId: string) {
  const days = input.days.filter((d) => d.employeeId === employeeId);
  const t = {
    present: 0, absent: 0, halfDays: 0, workMinutes: 0, overtimeMinutes: 0, overtimeDays: 0, lateMinutes: 0, lateDays: 0, earlyMinutes: 0, earlyDays: 0,
    weeklyOff: 0, weeklyOffPresent: 0, holiday: 0, holidayPresent: 0, paidLeave: 0, unpaidLeave: 0, leaveByCode: {} as Record<string, number>, paidDays: 0,
  };
  for (const d of days) {
    const leave = leaveOn(input.leaves, employeeId, d.date);
    const code = dayCode(d, leave);
    t.workMinutes += d.workedMinutes;
    if (d.overtimeMinutes > 0) { t.overtimeMinutes += d.overtimeMinutes; t.overtimeDays += 1; }
    if (d.lateMinutes > 0) { t.lateMinutes += d.lateMinutes; t.lateDays += 1; }
    if (d.earlyLeaveMinutes > 0) { t.earlyMinutes += d.earlyLeaveMinutes; t.earlyDays += 1; }
    if (code === 'P' || code === 'P-LT') t.present += 1;
    else if (code === 'HD') { t.present += 0.5; t.halfDays += 1; t.absent += 0.5; }
    else if (code === 'A' || code === 'MP') t.absent += 1;
    else if (code === 'WO') t.weeklyOff += 1;
    else if (code === 'WOP') { t.weeklyOff += 1; t.weeklyOffPresent += 1; }
    else if (code === 'HO') t.holiday += 1;
    else if (code === 'HP') { t.holiday += 1; t.holidayPresent += 1; }
    else if (leave && (d.status === 'on_leave' || d.status === 'half_day_leave')) {
      const n = d.status === 'half_day_leave' ? 0.5 : 1;
      t.leaveByCode[leave.typeCode] = (t.leaveByCode[leave.typeCode] ?? 0) + n;
      if (leave.paid) t.paidLeave += n; else t.unpaidLeave += n;
      if (d.status === 'half_day_leave') t.present += 0.5;
    }
  }
  // Paid: days worked, paid leave, weekly offs and holidays (worked or not).
  t.paidDays = t.present + t.paidLeave + t.weeklyOff + t.holiday;
  return t;
}

const num = (n: number) => Math.round(n * 100) / 100;

/** Builds one of the report templates as tables (the API writes them to Excel, Word, PDF or CSV). */
export function buildAttendanceReport(kind: Exclude<AttendanceReportKind, 'standard'>, input: ReportInput): BuiltReport {
  const title = ATTENDANCE_REPORT_LABEL[kind];
  const subtitle = `${input.company} · Report from ${dmy(input.from)} to ${dmy(input.to)} · Print date ${input.printedAt}`;
  const dates = reportDates(input.from, input.to);
  const dayOf = new Map(input.days.map((d) => [`${d.employeeId}|${d.date}`, d]));
  const day = (p: ReportPerson, date: string) => dayOf.get(`${p.employeeId}|${date}`);
  const code = (p: ReportPerson, date: string) => dayCode(day(p, date), leaveOn(input.leaves, p.employeeId, date));
  const dLabel = (date: string) => `D${date.slice(8, 10)}`;

  switch (kind) {
    case 'monthly_attendance':
      return { title, subtitle, tables: [{
        name: 'Monthly Attendance',
        rows: [
          ['Emp Code', 'Name', 'Department', ...dates.map(dLabel)],
          ...input.people.map((p) => [p.code, p.name, p.department, ...dates.map((d) => code(p, d))]),
          [ATTENDANCE_CODE_LEGEND],
        ],
      }] };
    case 'monthly_present':
      return { title, subtitle, tables: input.people.map((p) => {
        const present = dates.filter((d) => ['P', 'P-LT', 'HD', 'WOP', 'HP'].includes(code(p, d)));
        const t = personTotals(input, p.employeeId);
        const total = t.present + t.weeklyOffPresent + t.holidayPresent;
        return {
          name: `${p.code} ${p.name}`,
          rows: [
            ['Emp. Code', p.code, 'Emp. Name', p.name, 'Dept', p.department, 'Desig', p.designation],
            [...present.map(dLabel), 'Total Prs.'],
            [...present.map((d) => code(p, d)), num(total).toFixed(2)],
          ],
        };
      }) };
    case 'monthly_summary': {
      const codes = input.leaveCodes;
      return { title, subtitle, tables: [{
        name: 'Monthly Summary',
        rows: [
          ['Emp Code', 'Employee Name', 'Present Days', 'Absent Days', 'Total Work Hrs', 'OT Hours', 'OT Days', ...codes, 'Total Leave', 'Late Coming Hrs', 'Late Coming Days', 'Early Going Hrs', 'Early Going Days', 'Weekly Off', 'Weekly Off Present', 'Holiday', 'Holiday Present'],
          ...input.people.map((p) => {
            const t = personTotals(input, p.employeeId);
            const leaveTotal = Object.values(t.leaveByCode).reduce((a, b) => a + b, 0);
            return [p.code, p.name, num(t.present), num(t.absent), hhmm(t.workMinutes, true), hhmm(t.overtimeMinutes, true), t.overtimeDays, ...codes.map((c) => num(t.leaveByCode[c] ?? 0)), num(leaveTotal), hhmm(t.lateMinutes, true), t.lateDays, hhmm(t.earlyMinutes, true), t.earlyDays, t.weeklyOff, t.weeklyOffPresent, t.holiday, t.holidayPresent];
          }),
        ],
      }] };
    }
    case 'monthly_performance':
      return { title, subtitle, tables: input.people.map((p) => {
        const t = personTotals(input, p.employeeId);
        const leaveTotal = Object.values(t.leaveByCode).reduce((a, b) => a + b, 0);
        const tz = day(p, dates[0]!)?.timeZone ?? 'UTC';
        const at = (d: string, f: (x: ReportDay) => string) => { const x = day(p, d); return x ? f(x) : ''; };
        return {
          name: `${p.code} ${p.name}`,
          rows: [
            ['Dept', p.department, 'Desig', p.designation, 'Attendance month of', input.from.slice(0, 7)],
            ['EmpCode', 'Name', 'Present', 'HL', 'WO', 'Absent', 'Leave', 'PaidDays', 'Early Going', 'LateHrs', 'WorkHrs', 'OvTim'],
            [p.code, p.name, num(t.present), t.halfDays, t.weeklyOff, num(t.absent), num(leaveTotal), num(t.paidDays), hhmm(t.earlyMinutes, true), hhmm(t.lateMinutes, true), hhmm(t.workMinutes, true), hhmm(t.overtimeMinutes, true)],
            ['', ...dates.map((d) => d.slice(8, 10))],
            ['Arrived Time', ...dates.map((d) => at(d, (x) => clockIn(x.firstIn, x.timeZone || tz)))],
            ['Dept. Time', ...dates.map((d) => at(d, (x) => clockIn(x.lastOut, x.timeZone || tz)))],
            ['Working Hrs.', ...dates.map((d) => at(d, (x) => hhmm(x.workedMinutes)))],
            ['O.Time Hrs.', ...dates.map((d) => at(d, (x) => hhmm(x.overtimeMinutes, true)))],
            ['Status', ...dates.map((d) => code(p, d))],
            ['Shift', ...dates.map((d) => at(d, (x) => (x.dayType === 'weekly_off' ? 'OFF' : x.shiftCode ?? '')))],
          ],
        };
      }) };
    case 'datewise_performance':
      return { title, subtitle, tables: input.people.map((p) => {
        const t = personTotals(input, p.employeeId);
        const rows: ReportCell[][] = [
          ['Empcode', p.code, 'CardNo', p.cardNo ?? '', 'Name', p.name, 'Department', p.department],
          ['Date', 'Shift', 'ArrTim', 'LateHrs', 'DepTim', 'EarlHrs', 'WrkHrs', 'OvTim', 'Present', 'Absent', 'Paid_Lv', 'UnPaidLv', 'PrsAbs', 'Remarks'],
        ];
        for (const d of dates) {
          const x = day(p, d);
          if (!x) continue;
          const leave = leaveOn(input.leaves, p.employeeId, d);
          const c = dayCode(x, leave);
          const lv = x.status === 'on_leave' ? 1 : x.status === 'half_day_leave' ? 0.5 : 0;
          const present = c === 'P' || c === 'P-LT' || c === 'WOP' || c === 'HP' ? 1 : c === 'HD' || x.status === 'half_day_leave' ? 0.5 : 0;
          const absent = c === 'A' || c === 'MP' ? 1 : c === 'HD' ? 0.5 : 0;
          const remark = x.status === 'missing_punch' || (x.firstIn && !x.lastOut && x.status !== 'in_progress') ? `${leave && lv ? `${leave.typeCode}: ` : ''}Miss Punch` : leave && lv ? leave.typeName : '';
          rows.push([dmy(d), x.dayType === 'weekly_off' ? 'OFF' : x.shiftCode ?? '', clockIn(x.firstIn, x.timeZone), hhmm(x.lateMinutes), clockIn(x.lastOut, x.timeZone), hhmm(x.earlyLeaveMinutes), hhmm(x.workedMinutes), hhmm(x.overtimeMinutes), present.toFixed(2), absent.toFixed(2), (leave?.paid ? lv : 0).toFixed(2), (leave && !leave.paid ? lv : 0).toFixed(2), c, remark]);
        }
        rows.push(['Total for', p.code, '', hhmm(t.lateMinutes, true), '', hhmm(t.earlyMinutes, true), hhmm(t.workMinutes, true), hhmm(t.overtimeMinutes, true), num(t.present).toFixed(2), num(t.absent).toFixed(2), num(t.paidLeave).toFixed(2), num(t.unpaidLeave).toFixed(2), '', `Paid Days=${num(t.paidDays).toFixed(2)}`]);
        return { name: `${p.code} ${p.name}`, rows };
      }) };
    case 'in_out':
      return { title, subtitle, tables: input.people.map((p) => {
        const head: ReportCell[] = ['Date'];
        for (let i = 1; i <= 6; i++) head.push(`In${i}`, `Out${i}`, `Dur${i}`);
        head.push('W.Hrs', 'Basic.Hrs', 'OT', 'Status');
        const rows: ReportCell[][] = [['Emp.Code', p.code, 'Emp.Name', p.name, 'Dept', p.department, 'Desig', p.designation], head];
        for (const d of dates) {
          const x = day(p, d);
          const tz = x?.timeZone ?? 'UTC';
          const list = input.punches.filter((q) => q.employeeId === p.employeeId && q.date === d).sort((a, b) => a.at.localeCompare(b.at));
          // Pairs of check-in and the check-out after it; an unmatched punch stands alone.
          const pairs: { in: string | null; out: string | null }[] = [];
          for (const q of list) {
            const last = pairs.at(-1);
            if (q.direction === 'in') pairs.push({ in: q.at, out: null });
            else if (last && last.in && !last.out) last.out = q.at;
            else pairs.push({ in: null, out: q.at });
          }
          const row: ReportCell[] = [dmy(d)];
          for (let i = 0; i < 6; i++) {
            const pr = pairs[i];
            const dur = pr?.in && pr.out ? Math.round((Date.parse(pr.out) - Date.parse(pr.in)) / 60_000) : 0;
            row.push(clockIn(pr?.in ?? null, tz), clockIn(pr?.out ?? null, tz), hhmm(dur));
          }
          row.push(hhmm(x?.workedMinutes ?? 0), x && x.dayType === 'working' ? hhmm(x.shiftMinutes ?? 0, true) : hhmm(0, true), hhmm(x?.overtimeMinutes ?? 0), code(p, d));
          rows.push(row);
        }
        return { name: `${p.code} ${p.name}`, rows };
      }) };
    case 'leave_details': {
      const byId = new Map(input.people.map((p) => [p.employeeId, p]));
      const rows: ReportCell[][] = [['Emp Code', 'EmpName', 'DtJoin', 'Dept Name', 'Desig Name', 'FromDate', 'ToDate', 'Leave Name', 'Reason']];
      for (const l of [...input.leaves].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
        const p = byId.get(l.employeeId);
        if (!p) continue;
        rows.push([p.code, p.name, dmy(p.joined), p.department, p.designation, dmy(l.startDate), dmy(l.endDate), l.typeCode, l.reason ?? '']);
      }
      return { title, subtitle, tables: [{ name: 'Monthly Leave Details', rows }] };
    }
  }
}
