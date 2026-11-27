import { describe, expect, it } from 'vitest';
import {
  ATTENDANCE_REPORT_KINDS, EMPLOYEE_FORM_FIELDS, FORMS, FORM_KEYS, FORM_OF_ENTITY, attendanceExportQuery, buildAttendanceReport, createEmployeeInput, dayCode,
  formDefinition, formRulesError, formSettingsInput, hhmm, missingEmployeeFields, missingFormFields, personTotals, reportDates, resolveEmployeeForm, resolveForm,
  type ReportDay, type ReportInput, type ReportLeave,
} from './index';

const rule = (over: Partial<{ visible: boolean; required: boolean; label: string | null; hint: string | null; placeholder: string | null }> = {}) => ({
  visible: true, required: false, label: null, hint: null, placeholder: null, ...over,
});

describe('issue #91: Form management covers every form', () => {
  it('lists every form once, each with a record type', () => {
    expect(FORMS.map((f) => f.key)).toEqual([...FORM_KEYS]);
    for (const f of FORMS) expect(f.entity).toBeTruthy();
    expect(FORM_OF_ENTITY.employee).toBe('employee_profile');
    expect(FORM_OF_ENTITY.leave_request).toBe('leave_request');
    expect(formDefinition('nope')).toBeUndefined();
  });

  it('Add Employee: only the first name is compulsory, every other field can be hidden or optional', () => {
    const locked = EMPLOYEE_FORM_FIELDS.filter((f) => 'locked' in f && f.locked).map((f) => f.key);
    expect(locked).toEqual(['firstName']);
    const resolved = resolveEmployeeForm({ fields: {} });
    expect(resolved.filter((f) => f.required).map((f) => f.key)).toEqual(['firstName']);
    const def = formDefinition('add_employee')!;
    const hideAll = Object.fromEntries(def.builtIn.filter((f) => !f.locked).map((f) => [f.key, rule({ visible: false })]));
    expect(formRulesError(def, hideAll)).toBeNull();
    const r = resolveForm(def, hideAll);
    expect(r.filter((f) => f.visible).map((f) => f.key)).toEqual(['firstName']);
  });

  it('the joining date, legal entity and employment type say what is used when hidden', () => {
    const def = formDefinition('add_employee')!;
    const fb = Object.fromEntries(def.builtIn.filter((f) => f.fallback).map((f) => [f.key, f.fallback]));
    expect(fb).toEqual({ dateOfJoining: 'Today', legalEntityId: 'The first legal entity', employmentType: 'Full time' });
  });

  it('with no rules, no field is reported missing (the first name is checked by the record schema itself)', () => {
    expect(missingEmployeeFields({ firstName: 'Asha' }, { fields: {} })).toEqual({});
    expect(missingEmployeeFields({}, { fields: {} })).toEqual({});
    expect(missingEmployeeFields({}, { fields: { phone: rule({ required: true }) } })).toEqual({ phone: 'Phone is required' });
  });

  it('resolves label, placeholder, help line and required, and drops required on a hidden field', () => {
    const def = formDefinition('employee_profile')!;
    const r = resolveForm(def, { phone: rule({ required: true, label: 'Mobile', placeholder: '98xxxxxxxx', hint: 'With country code' }), gender: rule({ visible: false, required: false }) });
    const phone = r.find((f) => f.key === 'phone')!;
    expect(phone).toMatchObject({ label: 'Mobile', builtInLabel: 'Phone', required: true, placeholder: '98xxxxxxxx', hint: 'With country code', visible: true });
    expect(r.find((f) => f.key === 'gender')).toMatchObject({ visible: false, required: false });
    expect(missingFormFields(r, { firstName: 'A', phone: '  ' })).toEqual({ phone: 'Mobile is required' });
    expect(missingFormFields(r, { firstName: 'A' }, ['gender'])).toEqual({});
  });

  it('refuses rules that cannot work', () => {
    const def = formDefinition('employee_profile')!;
    expect(formRulesError(def, { firstName: rule({ visible: false }) })).toMatch(/always on the form/);
    expect(formRulesError(def, { phone: rule({ visible: false, required: true }) })).toMatch(/cannot be hidden and required/);
    expect(formRulesError(def, { salary: rule() })).toMatch(/no field salary/);
    expect(formRulesError(formDefinition('leave_request')!, { reason: rule({ required: true }) })).toBeNull();
  });

  it('settings input fills defaults and rejects unknown top-level keys', () => {
    expect(formSettingsInput.parse({ fields: { reason: { required: true } } }).fields.reason).toEqual(rule({ required: true }));
    expect(() => formSettingsInput.parse({ fields: {}, other: 1 })).toThrow();
  });

  it('Add Employee carries custom field values', () => {
    const v = createEmployeeInput.safeParse({ firstName: 'Asha', legalEntityId: '0190a7b8-1c2d-7e3f-8a9b-0c1d2e3f4a5b', dateOfJoining: '2026-11-27', customFields: { tshirt_size: 'M' } });
    expect(v.success && v.data.customFields).toEqual({ tshirt_size: 'M' });
  });
});

const day = (over: Partial<ReportDay>): ReportDay => ({
  employeeId: 'e1', date: '2026-11-02', status: 'present', dayType: 'working', firstIn: '2026-11-02T03:30:00.000Z', lastOut: '2026-11-02T12:30:00.000Z',
  workedMinutes: 540, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, shiftCode: 'GEN', shiftMinutes: 540, timeZone: 'Asia/Kolkata', ...over,
});
const cl: ReportLeave = { employeeId: 'e1', typeCode: 'CL', typeName: 'Casual leave', paid: true, startDate: '2026-11-05', endDate: '2026-11-05', halfDay: false, reason: 'Family' };
const lwp: ReportLeave = { employeeId: 'e1', typeCode: 'LWP', typeName: 'Leave without pay', paid: false, startDate: '2026-11-06', endDate: '2026-11-06', halfDay: true, reason: null };

const input = (): ReportInput => ({
  company: 'Acme', from: '2026-11-01', to: '2026-11-07', printedAt: '27/11/2026',
  people: [{ employeeId: 'e1', code: 'E001', name: 'Asha Rao', department: 'Sales', designation: 'Executive', joined: '2026-01-15', cardNo: '1001' }],
  days: [
    day({ date: '2026-11-01', status: 'weekly_off', dayType: 'weekly_off', firstIn: null, lastOut: null, workedMinutes: 0, shiftMinutes: null }),
    day({ date: '2026-11-02' }),
    day({ date: '2026-11-03', lateMinutes: 20, overtimeMinutes: 30, firstIn: '2026-11-03T03:50:00.000Z' }),
    day({ date: '2026-11-04', status: 'absent', firstIn: null, lastOut: null, workedMinutes: 0 }),
    day({ date: '2026-11-05', status: 'on_leave', firstIn: null, lastOut: null, workedMinutes: 0 }),
    day({ date: '2026-11-06', status: 'half_day_leave', workedMinutes: 240 }),
    day({ date: '2026-11-07', status: 'holiday', dayType: 'holiday', firstIn: null, lastOut: null, workedMinutes: 0 }),
  ],
  leaves: [cl, lwp],
  punches: [
    { employeeId: 'e1', date: '2026-11-02', at: '2026-11-02T03:30:00.000Z', direction: 'in' },
    { employeeId: 'e1', date: '2026-11-02', at: '2026-11-02T07:30:00.000Z', direction: 'out' },
    { employeeId: 'e1', date: '2026-11-02', at: '2026-11-02T08:00:00.000Z', direction: 'in' },
    { employeeId: 'e1', date: '2026-11-02', at: '2026-11-02T12:30:00.000Z', direction: 'out' },
  ],
  leaveCodes: ['CL', 'LWP'],
});

const Q = { from: '2026-11-01', to: '2026-11-30' };
describe('issue #91: attendance report templates', () => {
  it('the export takes a report kind, standard by default', () => {
    expect(attendanceExportQuery.parse(Q).report).toBe('standard');
    for (const k of ATTENDANCE_REPORT_KINDS) expect(attendanceExportQuery.parse({ ...Q, report: k }).report).toBe(k);
    expect(() => attendanceExportQuery.parse({ ...Q, report: 'nope' })).toThrow();
  });

  it('day codes', () => {
    expect(dayCode(day({}))).toBe('P');
    expect(dayCode(day({ lateMinutes: 5 }))).toBe('P-LT');
    expect(dayCode(day({ status: 'half_day' }))).toBe('HD');
    expect(dayCode(day({ status: 'absent', firstIn: null, workedMinutes: 0 }))).toBe('A');
    expect(dayCode(day({ status: 'missing_punch', lastOut: null }))).toBe('MP');
    expect(dayCode(day({ status: 'weekly_off', dayType: 'weekly_off', firstIn: null, workedMinutes: 0 }))).toBe('WO');
    expect(dayCode(day({ status: 'present', dayType: 'weekly_off' }))).toBe('WOP');
    expect(dayCode(day({ status: 'holiday', dayType: 'holiday', firstIn: null, workedMinutes: 0 }))).toBe('HO');
    expect(dayCode(day({ status: 'present', dayType: 'holiday' }))).toBe('HP');
    expect(dayCode(day({ status: 'on_leave' }), cl)).toBe('CL');
    expect(dayCode(day({ status: 'half_day_leave' }), lwp)).toBe('LWP-H');
    expect(dayCode(day({ status: 'not_joined' }))).toBe('');
  });

  it('helpers', () => {
    expect(reportDates('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
    expect(hhmm(0)).toBe('');
    expect(hhmm(0, true)).toBe('0:00');
    expect(hhmm(545)).toBe('9:05');
  });

  it('totals: present, absent, leave by code, paid days', () => {
    const t = personTotals(input(), 'e1');
    expect(t).toMatchObject({ present: 2.5, absent: 1, weeklyOff: 1, holiday: 1, paidLeave: 1, unpaidLeave: 0.5, lateDays: 1, lateMinutes: 20, overtimeDays: 1 });
    expect(t.leaveByCode).toEqual({ CL: 1, LWP: 0.5 });
    expect(t.paidDays).toBe(5.5);
  });

  it('Monthly Attendance Report: one column per day, D01..Dn', () => {
    const r = buildAttendanceReport('monthly_attendance', input());
    const [head, row] = r.tables[0]!.rows;
    expect(head).toEqual(['Emp Code', 'Name', 'Department', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07']);
    expect(row).toEqual(['E001', 'Asha Rao', 'Sales', 'WO', 'P', 'P-LT', 'A', 'CL', 'LWP-H', 'HO']);
    expect(r.subtitle).toContain('01/11/2026');
  });

  it('Monthly Summary: the columns of the sample sheet', () => {
    const [head, row] = buildAttendanceReport('monthly_summary', input()).tables[0]!.rows;
    expect(head).toEqual(['Emp Code', 'Employee Name', 'Present Days', 'Absent Days', 'Total Work Hrs', 'OT Hours', 'OT Days', 'CL', 'LWP', 'Total Leave', 'Late Coming Hrs', 'Late Coming Days', 'Early Going Hrs', 'Early Going Days', 'Weekly Off', 'Weekly Off Present', 'Holiday', 'Holiday Present']);
    expect(row!.slice(0, 4)).toEqual(['E001', 'Asha Rao', 2.5, 1]);
    expect(row![7]).toBe(1);
    expect(row![9]).toBe(1.5);
  });

  it('Monthly Present Report lists only the days present', () => {
    const rows = buildAttendanceReport('monthly_present', input()).tables[0]!.rows;
    expect(rows[1]).toEqual(['D02', 'D03', 'Total Prs.']);
    expect(rows[2]).toEqual(['P', 'P-LT', '2.50']);
  });

  it('Monthly Performance Report shows arrival and departure in the workspace time zone', () => {
    const rows = buildAttendanceReport('monthly_performance', input()).tables[0]!.rows;
    const arrived = rows.find((r) => r[0] === 'Arrived Time')!;
    expect(arrived[2]).toBe('09:00');
    expect(rows.find((r) => r[0] === 'Shift')![1]).toBe('OFF');
  });

  it('Date-wise Performance Report ends with a total and paid days', () => {
    const rows = buildAttendanceReport('datewise_performance', input()).tables[0]!.rows;
    expect(rows[0]).toContain('1001');
    expect(rows.at(-1)!.at(-1)).toBe('Paid Days=5.50');
    expect(rows.find((r) => r[0] === '05/11/2026')!.at(-1)).toBe('Casual leave');
  });

  it('In/Out register pairs punches into In1/Out1, In2/Out2 with durations', () => {
    const rows = buildAttendanceReport('in_out', input()).tables[0]!.rows;
    expect(rows[1]!.slice(0, 4)).toEqual(['Date', 'In1', 'Out1', 'Dur1']);
    expect(rows[1]!.slice(-4)).toEqual(['W.Hrs', 'Basic.Hrs', 'OT', 'Status']);
    const d2 = rows.find((r) => r[0] === '02/11/2026')!;
    expect(d2.slice(1, 7)).toEqual(['09:00', '13:00', '4:00', '13:30', '18:00', '4:30']);
    expect(d2.at(-1)).toBe('P');
  });

  it('Monthly Leave Details lists each approved leave', () => {
    const rows = buildAttendanceReport('leave_details', input()).tables[0]!.rows;
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(['E001', 'Asha Rao', '15/01/2026', 'Sales', 'Executive', '05/11/2026', '05/11/2026', 'CL', 'Family']);
  });
});
