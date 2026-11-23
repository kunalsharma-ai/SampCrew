import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { NotificationService } from '../src/platform/notify/notification.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Each level's Home reads only what that level may see: an employee their own day, an HR Workspace person the people
 * of their HR Workspace, the Super Workspace the whole company, the Console counts across customers. Changing a query
 * parameter never widens it.
 */
describe('Role-based home dashboards', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let owner: string;
  let consoleToken: string;
  let hrToken: string;
  let staffToken: string;
  let staffEmployee: string;
  let centralEmployee: string;
  let wsId: string;
  let otherWs: string;
  let staffMembership: string;

  const hire = (token: string, body: Record<string, unknown>) =>
    api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2026-01-05', probationMonths: 0, onboardingTemplateId: null, ...body });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business', standardLeaveTypes: true });
    other = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hr = await addMember(pool, t, { name: 'Hari HR' });
    const staff = await addMember(pool, t, { name: 'Sita Staff' });
    staffMembership = staff.membershipId;
    const a = await hire(owner, { firstName: 'Sita', lastName: 'Staff', membershipId: staff.membershipId });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    staffEmployee = a.body.employee.id;
    const b = await hire(owner, { firstName: 'Chandra', lastName: 'Central' });
    centralEmployee = b.body.employee.id;
    const ws = await api(app, owner).post('/hr-workspaces').send({ name: 'Pune Branch', kind: 'branch', features: ['leave', 'attendance_basic', 'learning', 'announcements', 'helpdesk'], adminMembershipIds: [hr.membershipId] });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    wsId = ws.body.id;
    otherWs = (await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi Branch', kind: 'branch', features: ['leave'] })).body.id;
    const move = await api(app, owner).post('/hr-workspaces/transfers').send({ employeeId: staffEmployee, toHrWorkspaceId: wsId, reason: 'Joins Pune' });
    expect(move.status, JSON.stringify(move.body)).toBe(201);
    hrToken = (await login(app, hr.email)).accessToken;
    staffToken = (await login(app, staff.email)).accessToken;
    const email = `home.${Date.now()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Home', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
  });
  /** The work day the staff member's check-in was counted on. */
  const punchDay = async () => (await pool.find('attendance_days', { employee_id: staffEmployee })).find((d) => d.first_in)?.work_date as string | undefined;

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('gives an employee their own month, and their check-in shows at once', async () => {
    const before = await api(app, staffToken).get('/home/employee');
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const month = before.body.month as string;
    const [y, m] = month.split('-').map(Number) as [number, number];
    expect(before.body.attendance.days).toHaveLength(new Date(Date.UTC(y, m, 0)).getUTCDate());
    expect(before.body.attendance.days.every((d: { date: string }) => d.date.startsWith(month))).toBe(true);
    const punch = await api(app, staffToken).post('/attendance/punch').send({ clientEventId: `home-${Date.now()}` });
    expect(punch.status, JSON.stringify(punch.body)).toBe(201);
    const after = await api(app, staffToken).get('/home/employee');
    expect(after.body.activity[0]).toMatchObject({ kind: 'punch.in', title: 'Checked in' });
    // Just after midnight a check-in still belongs to the previous work day (attendance.spec.ts), so look at that day.
    const workDay = await punchDay();
    const day = after.body.attendance.days.find((d: { date: string }) => d.date === workDay);
    if (day && day.dayType === 'working') expect(day.firstIn).not.toBeNull();
    // Another month by parameter, still only their own.
    const prev = await api(app, staffToken).get('/home/employee?month=2026-01');
    expect(prev.status).toBe(200);
    expect(prev.body.attendance.days[0].date).toBe('2026-01-01');
    expect((await api(app, staffToken).get('/home/employee?month=2026-13')).status).toBe(422);
  });

  it('lists learning and new courses as actions for the employee, with the Learning category', async () => {
    const course = await api(app, owner).post('/learning/courses').send({ title: 'Workplace Safety', format: 'online', selfEnrol: false });
    expect(course.status, JSON.stringify(course.body)).toBe(201);
    const assign = await api(app, owner).post('/learning/assignments').send({ courseId: course.body.id, employeeIds: [staffEmployee], dueOn: '2099-12-31' });
    expect(assign.status, JSON.stringify(assign.body)).toBe(201);
    const home = await api(app, staffToken).get('/home/employee');
    expect(home.body.learning).toMatchObject({ assigned: 1, completed: 0, completion: 0 });
    expect(home.body.learning.items[0]).toMatchObject({ title: 'Workplace Safety', dueOn: '2099-12-31' });
    expect(home.body.actions.map((a: { key: string }) => a.key)).toContain('learning-new');
    const notes = await api(app, staffToken).get('/notifications?category=learning');
    expect(notes.body.items[0]).toMatchObject({ kind: 'learning.assigned', category: 'learning' });
    const summary = await api(app, staffToken).get('/notifications/summary');
    expect(summary.body.categories.find((c: { category: string }) => c.category === 'learning').unread).toBe(1);
  });

  it('refuses the HR and Super Workspace homes to an employee', async () => {
    expect((await api(app, staffToken).get('/home/workforce')).status).toBe(403);
    expect((await api(app, staffToken).get('/home/workforce/trend')).status).toBe(403);
    expect((await api(app, staffToken).get('/home/organization')).status).toBe(403);
  });

  it('shows an HR Workspace person only the people of their HR Workspace, whatever the parameters say', async () => {
    const r = await api(app, hrToken).get('/home/workforce');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.scope).toMatchObject({ label: 'Pune Branch', employees: 1 });
    expect(r.body.filters.hrWorkspaces).toEqual([{ id: wsId, name: 'Pune Branch' }]);
    expect(JSON.stringify(r.body)).not.toContain('Chandra');
    // Asking for the central group or another HR Workspace is refused, not widened.
    expect((await api(app, hrToken).get('/home/workforce?hrWorkspaceId=central')).status).toBe(404);
    expect((await api(app, hrToken).get(`/home/workforce?hrWorkspaceId=${otherWs}`)).status).toBe(404);
    expect((await api(app, hrToken).get('/home/organization')).status).toBe(403);
    // Today's workforce counts the employee who checked in as working now; the card opens the same filter.
    if (r.body.today && r.body.today.expected > 0 && (await punchDay()) === r.body.date) {
      expect(r.body.today.workingNow + r.body.today.present).toBeGreaterThan(0);
      const team = await api(app, hrToken).get(`/attendance/team?date=${r.body.date}&filter=working_now`);
      expect(team.status).toBe(200);
      expect(team.body.rows.map((x: { employeeId: string }) => x.employeeId)).toEqual([staffEmployee]);
    }
    const trend = await api(app, hrToken).get('/home/workforce/trend?days=7');
    expect(trend.status).toBe(200);
    expect(trend.body.days).toHaveLength(7);
    expect((await api(app, hrToken).get('/home/workforce/trend?days=9')).status).toBe(422);
  });

  it('gives the Super Workspace every HR Workspace and the central group, and lets it narrow to one', async () => {
    const o = await api(app, owner).get('/home/organization');
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.overview).toMatchObject({ hrWorkspaces: 2, employees: 2, employeeWorkspaces: 1, hrUsers: 1 });
    const pune = o.body.workspaces.find((w: { id: string }) => w.id === wsId);
    expect(pune).toMatchObject({ name: 'Pune Branch', employees: 1, hrUsers: 1 });
    expect(o.body.workspaces.find((w: { id: string }) => w.id === 'central')).toMatchObject({ employees: 1 });
    // Delhi has no HR user: an alert says so and opens the HR Workspace.
    expect(o.body.alerts.find((a: { key: string }) => a.key === `nohr:${otherWs}`)).toBeUndefined(); // no employees there yet
    const whole = await api(app, owner).get('/home/workforce');
    expect(whole.body.scope).toMatchObject({ label: 'Whole company', employees: 2 });
    const one = await api(app, owner).get(`/home/workforce?hrWorkspaceId=${wsId}`);
    expect(one.body.scope).toMatchObject({ label: 'Pune Branch', employees: 1 });
    const central = await api(app, owner).get('/home/workforce?hrWorkspaceId=central');
    expect(central.body.scope.employees).toBe(1);
    expect(central.body.people.newJoiners.map((p: { id: string }) => p.id)).toEqual([]);
    expect(JSON.stringify(central.body)).not.toContain('Sita');
    void centralEmployee;
  });

  it('never shows one company another company’s data', async () => {
    const outsider = await addMember(pool, other, { roles: ['owner'], name: 'Other Owner' });
    const token = (await loginWithMfa(app, pool, outsider.email)).accessToken;
    expect([403, 404]).toContain((await api(app, token).get(`/home/workforce?hrWorkspaceId=${wsId}`)).status);
    const o = await api(app, token).get('/home/organization');
    if (o.status === 200) {
      expect(o.body.workspaces.map((w: { id: string }) => w.id)).not.toContain(wsId);
      expect(o.body.overview.employees).toBe(0);
    }
  });

  it('gives the Console platform counts and alerts without employee records', async () => {
    const r = await api(app, consoleToken).get('/platform/home');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.overview.superWorkspaces).toBeGreaterThanOrEqual(2);
    expect(r.body.overview.hrWorkspaces).toBeGreaterThanOrEqual(2);
    expect(r.body.overview.employeeWorkspaces).toBeGreaterThanOrEqual(1);
    expect(r.body.signups).toHaveLength(30);
    expect(r.body.alerts.find((a: { key: string }) => a.key === 'new-workspaces')).toBeTruthy();
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('Sita');
    expect(text).not.toContain('Chandra');
    // A workspace user cannot call it.
    expect((await api(app, owner).get('/platform/home')).status).toBeGreaterThanOrEqual(401);
  });

  it('rings the Console bell for new system alerts until the admin has seen them', async () => {
    const first = await api(app, consoleToken).get('/platform/alerts');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.unseen).toBeGreaterThan(0);
    expect(first.body.items.every((a: { seen: boolean }) => !a.seen)).toBe(true);
    const seen = await api(app, consoleToken).post('/platform/alerts/seen');
    expect(seen.status).toBeLessThan(300);
    const after = await api(app, consoleToken).get('/platform/alerts');
    expect(after.body.unseen).toBe(0);
    // A new workspace changes the count, so the alert is new again.
    await createTenant(pool, { plan: 'business' });
    const again = await api(app, consoleToken).get('/platform/alerts');
    expect(again.body.items.find((a: { key: string; seen: boolean }) => a.key === 'new-workspaces')?.seen).toBe(false);
    expect((await api(app, owner).get('/platform/alerts')).status).toBeGreaterThanOrEqual(401);
  });

  it('keeps desktop alerts and quiet hours in the notification preferences', async () => {
    const before = await api(app, staffToken).get('/notifications/preferences');
    expect(before.body).toMatchObject({ desktop: false, quiet: { enabled: false, from: '20:00', to: '08:00' } });
    const put = await api(app, staffToken).put('/notifications/preferences').send({ ...before.body, desktop: true, quiet: { enabled: true, from: '22:00', to: '07:30' } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = await api(app, staffToken).get('/notifications/preferences');
    expect(after.body).toMatchObject({ desktop: true, quiet: { enabled: true, from: '22:00', to: '07:30' } });
    expect((await api(app, staffToken).put('/notifications/preferences').send({ ...after.body, quiet: { enabled: true, from: '25:00', to: '07:00' } })).status).toBe(422);
    void staffMembership;
    void today;
  });

  it('holds phone pushes during quiet hours, except urgent ones', async () => {
    const prefs = (await api(app, staffToken).get('/notifications/preferences')).body;
    // Quiet all day except the last minute, whatever the time zone.
    expect((await api(app, staffToken).put('/notifications/preferences').send({ ...prefs, quiet: { enabled: true, from: '00:00', to: '23:59' } })).status).toBe(200);
    const device = await pool.tenant(t.id, (tx) => tx.collection('mobile_devices').insert({ membership_id: staffMembership, installation_id: 'install-quiet-0001', platform: 'android', app_version: '1.0.0', push_token: 'ExponentPushToken[quietquietquiet1]' }));
    const svc = app.get(NotificationService);
    await pool.tenant(t.id, (tx) => svc.notify(tx, { membershipIds: [staffMembership], kind: 'leave.approved', title: 'Quiet notice', priority: 'normal' }));
    await pool.tenant(t.id, (tx) => svc.notify(tx, { membershipIds: [staffMembership], kind: 'system.alert', title: 'Urgent notice', priority: 'urgent' }));
    const rows = await pool.platform((tx) => tx.collection('push_messages').find({ mobile_device_id: device.id }));
    const now = Date.now();
    const held = rows.filter((r) => (r.next_attempt_at as Date).getTime() > now + 60_000);
    expect(rows).toHaveLength(2);
    expect(held).toHaveLength(1);
    // Leave no pushes queued for other specs that send the whole queue.
    await pool.delete('push_messages', { mobile_device_id: device.id });
    await pool.delete('mobile_devices', { id: device.id });
    await api(app, staffToken).put('/notifications/preferences').send(prefs);
  });
});
