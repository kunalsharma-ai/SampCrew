import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;
const day = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);
/** A Monday to Friday date at least `n` days ahead. */
const weekdayAhead = (n: number) => {
  let i = n;
  while ([0, 6].includes(new Date(`${day(i)}T00:00:00Z`).getUTCDay())) i++;
  return day(i);
};
const fieldErrors = (body: { error?: { details?: { path: string; message: string }[] } }) => Object.fromEntries((body.error?.details ?? []).map((d) => [d.path, d.message]));
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const rule = (over: Record<string, unknown> = {}) => ({ visible: true, required: false, label: null, hint: null, placeholder: null, ...over });

/**
 * Issue #91 through the API: Form management for every form (Super Workspace only), the rules applied by Add Employee,
 * the employee profile and the leave request, custom fields set up only by the Super Workspace and filled in on Add
 * Employee, the server clock for attendance, and the attendance report templates.
 */
describe('Issue #91', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hr: string;
  let staff: { email: string; membershipId: string; token: string; employeeId: string };

  const ok = (res: { status: number; body: unknown }, status = 200): Any => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Any;
  };
  const hire = (token: string, body: Record<string, unknown>) =>
    api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: day(-60), probationMonths: 0, onboardingTemplateId: null, ...body });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const h = await addMember(pool, t, { name: 'Hari HR' });
    ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Pune', code: 'PUN', kind: 'branch', features: ['leave', 'attendance_basic', 'core_hr', 'documents'], adminMembershipIds: [h.membershipId] }), 201);
    hr = (await login(app, h.email)).accessToken;
    const m = await addMember(pool, t, { name: 'Sana Staff' });
    const e = ok(await hire(owner, { firstName: 'Sana', lastName: 'Staff', dateOfJoining: '2024-01-15', membershipId: m.membershipId }), 201).employee;
    staff = { ...m, token: (await login(app, m.email)).accessToken, employeeId: e.id };
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('Form management lists every form; only the Super Workspace changes one', async () => {
    const forms = ok(await api(app, owner).get('/forms')) as unknown as Any[];
    expect(forms.map((f) => f.key)).toEqual(['add_employee', 'employee_profile', 'leave_request', 'asset', 'bgv_case', 'candidate', 'client']);
    const view = ok(await api(app, owner).get('/forms/leave_request'));
    expect(view).toMatchObject({ canChange: true, form: { key: 'leave_request', entity: 'leave_request' } });
    expect(view.resolved).toEqual([expect.objectContaining({ key: 'reason', visible: true, required: false })]);
    expect((await api(app, owner).get('/forms/payslip')).status).toBe(422);

    // HR reads the form as set up but cannot change it.
    expect(ok(await api(app, hr).get('/forms/leave_request')).canChange).toBe(false);
    expect((await api(app, hr).put('/forms/leave_request').send({ fields: { reason: rule({ required: true }) } })).status).toBe(403);
    // Rules that cannot work are refused.
    expect((await api(app, owner).put('/forms/leave_request').send({ fields: { reason: rule({ visible: false, required: true }) } })).status).toBe(422);
    expect((await api(app, owner).put('/forms/leave_request').send({ fields: { salary: rule() } })).status).toBe(422);
    expect((await api(app, owner).put('/forms/employee_profile').send({ fields: { firstName: rule({ visible: false }) } })).status).toBe(422);

    const saved = ok(await api(app, owner).put('/forms/leave_request').send({ fields: { reason: rule({ required: true, label: 'Why', placeholder: 'Tell HR why', hint: 'Shown to your approver' }) } }));
    expect(saved.resolved[0]).toMatchObject({ key: 'reason', label: 'Why', required: true, placeholder: 'Tell HR why', hint: 'Shown to your approver' });
    expect(saved.updatedAt).toBeTruthy();
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'form.changed' })).toBeGreaterThanOrEqual(1);
    // Everyone reads the same saved rules.
    expect(ok(await api(app, staff.token).get('/forms/leave_request')).resolved[0]).toMatchObject({ label: 'Why', required: true });
    const summary = (ok(await api(app, owner).get('/forms')) as unknown as Any[]).find((f) => f.key === 'leave_request');
    expect(summary.requiredFields).toBe(1);
  });

  it('Add Employee is one of the forms: no field but the first name is required, and every other one can be hidden', async () => {
    const view = ok(await api(app, owner).get('/forms/add_employee'));
    expect(view.resolved.filter((f: Any) => f.required).map((f: Any) => f.key)).toEqual(['firstName']);
    expect(view.resolved.filter((f: Any) => f.locked).map((f: Any) => f.key)).toEqual(['firstName']);
    const hideAll = Object.fromEntries(view.resolved.filter((f: Any) => !f.locked).map((f: Any) => [f.key, rule({ visible: false })]));
    const saved = ok(await api(app, owner).put('/forms/add_employee').send({ workEmailDomains: ['acme.example'], enforceWorkEmailDomain: false, fields: { ...hideAll, workEmail: rule({ visible: false }) } }));
    expect(saved.resolved.filter((f: Any) => f.visible).map((f: Any) => f.key)).toEqual(['firstName']);
    expect(saved.workEmailDomains).toEqual(['acme.example']);
    // With every optional field hidden, a person can still be added with just a first name.
    ok(await hire(hr, { firstName: 'Only' }), 201);
    // Requiring a field makes Add Employee refuse it empty.
    ok(await api(app, owner).put('/forms/add_employee').send({ workEmailDomains: [], enforceWorkEmailDomain: false, fields: { phone: rule({ required: true, label: 'Mobile' }) } }));
    const noPhone = await hire(hr, { firstName: 'Nomobile' });
    expect(noPhone.status).toBe(422);
    expect(fieldErrors(noPhone.body).phone).toMatch(/Mobile is required/);
    ok(await api(app, owner).put('/forms/add_employee').send({ workEmailDomains: [], enforceWorkEmailDomain: false, fields: {} }));
  });

  it('custom fields are set up only by the Super Workspace, and Add Employee fills them in', async () => {
    expect((await api(app, hr).post('/custom-fields').send({ entity: 'employee', label: 'T-shirt size', type: 'short_text' })).status).toBe(403);
    const f = ok(await api(app, owner).post('/custom-fields').send({ entity: 'employee', label: 'T-shirt size', type: 'short_text', required: true }), 201);
    expect(f.key).toBe('t_shirt_size');
    expect((await api(app, hr).patch(`/custom-fields/${f.id}`).send({ label: 'Shirt' })).status).toBe(403);
    // The field shows on the Employee profile form (and so on Add Employee) for everyone.
    expect((ok(await api(app, hr).get('/forms/employee_profile')).customFields as Any[]).map((x) => x.key)).toContain('t_shirt_size');

    const missing = await hire(hr, { firstName: 'Kiran', lastName: 'Custom' });
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(fieldErrors(missing.body)['customFields.t_shirt_size']).toMatch(/T-shirt size is required/);
    const e = ok(await hire(hr, { firstName: 'Kiran', lastName: 'Custom', customFields: { t_shirt_size: 'L' } }), 201).employee;
    const values = await pool.find('custom_field_values', { field_id: f.id, record_id: e.id });
    expect(values.map((v) => v.value)).toEqual(['L']);
    // Nothing is half-saved when the hire is refused.
    expect(await pool.count('employees', { tenant_id: t.id, first_name: 'Kiran' })).toBe(1);

    // Archived, the field no longer holds up Add Employee.
    ok(await api(app, owner).post(`/custom-fields/${f.id}/archive`).send({ archived: true }), 201);
    ok(await hire(hr, { firstName: 'After', lastName: 'Archive' }), 201);
  });

  it('the Employee profile form: a field the Super Workspace made required cannot be emptied', async () => {
    ok(await api(app, owner).put('/forms/employee_profile').send({ fields: { preferredName: rule({ required: true, label: 'Known as' }) } }));
    const emptied = await api(app, owner).patch(`/employees/${staff.employeeId}`).send({ preferredName: null });
    expect(emptied.status, JSON.stringify(emptied.body)).toBe(422);
    expect(fieldErrors(emptied.body).preferredName).toMatch(/Known as is required/);
    ok(await api(app, owner).patch(`/employees/${staff.employeeId}`).send({ preferredName: 'Sanu' }));
    // Fields the rule does not cover save as before.
    ok(await api(app, owner).patch(`/employees/${staff.employeeId}`).send({ lastName: 'Staffer' }));
    ok(await api(app, owner).put('/forms/employee_profile').send({ fields: {} }));
  });

  it('the Leave request form: a required reason, and a custom leave field saved with the request', async () => {
    const type = ok(await api(app, owner).post('/leave/types').send({ name: 'Casual Leave', code: 'CL', visibility: 'both' }), 201);
    const date = weekdayAhead(20);
    // The reason is required (set in the first test).
    const noReason = await api(app, staff.token).post('/leave/requests').send({ leaveTypeId: type.id, startDate: date, endDate: date });
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(422);
    expect(fieldErrors(noReason.body).reason).toMatch(/Why is required/);

    const cover = ok(await api(app, owner).post('/custom-fields').send({ entity: 'leave_request', label: 'Cover person', type: 'short_text' }), 201);
    const req = ok(await api(app, staff.token).post('/leave/requests').send({ leaveTypeId: type.id, startDate: date, endDate: date, reason: 'Family visit', customFields: { cover_person: 'Ravi' } }), 201);
    expect((await pool.find('custom_field_values', { field_id: cover.id, record_id: req.id })).map((v) => v.value)).toEqual(['Ravi']);

    // With the reason optional again, a request without one goes through.
    ok(await api(app, owner).put('/forms/leave_request').send({ fields: {} }));
    const date2 = weekdayAhead(30);
    ok(await api(app, staff.token).post('/leave/requests').send({ leaveTypeId: type.id, startDate: date2, endDate: date2 }), 201);
  });

  it('attendance uses the server clock: today carries the server time, whatever the laptop says', async () => {
    const before = Date.now();
    const today = ok(await api(app, staff.token).get('/attendance/today'));
    expect(typeof today.serverTime).toBe('string');
    const at = Date.parse(today.serverTime);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  describe('attendance report templates', () => {
    const from = '2024-03-04';
    const to = '2024-03-10';
    const get = (token: string, qs: string) => api(app, token).get(`/attendance/export?from=${from}&to=${to}${qs}`).buffer(true).parse(binary as never) as unknown as Promise<{ status: number; body: Buffer; headers: Record<string, string> }>;
    const csvLines = (b: Buffer) => b.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');

    beforeAll(async () => {
      const lt = ok(await api(app, owner).post('/leave/types').send({ name: 'Sick Leave', code: 'SL', visibility: 'both' }), 201);
      await pool.tenant(t.id, async (tx) => {
        const base = { employee_id: staff.employeeId, engine_version: 1, early_leave_minutes: 0, overtime_minutes: 0 };
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-04', status: 'present', day_type: 'working', late_minutes: 0, worked_minutes: 540, first_in: new Date('2024-03-04T03:30:00Z'), last_out: new Date('2024-03-04T12:30:00Z') });
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-05', status: 'present', day_type: 'working', late_minutes: 25, worked_minutes: 500, first_in: new Date('2024-03-05T03:55:00Z'), last_out: new Date('2024-03-05T12:15:00Z') });
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-06', status: 'absent', day_type: 'working', late_minutes: 0, worked_minutes: 0, first_in: null, last_out: null });
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-07', status: 'on_leave', day_type: 'working', late_minutes: 0, worked_minutes: 0, first_in: null, last_out: null });
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-08', status: 'present', day_type: 'working', late_minutes: 0, worked_minutes: 480, first_in: new Date('2024-03-08T03:30:00Z'), last_out: new Date('2024-03-08T11:30:00Z') });
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-09', status: 'weekly_off', day_type: 'weekly_off', late_minutes: 0, worked_minutes: 0, first_in: null, last_out: null });
        // Every day of the week is stored, so the overview has no gap to count again from punches.
        await tx.collection('attendance_days').insert({ ...base, work_date: '2024-03-10', status: 'weekly_off', day_type: 'weekly_off', late_minutes: 0, worked_minutes: 0, first_in: null, last_out: null });
        await tx.collection('leave_requests').insert({ employee_id: staff.employeeId, leave_type_id: lt.id, start_date: '2024-03-07', end_date: '2024-03-07', status: 'approved', days: '1', reason: 'Fever' });
      });
    });

    it('Monthly Attendance Report (D01..Dn codes) as CSV', async () => {
      const r = await get(owner, `&report=monthly_attendance&format=csv&employeeIds=${staff.employeeId}`);
      expect(r.status, r.body.toString()).toBe(200);
      expect(r.headers['content-disposition']).toContain('monthly-attendance-2024-03-04-to-2024-03-10.csv');
      const lines = csvLines(r.body);
      expect(lines[1]).toBe('Emp Code,Name,Department,D04,D05,D06,D07,D08,D09,D10');
      const row = lines.find((l) => l.includes('Staff'))!;
      expect(row.endsWith(',P,P-LT,A,SL,P,WO,WO'), row).toBe(true);
    });

    it('Monthly Summary counts present, absent, leave by code and late days', async () => {
      const lines = csvLines((await get(owner, `&report=monthly_summary&format=csv&employeeIds=${staff.employeeId}`)).body);
      const head = lines[1]!.split(',');
      const row = lines.find((l) => l.includes('Staff'))!.split(',');
      const col = (name: string) => row[head.indexOf(name)];
      expect(col('Present Days')).toBe('3');
      expect(col('Absent Days')).toBe('1');
      expect(col('SL')).toBe('1');
      expect(col('Late Coming Days')).toBe('1');
      expect(col('Weekly Off')).toBe('2');
    });

    it('Monthly Leave Details lists the approved leave with its reason', async () => {
      const lines = csvLines((await get(owner, `&report=leave_details&format=csv&employeeIds=${staff.employeeId}`)).body);
      expect(lines.some((l) => l.includes('07/03/2024') && l.includes(',SL,') && l.includes('Fever'))).toBe(true);
    });

    it('every template downloads as Excel, Word and PDF, and each export is audited', async () => {
      const kinds = ['leave_details', 'monthly_present', 'monthly_performance', 'datewise_performance', 'monthly_attendance', 'monthly_summary', 'in_out'];
      const magic: Record<string, string> = { xlsx: 'PK', docx: 'PK', pdf: '%PDF' };
      for (const kind of kinds) {
        for (const format of ['xlsx', 'docx', 'pdf']) {
          const r = await get(owner, `&report=${kind}&format=${format}&employeeIds=${staff.employeeId}`);
          expect(r.status, `${kind} ${format}: ${r.body.toString().slice(0, 200)}`).toBe(200);
          expect(r.body.subarray(0, magic[format]!.length).toString()).toBe(magic[format]);
        }
      }
      const audits = await pool.find('audit_events', { tenant_id: t.id, action: 'attendance.exported' });
      expect(new Set(audits.map((a) => (a.metadata as Any)?.report))).toEqual(new Set([...kinds, 'monthly_attendance']));
    });

    it('an unknown report is refused, and an Employee Workspace gets only their own rows', async () => {
      expect((await get(owner, '&report=payroll&format=csv')).status).toBe(422);
      const own = await get(staff.token, '&report=monthly_attendance&format=csv');
      expect(own.status, own.body.toString()).toBe(200);
      // Title, header, the person's own row, then the code legend.
      const people = csvLines(own.body).slice(2, -1);
      expect(people).toHaveLength(1);
      expect(people[0]).toContain('Staff');
    });
  });
});
