import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The four levels through the HTTP API: the Console decides what a company holds and what it may pass down, the
 * Super Workspace gives each HR Workspace a subset, HR Workspace admins give each of their employees a subset of
 * that, and every level is checked by the API (a screen hiding a button is never the only guard).
 */
describe('Delegation chain: Console > Super Workspace > HR Workspace > Employee', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let owner: string;
  let consoleToken: string;
  let hrAdmin: { email: string; membershipId: string };
  let hrAdminToken: string;
  let staff: { email: string; membershipId: string };
  let staffEmployee: string;
  let centralEmployee: string;
  let wsId: string;
  let companyFeatures: string[];
  const stamp = Date.now();

  const hire = async (token: string, body: Record<string, unknown>) =>
    api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: today(), probationMonths: 0, onboardingTemplateId: null, ...body });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    other = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hrAdmin = await addMember(pool, t, { name: 'Hari Branch' });
    staff = await addMember(pool, t, { name: 'Sana Staff' });
    const email = `super.${stamp}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Super', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('starts with every existing employee in the central group and nothing rewritten', async () => {
    const r = await hire(owner, { firstName: 'Cleo', lastName: 'Central' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    centralEmployee = r.body.employee.id;
    const o = await api(app, owner).get('/hr-workspaces/overview');
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.hrWorkspaces).toEqual([]);
    expect(o.body.central.employees).toBe(1);
    expect(o.body.levels.super).toBe(true);
    companyFeatures = o.body.company.features;
    expect(companyFeatures).toEqual(expect.arrayContaining(['leave', 'attendance_basic', 'payroll']));
    expect((await pool.one('employees', { id: centralEmployee }))!.hr_workspace_id ?? null).toBeNull();
  });

  it('creates an HR Workspace with a subset of the company modules and names its admin', async () => {
    const r = await api(app, owner).post('/hr-workspaces').send({
      name: 'Pune Branch', code: 'PUNE', kind: 'branch', features: ['leave', 'attendance_basic'], adminMembershipIds: [hrAdmin.membershipId],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    wsId = r.body.id;
    const d = await api(app, owner).get(`/hr-workspaces/${wsId}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ name: 'Pune Branch', code: 'PUNE', status: 'active', version: 1 });
    expect(d.body.admins.map((a: { membershipId: string }) => a.membershipId)).toEqual([hrAdmin.membershipId]);
    const state = (k: string) => d.body.modules.find((m: { key: string }) => m.key === k)?.state;
    expect(state('leave')).toBe('granted');
    expect(state('payroll')).toBe('available');
    // The admin holds HR Workspace access, limited to this HR Workspace.
    const role = await pool.one('roles', { tenant_id: t.id, key: 'hr_workspace' });
    const a = await pool.one('role_assignments', { membership_id: hrAdmin.membershipId, role_id: role!.id });
    expect(a!.constraints.hrWorkspaceIds).toEqual([wsId]);
    expect(a!.source).toBe('hr_workspace');
    expect(await pool.count('config_versions', { tenant_id: t.id, target_id: wsId, action: 'created' })).toBe(1);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'hr_workspace.created', resource_id: wsId })).toBe(1);
    hrAdminToken = (await login(app, hrAdmin.email)).accessToken;
  });

  it('refuses to give an HR Workspace a module the company does not hold, and records the attempt', async () => {
    const missing = ['sso', 'enterprise_support', 'global_payroll', 'audit_export'].find((k) => !companyFeatures.includes(k));
    expect(missing).toBeDefined();
    const r = await api(app, owner).post('/hr-workspaces').send({ name: 'Too Much', features: ['leave', missing] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('exceeds_parent');
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'delegation.denied' })).toBeGreaterThan(0);
    const u = await api(app, owner).patch(`/hr-workspaces/${wsId}`).send({ features: ['leave', missing], version: 1 });
    expect(u.status).toBe(403);
  });

  it('refuses a change made on an older version', async () => {
    const ok = await api(app, owner).patch(`/hr-workspaces/${wsId}`).send({ description: 'West region office', version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await api(app, owner).patch(`/hr-workspaces/${wsId}`).send({ description: 'Older edit', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
  });

  it('lets the HR Workspace admin see only their HR Workspace, and not create or change HR Workspaces', async () => {
    const me = await api(app, hrAdminToken).get('/me');
    expect(me.status).toBe(200);
    expect(me.body.levels.super).toBe(false);
    expect(me.body.levels.hrWorkspaces.map((w: { id: string }) => w.id)).toEqual([wsId]);
    // Their modules are limited to what the HR Workspace holds.
    expect(me.body.features).toContain('leave');
    expect(me.body.features).not.toContain('payroll');
    expect(me.body.featureBlocks.payroll).toBe('hr_workspace_off');

    const list = await api(app, hrAdminToken).get('/hr-workspaces');
    expect(list.status).toBe(200);
    expect(list.body.items.map((w: { id: string }) => w.id)).toEqual([wsId]);
    const before = await pool.count('audit_events', { tenant_id: t.id, action: 'authz.denied' });
    const create = await api(app, hrAdminToken).post('/hr-workspaces').send({ name: 'My Own', features: ['leave'] });
    expect(create.status).toBe(403);
    expect((await api(app, hrAdminToken).patch(`/hr-workspaces/${wsId}`).send({ features: ['leave', 'attendance_basic', 'payroll'] })).status).toBe(403);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'authz.denied' })).toBeGreaterThan(before);
    // The central group and the company's people are not theirs.
    expect((await api(app, hrAdminToken).get('/hr-workspaces/central/members')).status).toBe(403);
    expect((await api(app, hrAdminToken).get(`/employees/${centralEmployee}`)).status).toBe(404);
  });

  it('lets the HR Workspace admin add employees, who land in their HR Workspace', async () => {
    const r = await hire(hrAdminToken, { firstName: 'Sana', lastName: 'Staff', membershipId: staff.membershipId });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    staffEmployee = r.body.employee.id;
    expect((await pool.one('employees', { id: staffEmployee }))!.hr_workspace_id).toBe(wsId);
    // They cannot put someone outside their HR Workspace.
    const outside = await hire(hrAdminToken, { firstName: 'Nope', lastName: 'Central', hrWorkspaceId: null });
    expect(outside.status).toBe(403);
    const members = await api(app, hrAdminToken).get(`/hr-workspaces/${wsId}/members`);
    expect(members.status).toBe(200);
    expect(members.body.items.map((m: { employeeId: string }) => m.employeeId)).toEqual([staffEmployee]);
    expect(members.body.items[0].modules).toEqual(expect.arrayContaining(['leave', 'attendance_basic']));
    const d = await api(app, owner).get(`/hr-workspaces/${wsId}`);
    expect(d.body.employees).toBe(1);
    expect(d.body.admins[0]).toMatchObject({ name: 'Hari Branch', email: hrAdmin.email });
  });

  it('gives an employee only a subset of their HR Workspace modules', async () => {
    const beyond = await api(app, hrAdminToken).put(`/hr-workspaces/employees/${staffEmployee}/modules`).send({ modules: ['leave', 'payroll'] });
    expect(beyond.status).toBe(403);
    expect(beyond.body.error.code).toBe('exceeds_parent');
    const r = await api(app, hrAdminToken).put(`/hr-workspaces/employees/${staffEmployee}/modules`).send({ modules: ['leave'] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.modules).toContain('leave');
    expect(r.body.modules).not.toContain('attendance_basic');
    const staffMe = await api(app, (await login(app, staff.email)).accessToken).get('/me');
    expect(staffMe.body.features).toContain('leave');
    expect(staffMe.body.featureBlocks.attendance_basic).toBe('hr_member_off');
    expect(staffMe.body.featureBlocks.payroll).toBe('hr_workspace_off');
    // And the API, not just the screen, closes the module.
    const blocked = await api(app, (await login(app, staff.email)).accessToken).get('/attendance/today');
    expect(blocked.status).toBe(403);
    // A stale edit is refused.
    const stale = await api(app, hrAdminToken).put(`/hr-workspaces/employees/${staffEmployee}/modules`).send({ modules: ['leave', 'attendance_basic'], version: 0 });
    expect(stale.status).toBe(409);
  });

  it('moves an employee between HR Workspaces and back to the central group, keeping the history', async () => {
    const second = await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi Branch', features: ['leave'] });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const moved = await api(app, owner).post('/hr-workspaces/transfers').send({ employeeId: staffEmployee, toHrWorkspaceId: second.body.id, reason: 'Relocated to Delhi' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(201);
    expect((await pool.one('employees', { id: staffEmployee }))!.hr_workspace_id).toBe(second.body.id);
    // The Pune admin no longer reaches them.
    expect((await api(app, hrAdminToken).get(`/employees/${staffEmployee}`)).status).toBe(404);
    const back = await api(app, owner).post('/hr-workspaces/central/members').send({ employeeIds: [staffEmployee], reason: 'Back to head office' });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const history = await api(app, owner).get(`/hr-workspaces/transfers?employeeId=${staffEmployee}`);
    expect(history.status).toBe(200);
    expect(history.body.items.map((x: { toName: string | null }) => x.toName)).toEqual(expect.arrayContaining(['Delhi Branch', null]));
    // An HR Workspace admin cannot move people.
    expect((await api(app, hrAdminToken).post('/hr-workspaces/transfers').send({ employeeId: centralEmployee, toHrWorkspaceId: wsId, reason: 'Mine now' })).status).toBe(403);
  });

  it('lets the Console keep a module at company level, which then stops working in HR Workspaces at once', async () => {
    const view = await api(app, consoleToken).get(`/platform/tenants/${t.id}/hierarchy`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.hrWorkspaces.map((w: { name: string }) => w.name)).toEqual(expect.arrayContaining(['Pune Branch', 'Delhi Branch']));
    const set = await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/delegation`).send({ nonDelegableFeatures: ['attendance_basic'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.nonDelegableFeatures).toEqual(['attendance_basic']);
    const me = await api(app, (await login(app, hrAdmin.email)).accessToken).get('/me');
    expect(me.body.features).not.toContain('attendance_basic');
    expect(me.body.featureBlocks.attendance_basic).toBe('hr_workspace_off');
    // Not offered any more, and refused when given.
    const d = await api(app, owner).get(`/hr-workspaces/${wsId}`);
    expect(d.body.modules.find((m: { key: string }) => m.key === 'attendance_basic')).toMatchObject({ state: 'locked', lockedBy: 'console' });
    expect((await api(app, owner).post('/hr-workspaces').send({ name: 'Chennai', features: ['attendance_basic'] })).status).toBe(403);
    // The owner, a company-wide admin, keeps it.
    expect((await api(app, owner).get('/me')).body.features).toContain('attendance_basic');
    expect(await pool.count('config_versions', { tenant_id: t.id, target_type: 'company', action: 'delegation_policy' })).toBe(1);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'hierarchy.recalculated' })).toBeGreaterThan(0);
    // Giving it back restores the HR Workspace's earlier choice, because stored choices are never rewritten.
    await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/delegation`).send({ nonDelegableFeatures: [] });
    expect((await api(app, (await login(app, hrAdmin.email)).accessToken).get('/me')).body.features).toContain('attendance_basic');
  });

  it('applies a Console module switch-off to every level below', async () => {
    const off = await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state: 'off' }] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const me = await api(app, (await login(app, hrAdmin.email)).accessToken).get('/me');
    expect(me.body.features).not.toContain('leave');
    const d = await api(app, owner).get(`/hr-workspaces/${wsId}`);
    expect(d.body.modules.find((m: { key: string }) => m.key === 'leave')).toMatchObject({ state: 'locked', stale: true });
    await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state: 'plan' }] });
    expect((await api(app, (await login(app, hrAdmin.email)).accessToken).get('/me')).body.features).toContain('leave');
  });

  it('archives an HR Workspace, moving its people to the central group and removing its admins', async () => {
    const back = await api(app, owner).post(`/hr-workspaces/${wsId}/members`).send({ employeeIds: [staffEmployee], reason: 'Back to Pune' });
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const r = await api(app, owner).post(`/hr-workspaces/${wsId}/status`).send({ status: 'archived', reason: 'Branch closed down' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await pool.one('employees', { id: staffEmployee }))!.hr_workspace_id ?? null).toBeNull();
    const role = await pool.one('roles', { tenant_id: t.id, key: 'hr_workspace' });
    expect(await pool.count('role_assignments', { membership_id: hrAdmin.membershipId, role_id: role!.id })).toBe(0);
    expect((await api(app, (await login(app, hrAdmin.email)).accessToken).get('/hr-workspaces')).status).toBe(403);
  });

  it('keeps each company to its own HR Workspaces', async () => {
    const otherOwner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
    expect((await api(app, otherOwner).get(`/hr-workspaces/${wsId}`)).status).toBe(404);
    expect((await api(app, otherOwner).get('/hr-workspaces?status=all')).body.items).toEqual([]);
  });

  it('records the versioned history of the chain', async () => {
    const h = await api(app, owner).get('/hr-workspaces/history');
    expect(h.status).toBe(200);
    const actions = h.body.items.map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['created', 'updated', 'delegation_policy']));
    expect(h.body.items.find((x: { action: string }) => x.action === 'delegation_policy').level).toBe('console');
  });
});
