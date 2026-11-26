import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkModeService } from '../src/modules/attendance/work-mode.service';
import { readXlsx } from '../src/platform/export/tabular';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const IST = '+05:30';
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
/** The nth weekday (Mon-Fri) before today in India, counting back from three days ago. */
const pastWeekday = (n: number) => {
  let d = plus(istToday(), -3);
  let seen = 0;
  for (;;) {
    if (dow(d) !== 0 && dow(d) !== 6 && ++seen === n) return d;
    d = plus(d, -1);
  }
};
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const HOME = { latitude: 18.58, longitude: 73.8567 };

/**
 * Work From Office / Work From Home / hybrid attendance through the HTTP API: where each punch was, how a day is
 * classified, Pending Verification instead of a guess, HR verification with history, the Super Workspace and HR
 * Workspace dashboards and register, the 8-sheet report and the privacy of coordinates.
 */
describe('work-mode attendance', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let office: string;
  let wsA: string;
  const ids: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  const D1 = pastWeekday(1);
  const D2 = pastWeekday(2);
  const D3 = pastWeekday(3);

  /** A past web punch exactly as a live one stores it. */
  const punch = async (who: string, date: string, time: string, direction: 'in' | 'out', zone: 'office' | 'remote' | 'unverified', place: string | null = zone === 'office' ? 'Pune Office' : null) => {
    await pool.insert('attendance_events', {
      tenant_id: t.id, employee_id: ids[who], source: 'web', source_event_id: randomUUID(), captured_at: new Date(`${date}T${time}:00${IST}`), direction,
      work_zone: zone, location_verification: zone === 'unverified' ? 'denied' : 'verified', work_place_name: place, work_place_kind: place ? 'office' : null, work_place_id: place ? office : null,
    });
  };
  const day = async (who: string, date: string, token = owner) => {
    const r = await api(app, token).get(`/attendance/days?employeeId=${ids[who]}&from=${date}&to=${date}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.days[0] as { status: string; workMode: string | null; officeMinutes: number; remoteMinutes: number; workPlaces: string[]; workIssues: string[]; workModeCorrected: boolean };
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    office = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: t.legalEntityId, name: 'Pune Office', kind: 'office', timezone: 'Asia/Kolkata', country_code: 'IN' })).id as string;
    const hrA = await addMember(pool, t, { name: 'Asha HR' });
    const staff = await addMember(pool, t, { name: 'Esha Staff' });
    const r = await api(app, owner).post('/hr-workspaces').send({ kind: 'branch', features: ['leave', 'attendance_basic'], name: 'Pune Branch', code: 'PUNE', adminMembershipIds: [hrA.membershipId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    wsA = r.body.id;
    const hire = async (key: string, first: string, body: Record<string, unknown>) => {
      const res = await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null, firstName: first, lastName: 'Test', locationId: office, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids[key] = res.body.employee.id;
    };
    await hire('owner', 'Omar', { membershipId: t.ownerMembershipId, hrWorkspaceId: null });
    await hire('hrA', 'Asha', { membershipId: hrA.membershipId, hrWorkspaceId: null });
    await hire('staff', 'Esha', { membershipId: staff.membershipId, hrWorkspaceId: wsA });
    await hire('arun', 'Arun', { hrWorkspaceId: wsA });
    tokens.hrA = (await login(app, hrA.email)).accessToken;
    tokens.staff = (await login(app, staff.email)).accessToken;
    // Classify the past days these tests write (a new company classifies from the day it starts).
    await pool.tenant(t.id, async (tx) => {
      await app.get(WorkModeService).settings(tx);
      await tx.collection('work_mode_settings').updateOne({}, { $set: { classify_from: '2020-01-01' } });
    });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('the Super Workspace sets an office geofence and adds offices and approved sites; others cannot', async () => {
    const g = await api(app, owner).put(`/attendance/work-mode/offices/${office}`).send({ ...PUNE, radiusM: 200, addressLine: 'FC Road, Pune' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect((await api(app, tokens.staff!).put(`/attendance/work-mode/offices/${office}`).send({ ...PUNE, radiusM: 900 })).status).toBe(403);
    const added = await api(app, owner).post('/attendance/work-mode/offices').send({ name: 'Mumbai Office', legalEntityId: t.legalEntityId, city: 'Mumbai', latitude: 19.076, longitude: 72.8777, radiusM: 150 });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const site = await api(app, owner).post('/attendance/work-mode/sites').send({ name: 'Client HQ', kind: 'client_site', latitude: 18.6, longitude: 73.9, radiusM: 150, countsAs: 'office', everyone: true });
    expect(site.status, JSON.stringify(site.body)).toBe(201);
    const places = await api(app, owner).get('/attendance/work-mode/places');
    expect(places.status).toBe(200);
    expect(JSON.stringify(places.body)).toContain('Pune Office');
    expect(JSON.stringify(places.body)).toContain('Mumbai Office');
    expect(JSON.stringify(places.body)).toContain('Client HQ');
    expect(await pool.count('audit_events', { tenant_id: t.id, action: { $regex: '^work_mode\\.' } })).toBeGreaterThan(0);
  });

  it('only the Super Workspace renames office, home and hybrid attendance; the stored value stays', async () => {
    const base = (await api(app, owner).get('/attendance/work-mode/settings')).body;
    expect(base.canRename).toBe(true);
    const { updatedAt: _u, classifyFrom: _c, ...settings } = base.settings;
    const labels = { office: 'Office Attendance', remote: 'Remote Attendance', hybrid: 'Flexible Attendance' };
    const saved = await api(app, owner).put('/attendance/work-mode/settings').send({ ...settings, labels });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.labels).toEqual(labels);
    expect((await api(app, tokens.hrA!).put('/attendance/work-mode/settings').send({ ...settings, labels: { ...labels, office: 'At the desk' } })).status).toBe(403);
    expect((await api(app, tokens.staff!).get('/attendance/work-mode/labels')).body).toEqual(labels);
  });

  it('a check-in at the office is office; no location is Pending Verification, never home', async () => {
    const r = await api(app, tokens.staff!).post('/attendance/punch').send({ clientEventId: 'wm-test-0001', ...PUNE, accuracyM: 20 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const today = await api(app, tokens.staff!).get('/attendance/today');
    expect(today.body.workMode).toMatchObject({ enabled: true, state: 'office', provisional: true, current: { zone: 'office', place: 'Pune Office' } });
    // Coordinates are kept apart from the punch, for the retention period only.
    expect(await pool.count('attendance_locations', { tenant_id: t.id, employee_id: ids.staff })).toBe(1);
    const ev = await pool.one('attendance_events', { tenant_id: t.id, employee_id: ids.staff, source: 'web' }, { sort: { captured_at: 1 } });
    expect(ev).toMatchObject({ work_zone: 'office', work_place_name: 'Pune Office' });
    expect(ev?.latitude ?? null).toBeNull();
    // A location update from home during the day.
    const cp = await api(app, tokens.staff!).post('/attendance/work-mode/checkpoint').send({ ...HOME, accuracyM: 15 });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    expect(cp.body.zone).toMatchObject({ zone: 'remote' });
    // Out with location refused.
    const out = await api(app, tokens.staff!).post('/attendance/punch').send({ clientEventId: 'wm-test-0002', locationStatus: 'denied' });
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const after = await api(app, tokens.staff!).get('/attendance/today');
    expect(after.body.workMode.current).toMatchObject({ zone: 'unverified' });
    expect(after.body.workMode.state).not.toBe('remote');
  });

  it('in at the office and out from home is hybrid, split by the rule; an unverified end waits for HR', async () => {
    await punch('staff', D1, '09:00', 'in', 'office');
    await punch('staff', D1, '18:00', 'out', 'remote');
    await punch('arun', D1, '09:00', 'in', 'remote');
    await punch('arun', D1, '18:00', 'out', 'remote');
    await punch('arun', D2, '09:00', 'in', 'office');
    await punch('arun', D2, '18:00', 'out', 'unverified');
    await punch('hrA', D1, '09:30', 'in', 'office');
    await punch('hrA', D1, '18:30', 'out', 'office');
    expect(await day('staff', D1)).toMatchObject({ workMode: 'hybrid', officeMinutes: 270, remoteMinutes: 270 });
    expect(await day('arun', D1)).toMatchObject({ workMode: 'remote', officeMinutes: 0, remoteMinutes: 540 });
    expect(await day('arun', D2)).toMatchObject({ workMode: 'pending_verification' });
    expect(await day('hrA', D1)).toMatchObject({ workMode: 'office', officeMinutes: 540, workPlaces: ['Pune Office'] });
  });

  it('HR verifies a pending day with a reason; the change is in the day history and audit, never on its own day', async () => {
    expect((await api(app, tokens.hrA!).post('/attendance/work-mode/override').send({ employeeId: ids.arun, workDate: D2, mode: 'office', reason: "x" })).status).toBe(422);
    const r = await api(app, tokens.hrA!).post('/attendance/work-mode/override').send({ employeeId: ids.arun, workDate: D2, mode: 'office', reason: 'Badge log shows office all day' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ state: 'office', auto: 'pending_verification' });
    expect(await day('arun', D2)).toMatchObject({ workMode: 'office', workModeCorrected: true });
    const detail = await api(app, tokens.hrA!).get(`/attendance/work-mode/days/${ids.arun}/${D2}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.changes[0]).toMatchObject({ from: 'pending_verification', to: 'office', by: 'hr', reason: 'Badge log shows office all day' });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'work_mode.corrected' })).toBe(1);
    // A recompute keeps HR's decision.
    await punch('arun', D2, '18:05', 'out', 'unverified');
    expect((await day('arun', D2)).workMode).toBe('office');
    expect((await api(app, tokens.hrA!).post('/attendance/work-mode/override').send({ employeeId: ids.hrA, workDate: D1, mode: 'remote', reason: 'Trying my own day' })).status).toBe(403);
    expect((await api(app, tokens.staff!).post('/attendance/work-mode/override').send({ employeeId: ids.arun, workDate: D2, mode: 'remote', reason: 'Not allowed' })).status).toBe(403);
  });

  it('an employee asks for a classification correction; rejecting it needs a reason, approving it changes the day', async () => {
    await punch('staff', D3, '09:00', 'in', 'unverified');
    await punch('staff', D3, '18:00', 'out', 'unverified');
    expect((await day('staff', D3, tokens.staff)).workMode).toBe('pending_verification');
    const c = await api(app, tokens.staff!).post('/attendance/corrections').send({ workDate: D3, category: 'location_issue', workMode: 'remote', reason: 'Location was off on my laptop; I worked from home' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const inbox = async (tk: string) => ((await api(app, tk).get('/approvals/inbox')).body as { id: string; resourceType: string }[]).filter((i) => i.resourceType === 'attendance_correction');
    const approver = (await inbox(tokens.hrA!)).length ? tokens.hrA! : owner;
    const [item] = await inbox(approver);
    expect(item).toBeTruthy();
    const rej = await api(app, approver).post(`/approvals/${item!.id}/reject`).send({});
    expect(rej.status).toBe(400);
    expect((await api(app, approver).post(`/approvals/${item!.id}/approve`).send({})).status).toBe(200);
    expect(await day('staff', D3, tokens.staff)).toMatchObject({ workMode: 'remote', workModeCorrected: true });
    const detail = await api(app, tokens.staff!).get(`/attendance/work-mode/days/${ids.staff}/${D3}`);
    expect(detail.body.changes[0]).toMatchObject({ to: 'remote', by: 'correction' });
    expect(detail.body.canVerify).toBe(false);
  });

  it('dashboards count the whole organisation; lists show only who the viewer may see; Employee Workspace has none', async () => {
    const o = await api(app, owner).get(`/attendance/work-mode/dashboard?date=${D1}`);
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body).toMatchObject({ orgWide: true, visiblePeople: 4 });
    expect(o.body.cards).toMatchObject({ total: 4, office: 1, remote: 1, hybrid: 1 });
    expect(o.body.labels.hybrid).toBe('Flexible Attendance');
    const hybrid = await api(app, owner).get(`/attendance/work-mode/people?date=${D1}&category=hybrid`);
    expect(hybrid.status, JSON.stringify(hybrid.body)).toBe(200);
    expect(hybrid.body.rows.map((r: { name: string }) => r.name)).toEqual(['Esha Test']);

    const h = await api(app, tokens.hrA!).get(`/attendance/work-mode/dashboard?date=${D1}`);
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    // Totals include the Super Workspace; the lists do not.
    expect(h.body.cards.total).toBe(4);
    const all = await api(app, tokens.hrA!).get(`/attendance/work-mode/people?date=${D1}&category=all&pageSize=50`);
    expect(all.body.rows.map((r: { name: string }) => r.name)).not.toContain('Omar Test');

    expect((await api(app, tokens.staff!).get(`/attendance/work-mode/dashboard?date=${D1}`)).status).toBe(403);
    expect((await api(app, tokens.staff!).get(`/attendance/work-mode/people?date=${D1}`)).status).toBe(403);

    const reg = await api(app, owner).get(`/attendance/work-mode/register?from=${D3}&to=${D1}&modes=hybrid,remote`);
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    expect(reg.body.rows.every((r: { mode: string }) => ['hybrid', 'remote'].includes(r.mode))).toBe(true);
    expect(reg.body.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('exports every matching record to an 8-sheet workbook and CSV, audited, without coordinates for HR', async () => {
    const r = (await api(app, owner).get(`/attendance/work-mode/report?from=${D3}&to=${D1}&section=dashboard`).buffer(true).parse(binary as never)) as unknown as { status: number; body: Buffer; headers: Record<string, string> };
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attendance-report-.*\.xlsx/);
    const summary = readXlsx(r.body, 100, 0);
    expect(summary[0]?.[0]).toBeTruthy();
    expect(summary.flat().join(' ')).toMatch(/Attendance Summary|Summary/);
    const register = readXlsx(r.body, 1000, 1);
    const text = register.flat().join(' ');
    expect(text).toContain('Esha Test');
    expect(text).toContain('Flexible Attendance');
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance.report_exported' })).toBe(1);

    const csv = await api(app, tokens.hrA!).get(`/attendance/work-mode/report?from=${D3}&to=${D1}&format=csv&scope=selected&employeeIds=${ids.arun}`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Arun Test');
    expect(csv.text).not.toContain('Esha Test');
    expect(csv.text).not.toContain('Omar Test');
    expect((await api(app, tokens.hrA!).get(`/attendance/work-mode/report?from=${D3}&to=${D1}&scope=selected`)).status).toBe(400);

    const own = await api(app, tokens.staff!).get(`/attendance/work-mode/report?from=${D3}&to=${D1}&format=csv`);
    expect(own.status).toBe(200);
    expect(own.text).toContain('Esha Test');
    expect(own.text).not.toContain('Arun Test');

    const saved = await api(app, owner).post('/attendance/work-mode/saved-reports').send({ name: 'Hybrid last week', filters: { modes: ['hybrid'], from: D3, to: D1 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const list = await api(app, owner).get('/attendance/work-mode/saved-reports');
    expect(list.body.map((x: { name: string }) => x.name)).toEqual(['Hybrid last week']);
    expect((await api(app, tokens.hrA!).get('/attendance/work-mode/saved-reports')).body).toEqual([]);
  });

  it('each person chooses their attendance notices', async () => {
    const v = await api(app, tokens.staff!).get('/attendance/work-mode/notices');
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    const saved = await api(app, tokens.staff!).put('/attendance/work-mode/notices').send({ check_in: false, mode_changed: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(JSON.stringify((await api(app, tokens.staff!).get('/attendance/work-mode/notices')).body)).toMatch(/"check_in"[^}]*false|false[^}]*"check_in"/);
    expect((await api(app, tokens.staff!).put('/attendance/work-mode/notices').send({ nonsense: true })).status).toBe(422);
  });

  it('coordinates are removed after the retention period; the office or home result stays', async () => {
    const before = await pool.count('attendance_locations', { tenant_id: t.id, latitude: { $ne: null } });
    expect(before).toBeGreaterThan(0);
    const res = await app.get(WorkModeService).runJobs(t.id, Date.now() + 200 * 86_400_000);
    expect(res.purged).toBe(before);
    expect(await pool.count('attendance_locations', { tenant_id: t.id, latitude: { $ne: null } })).toBe(0);
    expect((await day('staff', D1)).workMode).toBe('hybrid');
  });
});
