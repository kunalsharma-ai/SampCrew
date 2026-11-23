import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceTotals, bucketOf } from '@crew/contracts';
import { readXlsx } from '../src/platform/export/tabular';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** Monday to Friday of the week before last, so every day is in the past in every time zone. */
const week = (() => {
  const today = new Date().toISOString().slice(0, 10);
  let d = plus(today, -14);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = plus(d, -1);
  return [0, 1, 2, 3, 4].map((i) => plus(d, i));
})();
const FROM = week[0]!;
const TO = week[4]!;

type Row = { employeeId: string; name: string; level: string; totals: { present: number; absent: number; leave: number; workingDays: number; percent: number | null } };

/** Excel download as a Buffer (supertest gives binary bodies as text otherwise). */
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * The attendance redesign through the HTTP API: every level sees its own attendance; Super Workspace sees everyone;
 * HR Workspace sees its own employees, other HR Workspaces only when the Super Workspace allows it and never the
 * Super Workspace; Employee Workspace sees only itself, whatever it asks for. The Excel export holds the same data.
 */
describe('attendance overview, permissions and Excel export', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  let wsA: string;
  let wsB: string;

  const setDays = async (who: string, statuses: string[]) => {
    await pool.tenant(t.id, async (tx) => {
      for (const [i, status] of statuses.entries()) {
        await tx.collection('attendance_days').delete({ employee_id: ids[who], work_date: week[i] });
        await tx.collection('attendance_days').insert({
          employee_id: ids[who], work_date: week[i], status, day_type: 'working', engine_version: 1, late_minutes: status === 'present' && i === 0 ? 12 : 0,
          worked_minutes: status === 'present' ? 480 : status === 'half_day' ? 240 : 0, first_in: status === 'present' ? new Date(`${week[i]}T03:30:00Z`) : null, last_out: status === 'present' ? new Date(`${week[i]}T12:00:00Z`) : null,
        });
      }
    });
  };
  const people = async (token: string, extra = '') => {
    const r = await api(app, token).get(`/attendance/overview/people?from=${FROM}&to=${TO}&pageSize=200${extra}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { rows: Row[]; total: number; totals: Row['totals'] };
  };
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();
  const xlsx = async (token: string, qs = '') => {
    const r = await api(app, token).get(`/attendance/export.xlsx?from=${FROM}&to=${TO}${qs}`).buffer(true).parse(binary as never);
    return r as unknown as { status: number; body: Buffer; headers: Record<string, string> };
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hrA = await addMember(pool, t, { name: 'Asha HR' });
    const hrB = await addMember(pool, t, { name: 'Bala HR' });
    const staff = await addMember(pool, t, { name: 'Esha Staff' });
    const mk = async (body: Record<string, unknown>) => {
      const r = await api(app, owner).post('/hr-workspaces').send({ kind: 'branch', features: ['leave', 'attendance_basic'], ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    wsA = await mk({ name: 'Pune Branch', code: 'PUNE', adminMembershipIds: [hrA.membershipId] });
    wsB = await mk({ name: 'Delhi Branch', code: 'DEL', adminMembershipIds: [hrB.membershipId] });
    const hire = async (key: string, first: string, body: Record<string, unknown>) => {
      const r = await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null, firstName: first, lastName: 'Test', ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids[key] = r.body.employee.id;
    };
    await hire('owner', 'Omar', { membershipId: t.ownerMembershipId, hrWorkspaceId: null });
    await hire('hrA', 'Asha', { membershipId: hrA.membershipId, hrWorkspaceId: null });
    await hire('hrB', 'Bala', { membershipId: hrB.membershipId, hrWorkspaceId: null });
    await hire('eA1', 'Arun', { hrWorkspaceId: wsA });
    await hire('eA2', 'Esha', { membershipId: staff.membershipId, hrWorkspaceId: wsA });
    await hire('eB1', 'Bina', { hrWorkspaceId: wsB });
    await hire('c1', 'Cyra', { hrWorkspaceId: null });
    await setDays('owner', ['present', 'present', 'present', 'present', 'present']);
    await setDays('hrA', ['present', 'present', 'present', 'present', 'absent']);
    await setDays('hrB', ['present', 'present', 'present', 'present', 'present']);
    await setDays('eA1', ['present', 'present', 'half_day', 'on_leave', 'absent']);
    await setDays('eA2', ['present', 'present', 'present', 'present', 'missing_punch']);
    await setDays('eB1', ['present', 'present', 'present', 'absent', 'absent']);
    await setDays('c1', ['present', 'present', 'present', 'present', 'present']);
    tokens.hrA = (await login(app, hrA.email)).accessToken;
    tokens.hrB = (await login(app, hrB.email)).accessToken;
    tokens.eA2 = (await login(app, staff.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('counts the attendance percentage from the stored days, never a fixed number', () => {
    expect(attendanceTotals({ present: 2, half_day: 1, on_leave: 1, absent: 1 })).toMatchObject({ workingDays: 5, present: 2.5, absent: 1.5, leave: 1, percent: 50 });
    expect(attendanceTotals({ weekly_off: 2, holiday: 1 })).toMatchObject({ workingDays: 0, percent: null, weekends: 2, holidays: 1 });
    expect(attendanceTotals({ present: 1, half_day_leave: 1 })).toMatchObject({ present: 1.5, leave: 0.5, percent: 75 });
    expect(bucketOf('missing_punch')).toBe('absent');
    expect(bucketOf('in_progress')).toBe('present');
  });

  it('shows the Super Workspace everyone, every HR Workspace, and the right numbers', async () => {
    const o = await api(app, owner).get(`/attendance/overview?from=${FROM}&to=${TO}`);
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.capabilities).toMatchObject({ level: 'super', hrWorkspaces: true, employees: true, export: true, managePermissions: true });
    expect(o.body.cards).toMatchObject({ hrWorkspaces: 2, employees: 7 });
    expect(o.body.trend).toHaveLength(5);
    // Day 5: 3 of 7 present (owner, hrB, c1); hrA, eA1, eB1 absent, eA2 missing punch.
    expect(o.body.trend[4]).toMatchObject({ present: 3, absent: 4, percent: 42.9 });

    const all = await people(owner);
    expect(all.total).toBe(7);
    const arun = all.rows.find((r) => r.employeeId === ids.eA1)!;
    expect(arun.totals).toMatchObject({ workingDays: 5, present: 2.5, absent: 1.5, leave: 1, percent: 50 });
    expect(all.rows.find((r) => r.employeeId === ids.owner)!.level).toBe('super');
    expect(all.rows.find((r) => r.employeeId === ids.hrA)!.level).toBe('hr');

    const hr = await api(app, owner).get(`/attendance/overview/hr-workspaces?from=${FROM}&to=${TO}`);
    expect(hr.status, JSON.stringify(hr.body)).toBe(200);
    expect(hr.body.rows.map((r: { id: string }) => r.id)).toEqual(['central', wsB, wsA]);
    const pune = hr.body.rows.find((r: { id: string }) => r.id === wsA);
    // Pune: its HR Workspace admin (Asha, placed in the central group) and its two employees.
    expect(pune).toMatchObject({ name: 'Pune Branch', hrPeople: 1, employees: 2 });
    expect(pune.totals.workingDays).toBe(15);
    const detail = await api(app, owner).get(`/attendance/overview/hr-workspaces/${wsA}?from=${FROM}&to=${TO}`);
    expect(detail.status).toBe(200);
    expect(names(detail.body.people)).toEqual(['Arun Test', 'Asha Test', 'Esha Test']);
  });

  it('shows HR Workspace its own employees only: no Super Workspace, no other HR Workspace, by any route', async () => {
    const o = await api(app, tokens.hrA!).get(`/attendance/overview?from=${FROM}&to=${TO}`);
    expect(o.body.capabilities).toMatchObject({ level: 'hr', hrWorkspaces: false, employees: true, managePermissions: false });
    expect(names((await people(tokens.hrA!)).rows)).toEqual(['Arun Test', 'Asha Test', 'Esha Test']);
    expect((await api(app, tokens.hrA!).get(`/attendance/overview/hr-workspaces?from=${FROM}&to=${TO}`)).status).toBe(403);
    expect((await api(app, tokens.hrA!).get(`/attendance/overview/hr-workspaces/${wsB}?from=${FROM}&to=${TO}`)).status).toBe(404);
    // Changing ids in the URL or query does not help.
    for (const who of ['owner', 'eB1', 'hrB', 'c1']) {
      expect((await api(app, tokens.hrA!).get(`/attendance/days?employeeId=${ids[who]}&from=${FROM}&to=${TO}`)).status, who).toBe(404);
      expect((await api(app, tokens.hrA!).get(`/attendance/days/${ids[who]}/${FROM}`)).status, who).toBe(404);
      const rec = await api(app, tokens.hrA!).get(`/attendance/overview/records?from=${FROM}&to=${TO}&employeeId=${ids[who]}`);
      expect(rec.body.total, who).toBe(0);
    }
    expect((await people(tokens.hrA!, `&hrWorkspaceId=${wsB}`)).total).toBe(0);
    const reg = await api(app, tokens.hrA!).get(`/attendance/register?month=${FROM.slice(0, 7)}`);
    expect(reg.status).toBe(200);
    expect(reg.body.rows.map((r: { employeeId: string }) => r.employeeId)).not.toContain(ids.owner);
    expect(reg.body.rows.map((r: { employeeId: string }) => r.employeeId)).not.toContain(ids.eB1);
    // HR Workspace cannot change attendance permissions.
    expect((await api(app, tokens.hrA!).get('/attendance/access')).status).toBe(403);
    expect((await api(app, tokens.hrA!).put('/attendance/access/hr-workspace').send({ hrWorkspaceId: wsA, permissions: { 'attendance.view_other_hr': true }, otherHrWorkspaceIds: null })).status).toBe(403);
  });

  it('lets the Super Workspace allow one HR Workspace to see another, never the Super Workspace', async () => {
    const before = await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_access.updated' });
    const save = await api(app, owner).put('/attendance/access/hr-workspace').send({ hrWorkspaceId: wsA, permissions: { 'attendance.view_other_hr': true }, otherHrWorkspaceIds: [wsB] });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance_access.updated' })).toBe(before + 1);
    const s = await api(app, owner).get('/attendance/access');
    const row = s.body.hrWorkspaces.find((w: { id: string }) => w.id === wsA);
    expect(row.permissions.find((p: { key: string }) => p.key === 'attendance.view_other_hr').enabled).toBe(true);
    expect(row.otherHrWorkspaceIds).toEqual([wsB]);

    const o = await api(app, tokens.hrA!).get(`/attendance/overview?from=${FROM}&to=${TO}`);
    expect(o.body.capabilities.hrWorkspaces).toBe(true);
    expect(names((await people(tokens.hrA!)).rows)).toEqual(['Arun Test', 'Asha Test', 'Bala Test', 'Bina Test', 'Esha Test']);
    const hr = await api(app, tokens.hrA!).get(`/attendance/overview/hr-workspaces?from=${FROM}&to=${TO}`);
    expect(hr.body.rows.map((r: { id: string }) => r.id).sort()).toEqual([wsA, wsB].sort());
    expect((await api(app, tokens.hrA!).get(`/attendance/overview/hr-workspaces/central?from=${FROM}&to=${TO}`)).status).toBe(404);
    expect((await api(app, tokens.hrA!).get(`/attendance/days?employeeId=${ids.eB1}&from=${FROM}&to=${TO}`)).status).toBe(200);
    expect((await api(app, tokens.hrA!).get(`/attendance/days?employeeId=${ids.owner}&from=${FROM}&to=${TO}`)).status).toBe(404);
    // Delhi's HR Workspace was not given the same: it still sees only its own.
    expect(names((await people(tokens.hrB!)).rows)).toEqual(['Bala Test', 'Bina Test']);

    // All HR Workspaces (the central group included): still never the Super Workspace.
    await api(app, owner).put('/attendance/access/hr-workspace').send({ hrWorkspaceId: wsA, permissions: { 'attendance.view_other_hr': true }, otherHrWorkspaceIds: null }).expect(200);
    const wide = await people(tokens.hrA!);
    expect(wide.rows.map((r) => r.employeeId)).toContain(ids.c1);
    expect(wide.rows.map((r) => r.employeeId)).not.toContain(ids.owner);

    // Switched off again: back to its own.
    await api(app, owner).put('/attendance/access/hr-workspace').send({ hrWorkspaceId: wsA, permissions: { 'attendance.view_other_hr': false }, otherHrWorkspaceIds: null }).expect(200);
    expect(names((await people(tokens.hrA!)).rows)).toEqual(['Arun Test', 'Asha Test', 'Esha Test']);
    // Unknown and fixed permissions are refused.
    expect((await api(app, owner).put('/attendance/access/hr-workspace').send({ hrWorkspaceId: wsA, permissions: { 'attendance.view_own': false }, otherHrWorkspaceIds: null })).status).toBe(422);
  });

  it('shows Employee Workspace only its own attendance, whatever it asks for', async () => {
    const o = await api(app, tokens.eA2!).get(`/attendance/overview?from=${FROM}&to=${TO}`);
    expect(o.status).toBe(200);
    expect(o.body.capabilities).toMatchObject({ level: 'employee', hrWorkspaces: false, employees: false });
    expect(o.body.cards).toBeNull();
    expect((await api(app, tokens.eA2!).get(`/attendance/overview/people?from=${FROM}&to=${TO}`)).status).toBe(403);
    expect((await api(app, tokens.eA2!).get(`/attendance/overview/hr-workspaces?from=${FROM}&to=${TO}`)).status).toBe(403);
    const mine = await api(app, tokens.eA2!).get(`/attendance/overview/records?from=${FROM}&to=${TO}&employeeId=${ids.eA1}`);
    expect(mine.body.total).toBe(5);
    expect(new Set(mine.body.rows.map((r: { employeeId: string }) => r.employeeId))).toEqual(new Set([ids.eA2]));
    expect((await api(app, tokens.eA2!).get(`/attendance/days?employeeId=${ids.eA1}&from=${FROM}&to=${TO}`)).status).toBe(404);
    const own = await api(app, tokens.eA2!).get(`/attendance/days?from=${FROM}&to=${TO}`);
    expect(own.body.summary).toMatchObject({ workingDays: 5, attendancePercent: 80 });
    const team = await api(app, tokens.eA2!).get(`/attendance/team?date=${FROM}`);
    expect(team.body.rows.map((r: { employeeId: string }) => r.employeeId)).toEqual([ids.eA2]);
  });

  it('exports to Excel exactly what the dashboard shows, only for what the person may see', async () => {
    const r = await xlsx(owner, `&hrWorkspaceId=${wsA}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toContain('attendance-pune-branch');
    const employees = readXlsx(r.body, 1000, 1);
    expect(employees[0]).toEqual(expect.arrayContaining(['Workspace Name', 'Workspace Type', 'Employee Name', 'Employee ID', 'Attendance %']));
    const screen = await people(owner, `&hrWorkspaceId=${wsA}`);
    const col = (h: string) => employees[0]!.indexOf(h);
    expect(employees.slice(1).map((x) => x[col('Employee Name')]).sort()).toEqual(names(screen.rows));
    for (const row of screen.rows) {
      const line = employees.find((x) => x[col('Employee Name')] === row.name)!;
      expect(Number(line[col('Attendance %')])).toBe(row.totals.percent);
      expect(Number(line[col('Present')])).toBe(row.totals.present);
    }
    const dates = readXlsx(r.body, 1000, 2);
    expect(dates[0]).toEqual(expect.arrayContaining(['Date', 'Day', 'Attendance Status', 'Check-in Time', 'Check-out Time', 'Working Hours']));
    expect(dates).toHaveLength(1 + 15);
    const hrSheet = readXlsx(r.body, 1000, 3);
    expect(hrSheet[1]![0]).toBe('Pune Branch');
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance.exported' })).toBeGreaterThan(0);

    // HR Workspace: its own people only; no HR Workspaces sheet.
    const hr = await xlsx(tokens.hrA!);
    expect(hr.status).toBe(200);
    const hrRows = readXlsx(hr.body, 1000, 1);
    expect(hrRows.slice(1).map((x) => x[2]).sort()).toEqual(['Arun Test', 'Asha Test', 'Esha Test']);
    expect(() => readXlsx(hr.body, 1000, 3)).toThrow();

    // Employee Workspace: only their own, even when asking for someone else.
    const emp = await xlsx(tokens.eA2!, `&employeeId=${ids.eA1}`);
    expect(emp.status).toBe(200);
    const empRows = readXlsx(emp.body, 1000, 1);
    expect(empRows.slice(1).map((x) => x[2])).toEqual(['Esha Test']);

    // Export switched off by the Super Workspace.
    await api(app, owner).put('/attendance/access/hr-workspace').send({ hrWorkspaceId: wsA, permissions: { 'attendance.export': false }, otherHrWorkspaceIds: null }).expect(200);
    expect((await xlsx(tokens.hrA!)).status).toBe(403);
    expect((await api(app, tokens.hrA!).get(`/attendance/overview?from=${FROM}&to=${TO}`)).body.capabilities.export).toBe(false);
    await api(app, owner).put('/attendance/access/employee-workspace').send({ permissions: { 'attendance.export_own': false } }).expect(200);
    expect((await xlsx(tokens.eA2!)).status).toBe(403);
  });

  it('keeps every level in step when a day changes (one source of truth)', async () => {
    await setDays('eA1', ['present', 'present', 'present', 'present', 'present']);
    const superRow = (await people(owner)).rows.find((r) => r.employeeId === ids.eA1)!;
    const hrRow = (await people(tokens.hrA!)).rows.find((r) => r.employeeId === ids.eA1)!;
    expect(superRow.totals.percent).toBe(100);
    expect(hrRow.totals).toEqual(superRow.totals);
    const status = await people(owner, '&status=absent');
    expect(status.rows.map((r) => r.employeeId)).not.toContain(ids.eA1);
    expect(status.rows.map((r) => r.employeeId)).toContain(ids.eB1);
  });
});
