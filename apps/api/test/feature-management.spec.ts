import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);
type Cell = { on: boolean; indicator: string; restrictedBy?: string; setBy?: string; editable: boolean };
type LevelRow = { key: string; company: Cell; hr: Cell; employee: Cell };
type EmployeeRow = { key: string; cell: Cell };

/**
 * Feature management top down: the Console for the whole application, the Super Workspace for the company and for the
 * HR Workspace and Employee Workspace levels, HR Workspace for Employee Workspace. A lower level never switches on what
 * a higher one switched off, the API refuses what is off, and every change is audited.
 */
describe('Feature management by level', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let consoleToken: string;
  let hr: { email: string; membershipId: string };
  let hrToken: string;
  let staff: { email: string; membershipId: string };
  let staffToken: string;
  let deskAdmin: { email: string; membershipId: string };
  let deskToken: string;
  let deskStaff: { email: string; membershipId: string };
  let deskStaffToken: string;
  let desk: string;

  const features = async (token: string) => (await api(app, token).get('/me')).body.features as string[];
  const matrix = async () => (await api(app, owner).get('/hr-admin/features')).body.items as LevelRow[];
  const row = async (key: string) => (await matrix()).find((r) => r.key === key)!;
  const setLevel = (key: string, target: 'company' | 'hr' | 'employee', enabled: boolean) => api(app, owner).put('/hr-admin/features').send({ changes: [{ key, target, enabled }] });
  const platform = (key: string, state: 'active' | 'off') => api(app, consoleToken).put('/platform/features').send({ changes: [{ key, state }] });
  const hire = (body: Record<string, unknown>) =>
    api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: today(), probationMonths: 0, onboardingTemplateId: null, ...body });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hr = await addMember(pool, t, { name: 'Hari HR' });
    staff = await addMember(pool, t, { name: 'Sam Staff' });
    deskAdmin = await addMember(pool, t, { name: 'Dina Desk' });
    deskStaff = await addMember(pool, t, { name: 'Deb Desk' });
    expect((await api(app, owner).put(`/members/${hr.membershipId}/access`).send({ level: 'hr' })).status).toBe(200);
    for (const [first, m] of [['Sam', staff], ['Dina', deskAdmin], ['Deb', deskStaff]] as const) {
      const r = await hire({ firstName: first, lastName: 'Person', membershipId: m.membershipId });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const ws = await api(app, owner).post('/hr-workspaces').send({ name: 'Field Desk', features: ['leave', 'attendance_basic'], adminMembershipIds: [deskAdmin.membershipId] });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    desk = ws.body.id;
    const deb = (await pool.one('employees', { membership_id: deskStaff.membershipId }))!;
    expect((await api(app, owner).post(`/hr-workspaces/${desk}/members`).send({ employeeIds: [deb.id], reason: 'Field team' })).status).toBeLessThan(300);
    hrToken = (await loginWithMfa(app, pool, hr.email)).accessToken;
    deskToken = (await loginWithMfa(app, pool, deskAdmin.email)).accessToken;
    staffToken = (await login(app, staff.email)).accessToken;
    deskStaffToken = (await login(app, deskStaff.email)).accessToken;
    const email = `features.${Date.now()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Features', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
  });
  afterAll(async () => {
    // Global switches are shared by every company: put them back.
    await api(app, consoleToken).put('/platform/features').send({ changes: ['staffing_bids.rate_cards', 'staffing_bids.templates'].map((key) => ({ key, state: 'active' })) });
    await app.close();
    await pool.end();
  });

  it('lists every module with its pages, and pages come with their module in /me', async () => {
    const list = await api(app, consoleToken).get('/platform/features');
    expect(list.status).toBe(200);
    const keys = (list.body.items as { key: string; parent: string | null }[]).map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['leave', 'leave.settings', 'payroll.payslips', 'core_hr.privacy']));
    expect(list.body.items.find((i: { key: string }) => i.key === 'leave.settings').parent).toBe('leave');
    const f = await features(staffToken);
    expect(f).toEqual(expect.arrayContaining(['leave', 'leave.requests', 'leave.settings', 'staffing_bids.rate_cards']));
  });

  it('the Console switches a page off for the whole application: every level loses it and Super Workspace cannot switch it on', async () => {
    expect((await platform('staffing_bids.rate_cards', 'off')).status).toBe(200);
    for (const token of [owner, hrToken, staffToken]) expect(await features(token)).not.toContain('staffing_bids.rate_cards');
    expect(await features(owner)).toContain('staffing_bids.bids');
    expect((await row('staffing_bids.rate_cards')).company).toMatchObject({ on: false, indicator: 'restricted', restrictedBy: 'console', editable: false });
    const tryOn = await setLevel('staffing_bids.rate_cards', 'company', true);
    expect(tryOn.status).toBe(403);
    expect(tryOn.body.error.code).toBe('feature_restricted');
    expect((await platform('staffing_bids.rate_cards', 'active')).status).toBe(200);
    expect(await features(owner)).toContain('staffing_bids.rate_cards');
    expect(await pool.count('audit_events', { tenant_id: null, action: 'platform.features_switched' })).toBeGreaterThanOrEqual(2);
  });

  it('a feature added later stays pending, and off for everyone, until the Console activates it', async () => {
    await pool.platform((tx) => tx.collection('platform_feature_states').upsert({ key: 'staffing_bids.templates' }, { key: 'staffing_bids.templates', state: 'pending' }, { $set: { state: 'pending' } }));
    const list = await api(app, consoleToken).get('/platform/features');
    expect(list.body.items.find((i: { key: string }) => i.key === 'staffing_bids.templates').state).toBe('pending');
    expect(list.body.counts.pending).toBeGreaterThanOrEqual(1);
    expect(await features(owner)).not.toContain('staffing_bids.templates');
    expect((await platform('staffing_bids.templates', 'active')).status).toBe(200);
    expect(await features(owner)).toContain('staffing_bids.templates');
  });

  it('Super Workspace switches a module off for the HR Workspace level only: HR loses it, employees and Super keep it', async () => {
    expect((await setLevel('leave', 'hr', false)).status).toBe(200);
    expect(await features(hrToken)).not.toContain('leave');
    expect(await features(hrToken)).not.toContain('leave.requests');
    expect(await features(staffToken)).toContain('leave');
    expect(await features(owner)).toContain('leave');
    const r = await api(app, hrToken).get('/leave/types');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('feature_off_for_level');
    expect((await row('leave')).hr).toMatchObject({ on: false, indicator: 'inactive', setBy: 'super' });
    expect((await row('leave.settings')).hr).toMatchObject({ indicator: 'restricted', editable: false });
    expect((await setLevel('leave', 'hr', true)).status).toBe(200);
    expect(await features(hrToken)).toContain('leave');
  });

  it('Super Workspace switches one page off for the Employee Workspace level; the API route of that page closes too', async () => {
    expect((await setLevel('core_hr.privacy', 'company', false)).status).toBe(200);
    const closed = await api(app, owner).get('/privacy/requests');
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('feature_switched_off');
    expect((await row('core_hr.privacy')).hr).toMatchObject({ indicator: 'restricted', restrictedBy: 'company' });
    expect((await setLevel('core_hr.privacy', 'company', true)).status).toBe(200);
    expect((await api(app, owner).get('/privacy/requests')).status).toBe(200);
  });

  it('company-wide HR switches a feature off for Employee Workspace in the central group, within what Super allows', async () => {
    const g = await api(app, hrToken).get('/hr-workspaces/employee-features');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.scopes.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['central', desk]));
    expect((await api(app, hrToken).put('/hr-workspaces/employee-features').send({ scope: 'central', changes: [{ key: 'leave', enabled: false }] })).status).toBe(200);
    expect(await features(staffToken)).not.toContain('leave');
    expect(await features(hrToken)).toContain('leave');
    expect(await features(deskStaffToken)).toContain('leave'); // the HR Workspace's people follow their own HR Workspace
    expect((await api(app, staffToken).get('/leave/types')).body.error.code).toBe('feature_off_for_employees');
    expect((await row('leave')).employee).toMatchObject({ on: false, indicator: 'inactive', setBy: 'hr', editable: true });
    // Super Workspace can lift HR's switch: it decides over HR Workspace.
    expect((await setLevel('leave', 'employee', true)).status).toBe(200);
    expect(await features(staffToken)).toContain('leave');
  });

  it('a switch Super Workspace makes for Employee Workspace is locked for HR Workspace', async () => {
    expect((await setLevel('announcements', 'employee', false)).status).toBe(200);
    expect(await features(staffToken)).not.toContain('announcements');
    expect(await features(hrToken)).toContain('announcements');
    const rows = (await api(app, hrToken).get('/hr-workspaces/employee-features?scope=central')).body.items as EmployeeRow[];
    expect(rows.find((r) => r.key === 'announcements')!.cell).toMatchObject({ on: false, indicator: 'restricted', restrictedBy: 'super', editable: false });
    const tryOn = await api(app, hrToken).put('/hr-workspaces/employee-features').send({ scope: 'central', changes: [{ key: 'announcements', enabled: true }] });
    expect(tryOn.status).toBe(403);
    expect(tryOn.body.error.code).toBe('feature_restricted');
    expect(await features(staffToken)).not.toContain('announcements');
    expect((await setLevel('announcements', 'employee', true)).status).toBe(200);
  });

  it('an HR Workspace admin switches Employee Workspace features only for their own HR Workspace and only among what it was given', async () => {
    const g = await api(app, deskToken).get(`/hr-workspaces/employee-features?scope=${desk}`);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.scopes.map((s: { id: string }) => s.id)).toEqual([desk]);
    const items = g.body.items as EmployeeRow[];
    expect(items.find((r) => r.key === 'payroll')!.cell).toMatchObject({ indicator: 'restricted', restrictedBy: 'super' });
    expect(items.find((r) => r.key === 'attendance_basic')!.cell).toMatchObject({ on: true, indicator: 'inherited', editable: true });
    expect((await api(app, deskToken).put('/hr-workspaces/employee-features').send({ scope: 'central', changes: [{ key: 'leave', enabled: false }] })).status).toBe(403);
    expect((await api(app, deskToken).put('/hr-workspaces/employee-features').send({ scope: desk, changes: [{ key: 'payroll', enabled: true }] })).status).toBe(403);
    expect((await api(app, deskToken).put('/hr-workspaces/employee-features').send({ scope: desk, changes: [{ key: 'attendance_basic', enabled: false }] })).status).toBe(200);
    expect(await features(deskStaffToken)).not.toContain('attendance_basic');
    expect(await features(deskToken)).toContain('attendance_basic');
    expect(await features(staffToken)).toContain('attendance_basic');
    const audited = await pool.find('audit_events', { tenant_id: t.id, action: 'employee_features.changed' });
    expect(new Set(audited.map((a) => JSON.stringify([a.resource_type, a.changes])))).toEqual(new Set([
      JSON.stringify(['workspace_modules', { switchedOff: { from: [], to: ['leave'] } }]),
      JSON.stringify(['hr_workspace', { switchedOff: { from: [], to: ['attendance_basic'] } }]),
    ]));
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'delegation.denied', resource_type: 'employee_features' })).toBe(3); // with HR's refused switch-on above
  });

  it('every level change is audited with its old and new lists, and switching off deletes nothing', async () => {
    const changes = await pool.count('audit_events', { tenant_id: t.id, action: 'workspace.features_changed' });
    expect(changes).toBeGreaterThanOrEqual(6);
    expect(await pool.count('employees', { tenant_id: t.id })).toBe(3);
  });
});
