import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * One change at one level, seen at the others straight away: the Console, the Super Workspace, an HR Workspace person
 * and an employee each keep their own signed-in session while something above or beside them changes. Nothing is
 * cached per session: every request reads access, placement and modules afresh.
 */
describe('Four levels stay in sync', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let consoleToken: string;
  let sales: string;
  let eng: string;
  let hrPerson: { email: string; membershipId: string };
  let hrToken: string;
  let staff: { email: string; membershipId: string };
  let staffToken: string;
  let staffEmployee: string;
  let salesEmployee: string;
  let designationId: string;

  const hire = (body: Record<string, unknown>) =>
    api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: today(), probationMonths: 0, onboardingTemplateId: null, ...body });
  const directory = async (token: string) => {
    const r = await api(app, token).get('/employees?limit=200');
    return r.status === 200 ? (r.body.items as { id: string; departmentName: string | null; designationName: string | null; accessLabel: string | null }[]) : [];
  };
  const features = async (token: string) => (await api(app, token).get('/me')).body.features as string[];
  const consoleView = async () => (await api(app, consoleToken).get(`/platform/tenants/${t.id}`)).body.hierarchy;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    sales = await department(pool, t, 'Sales');
    eng = await department(pool, t, 'Engineering');
    hrPerson = await addMember(pool, t, { name: 'Hema HR' });
    staff = await addMember(pool, t, { name: 'Sid Staff' });
    hrToken = (await loginWithMfa(app, pool, hrPerson.email)).accessToken;
    staffToken = (await login(app, staff.email)).accessToken;
    const d = await api(app, owner).post('/designations').send({ name: 'Sales Associate' });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    designationId = d.body.id;
    const a = await hire({ firstName: 'Sid', lastName: 'Staff', departmentId: eng, designationId, membershipId: staff.membershipId });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    staffEmployee = a.body.employee.id;
    const b = await hire({ firstName: 'Sara', lastName: 'Sales', departmentId: sales, designationId });
    salesEmployee = b.body.employee.id;
    await hire({ firstName: 'Eli', lastName: 'Eng', departmentId: eng });
    const email = `sync.${Date.now()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Sync', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('Super Workspace gives HR Workspace access for Sales: the same session sees Sales at once, the Console counts it', async () => {
    expect(await directory(hrToken)).toEqual([]);
    const before = await consoleView();
    expect(before.counts).toMatchObject({ super: 1, hr: 0 });
    const set = await api(app, owner).put(`/members/${hrPerson.membershipId}/access`).send({ level: 'hr', departmentIds: [sales] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const seen = await directory(hrToken);
    expect(seen.map((e) => e.id)).toEqual([salesEmployee]);
    expect((await api(app, hrToken).get('/me')).body.membership.roles.map((r: { key: string }) => r.key)).toContain('hr_workspace');
    expect((await consoleView()).counts).toMatchObject({ super: 1, hr: 1 });
    // The directory and profile show the level next to designation and department, which stay separate.
    const row = (await directory(owner)).find((e) => e.id === salesEmployee)!;
    expect(row).toMatchObject({ departmentName: 'Sales', designationName: 'Sales Associate', accessLabel: null });
  });

  it('a transfer to Sales moves the person into the HR person’s reach and updates their login’s placement', async () => {
    expect((await directory(hrToken)).map((e) => e.id)).not.toContain(staffEmployee);
    const move = await api(app, owner).post(`/employees/${staffEmployee}/job-changes`).send({ departmentId: sales, effectiveFrom: today(), reason: 'transfer' });
    expect(move.status, JSON.stringify(move.body)).toBe(201);
    expect((await directory(hrToken)).map((e) => e.id)).toContain(staffEmployee);
    expect((await pool.one('memberships', { id: staff.membershipId }))!.department_id).toBe(sales);
    const mine = await api(app, staffToken).get('/profile/me');
    expect(mine.body.professional).toMatchObject({ department: 'Sales', workspaceAccess: 'Employee Workspace', assignedWorkspace: 'Central group' });
  });

  it('renaming a designation shows on the directory and on the person’s own profile, and never changes access', async () => {
    const r = await api(app, owner).patch(`/designations/${designationId}`).send({ name: 'Account Executive' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await directory(owner)).filter((e) => e.designationName === 'Account Executive').length).toBe(2);
    expect((await api(app, staffToken).get('/profile/me')).body.professional.designation).toBe('Account Executive');
    expect((await directory(owner)).find((e) => e.id === staffEmployee)!.accessLabel).toBe('Employee Workspace');
  });

  it('Super Workspace switches a module off: the HR person and the employee lose it at once, and get it back', async () => {
    expect(await features(hrToken)).toContain('leave');
    expect(await features(staffToken)).toContain('leave');
    const off = await api(app, owner).put('/hr-admin/modules').send({ changes: [{ key: 'leave', enabled: false }] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await features(hrToken)).not.toContain('leave');
    expect(await features(staffToken)).not.toContain('leave');
    expect((await api(app, staffToken).get('/leave/types')).status).toBe(403);
    await api(app, owner).put('/hr-admin/modules').send({ changes: [{ key: 'leave', enabled: true }] });
    expect(await features(staffToken)).toContain('leave');
  });

  it('the Console switches a module off: Super, HR and Employee Workspace all lose it, and get it back', async () => {
    const off = await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state: 'off' }] });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    for (const token of [owner, hrToken, staffToken]) expect(await features(token)).not.toContain('leave');
    await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state: 'plan' }] });
    for (const token of [owner, hrToken, staffToken]) expect(await features(token)).toContain('leave');
  });

  it('an HR Workspace made by Super Workspace shows in the Console with its admin and people, and its people get only its modules', async () => {
    const ws = await api(app, owner).post('/hr-workspaces').send({ name: 'Sales Desk', features: ['attendance_basic'], adminMembershipIds: [] });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    const moved = await api(app, owner).post(`/hr-workspaces/${ws.body.id}/members`).send({ employeeIds: [staffEmployee], reason: 'Joins the sales desk' });
    expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(300);
    const h = await consoleView();
    expect(h.hrWorkspaces).toEqual([expect.objectContaining({ name: 'Sales Desk', people: 1 })]);
    // The employee now has only the HR Workspace's modules (plus what is always on).
    const f = await features(staffToken);
    expect(f).toContain('attendance_basic');
    expect(f).not.toContain('leave');
    expect((await api(app, staffToken).get('/profile/me')).body.professional.assignedWorkspace).toBe('Sales Desk');
  });

  it('taking HR Workspace access away ends it in the same session, and the Console count follows', async () => {
    const set = await api(app, owner).put(`/members/${hrPerson.membershipId}/access`).send({ level: 'employee' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await directory(hrToken)).toEqual([]);
    expect((await consoleView()).counts).toMatchObject({ hr: 0 });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'membership.access_changed' })).toBe(2);
  });

  it('a manager change gives the new manager (Employee Workspace) their report at once, and takes it away again', async () => {
    const m = await hire({ firstName: 'Hema', lastName: 'HR', departmentId: sales, membershipId: hrPerson.membershipId });
    expect(m.status, JSON.stringify(m.body)).toBe(201);
    const change = (managerEmployeeId: string | null) =>
      api(app, owner).post(`/employees/${staffEmployee}/job-changes`).send({ managerEmployeeId, effectiveFrom: today(), reason: 'manager_change' });
    expect((await change(m.body.employee.id)).status).toBe(201);
    expect((await pool.one('memberships', { id: staff.membershipId }))!.manager_membership_id).toBe(hrPerson.membershipId);
    expect((await directory(hrToken)).map((e) => e.id)).toContain(staffEmployee);
    expect((await change(null)).status).toBe(201);
    expect((await pool.one('memberships', { id: staff.membershipId }))!.manager_membership_id).toBeNull();
    expect((await directory(hrToken)).map((e) => e.id)).not.toContain(staffEmployee);
  });
});
