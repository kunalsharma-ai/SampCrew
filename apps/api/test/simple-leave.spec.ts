import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const Y = new Date().getUTCFullYear() + 1; // dates next year, so notice rules never get in the way
const weekday = (month: number, nth = 1, dow = 1) => {
  const d = new Date(Date.UTC(Y, month - 1, 1));
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (nth - 1));
  return d.toISOString().slice(0, 10);
};
const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

/**
 * Simplified leave management and Workspace Permissions (2026-11-23), through the 18 test scenarios of the
 * specification: module activation by level, leave types with visibility, HR Workspace creating types only when
 * allowed and only within its scope, one-step HR approval, manual quantities only ("Not Assigned" otherwise), history
 * kept when a type is disabled, permission templates for new HR Workspaces, and no way around the parent's limits.
 */
describe('simple leave and workspace permissions (18 scenarios)', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let consoleToken: string;
  let sup: string;
  let companyHr: string;
  let puneHr: string;
  let delhiHr: string;
  let puneId: string;
  let delhiId: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tok: Record<string, string> = {};
  const types: Record<string, string> = {};
  const as = (who: string) => api(app, tok[who]);
  const ok = (res: { status: number; body: unknown }, status = 200): Any => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Any;
  };
  const mineCodes = async (token: string) => (ok(await api(app, token).get('/leave/mine')).types as Any[]).map((x) => x.name).sort();
  const inbox = async (token: string) => ok(await api(app, token).get('/approvals/inbox')) as unknown as { id: string; resourceId: string }[];
  const setLevel = (key: string, target: 'hr' | 'employee', enabled: boolean) => api(app, sup).put('/hr-admin/features').send({ changes: [{ key, target, enabled }] });
  const perms = (level: 'hr' | 'employee', groupId: string, permissions: Record<string, boolean>, token = sup) => api(app, token).put('/workspace-permissions').send({ level, groupId, permissions });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    sup = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hana = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.hana = hana;
    companyHr = (await loginWithMfa(app, pool, hana.email)).accessToken;
    const pune = await addMember(pool, t, { name: 'Priya Pune' });
    const pws = ok(await api(app, sup).post('/hr-workspaces').send({ name: 'Pune Branch', code: 'PUNE', kind: 'branch', features: ['leave', 'attendance_basic'], adminMembershipIds: [pune.membershipId] }), 201);
    puneId = pws.id;
    puneHr = (await login(app, pune.email)).accessToken;
    const hire = async (who: string, name: string, body: Record<string, unknown>, member?: { email: string; membershipId: string }) => {
      people[who] = member ?? await addMember(pool, t, { name });
      const [first, last] = name.split(' ');
      const res = ok(await api(app, sup).post('/employees').send({
        legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null, firstName: first, lastName: last,
        membershipId: people[who]!.membershipId, ...body,
      }), 201);
      people[who]!.employeeId = res.employee.id;
      tok[who] = member ? companyHr : (await login(app, people[who]!.email)).accessToken;
    };
    await hire('perm', 'Pia Permanent', { hrWorkspaceId: puneId, employmentType: 'full_time' });
    await hire('central', 'Cyd Central', { hrWorkspaceId: null, employmentType: 'full_time' });
    await hire('hana', 'Hana HR', { hrWorkspaceId: null, employmentType: 'full_time' }, hana);
    const email = `simpleleave.${Date.now()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Leave', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('1. Super Admin (Console) switches Leave Management for the Super Workspace', async () => {
    const sw = (state: string) => api(app, consoleToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state }] });
    ok(await sw('off'));
    expect((await api(app, sup).get('/leave/types')).status).toBe(403);
    expect((await as('perm').get('/leave/mine')).status).toBe(403);
    ok(await sw('on'));
    ok(await api(app, sup).get('/leave/types'));
    ok(await sw('plan'));
  });

  it('2-3. the Super Workspace switches Leave for HR Workspace and Employee Workspace independently', async () => {
    ok(await setLevel('leave', 'hr', false));
    expect((await api(app, puneHr).get('/leave/types')).status).toBe(403);
    ok(await as('perm').get('/leave/mine'));
    ok(await setLevel('leave', 'hr', true));
    ok(await setLevel('leave', 'employee', false));
    expect((await as('perm').get('/leave/mine')).status).toBe(403);
    ok(await api(app, puneHr).get('/leave/types'));
    ok(await setLevel('leave', 'employee', true));
    ok(await as('perm').get('/leave/mine'));
  });

  it('4-6. the Super Workspace creates leave types visible to HR only, Employee only and both, with no allocation step', async () => {
    expect(ok(await api(app, sup).get('/leave/types'))).toEqual([]);
    const create = async (name: string, visibility: string, extra: Record<string, unknown> = {}) => ok(await api(app, sup).post('/leave/types').send({ name, visibility, ...extra }), 201);
    const wfh = await create('Work From Home', 'hr', { description: 'For HR staff' });
    const emergency = await create('Emergency Leave', 'employee');
    const casual = await create('Casual Leave', 'both', { code: 'CL' });
    types.wfh = wfh.id;
    types.emergency = emergency.id;
    types.casual = casual.id;
    expect(wfh).toMatchObject({ code: 'WFH', visibility: 'hr', active: true, owner: { level: 'super' }, createdBy: { level: 'super' } });
    expect(emergency.code).toBe('EL');
    expect(casual).toMatchObject({ code: 'CL', visibility: 'both', policy: { accrualMethod: 'none' } });
    // They appear at once where they are visible, and nowhere else.
    expect(await mineCodes(tok.perm!)).toEqual(['Casual Leave', 'Emergency Leave']);
    expect(await mineCodes(tok.central!)).toEqual(['Casual Leave', 'Emergency Leave']);
    expect(await mineCodes(companyHr)).toEqual(['Casual Leave', 'Work From Home']);
    // An Employee Workspace cannot read an HR-only type.
    expect((await as('perm').get(`/leave/types/${types.wfh}`)).status).toBe(404);
    // An HR Workspace sees every Super Workspace type: it reviews their applications.
    expect((ok(await api(app, puneHr).get('/leave/types')) as unknown as Any[]).map((x) => x.name).sort()).toEqual(['Casual Leave', 'Emergency Leave', 'Work From Home']);
    // Recorded in the audit trail.
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'leave_type.created' })).toBeGreaterThanOrEqual(3);
  });

  it('7-8. with permission from the Super Workspace, an HR Workspace creates its own type, within its scope', async () => {
    // Not allowed by default.
    expect((await api(app, puneHr).post('/leave/types').send({ name: 'Pune Field Leave', visibility: 'both' })).status).toBe(403);
    ok(await perms('hr', puneId, { 'leave.create_types': true, 'leave.edit_types': true, 'leave.visibility': true, 'leave.disable_types': true }));
    const field = ok(await api(app, puneHr).post('/leave/types').send({ name: 'Pune Field Leave', description: 'Site visits', visibility: 'both' }), 201);
    types.field = field.id;
    expect(field).toMatchObject({ owner: { level: 'hr', hrWorkspaceId: puneId, hrWorkspaceName: 'Pune Branch' }, createdBy: { level: 'hr', name: 'Priya Pune' }, canManage: true });
    // It appears for the Pune HR Workspace's own employees only.
    expect(await mineCodes(tok.perm!)).toContain('Pune Field Leave');
    expect(await mineCodes(tok.central!)).not.toContain('Pune Field Leave');
    // It cannot reach Employee Workspace while the Super Workspace keeps Leave from Employee Workspace.
    ok(await setLevel('leave', 'employee', false));
    expect((await api(app, puneHr).post('/leave/types').send({ name: 'Pune Night Leave', visibility: 'employee' })).status).toBe(403);
    expect((await api(app, puneHr).put(`/leave/types/${types.field}/visibility`).send({ visibility: 'employee' })).status).toBe(403);
    const hrOnly = ok(await api(app, puneHr).post('/leave/types').send({ name: 'Pune Night Leave', visibility: 'hr' }), 201);
    ok(await setLevel('leave', 'employee', true));
    // Its own types it may rename and switch where they appear.
    ok(await api(app, puneHr).patch(`/leave/types/${hrOnly.id}`).send({ name: 'Pune Night Shift Leave' }));
    expect(ok(await api(app, puneHr).put(`/leave/types/${hrOnly.id}/visibility`).send({ visibility: 'both' })).visibility).toBe('both');
    // But never the policies.
    expect((await api(app, puneHr).patch(`/leave/types/${hrOnly.id}`).send({ policy: { minNoticeDays: 3 } })).status).toBe(403);
  });

  it('9. an HR Workspace cannot change Super Workspace types or reach another HR Workspace type', async () => {
    const delhiAdmin = await addMember(pool, t, { name: 'Dev Delhi' });
    // Created with "All permitted permissions": it may create leave types from the start.
    const d = ok(await api(app, sup).post('/hr-workspaces').send({ name: 'Delhi Branch', code: 'DELHI', kind: 'branch', features: ['leave'], adminMembershipIds: [delhiAdmin.membershipId], permissionTemplate: { template: 'all' } }), 201);
    delhiId = d.id;
    delhiHr = (await login(app, delhiAdmin.email)).accessToken;
    const delhiType = ok(await api(app, delhiHr).post('/leave/types').send({ name: 'Delhi Festival Leave', visibility: 'both' }), 201);
    types.delhi = delhiType.id;
    expect((await api(app, puneHr).get(`/leave/types/${types.delhi}`)).status).toBe(404);
    expect((await api(app, puneHr).patch(`/leave/types/${types.delhi}`).send({ name: 'Mine now' })).status).toBe(404);
    expect((await api(app, puneHr).post(`/leave/types/${types.delhi}/status`).send({ active: false, reason: 'Trying' })).status).toBe(404);
    expect((ok(await api(app, puneHr).get('/leave/types')) as unknown as Any[]).map((x) => x.name)).not.toContain('Delhi Festival Leave');
    // A Super Workspace type is visible to it but not its to change.
    expect((await api(app, puneHr).patch(`/leave/types/${types.casual}`).send({ name: 'Renamed' })).status).toBe(403);
    expect((await api(app, puneHr).put(`/leave/types/${types.casual}/visibility`).send({ visibility: 'hr' })).status).toBe(403);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'leave_type.change_denied' })).toBeGreaterThanOrEqual(1);
    // Nor can it create a type for an HR Workspace it does not run.
    expect((await api(app, puneHr).post('/leave/types').send({ name: 'Sneaky', visibility: 'both', hrWorkspaceId: delhiId })).status).toBe(403);
  });

  let approved: Any;
  let rejected: Any;
  it('10-13. an employee applies, HR Workspace receives it, approves or rejects, and the employee sees the status', async () => {
    const day = weekday(3, 2, 1);
    approved = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.casual, startDate: day, endDate: day, reason: 'Family visit' }), 201);
    expect(approved).toMatchObject({ status: 'pending', approvalRoute: 'hr', reviewerHrWorkspaceName: 'Pune Branch', reference: expect.stringMatching(/^LV-[0-9A-F]{6}$/) });
    expect(approved.authorities).toEqual([expect.objectContaining({ authority: 'hr', status: 'pending' })]);
    // It reaches the Pune HR Workspace, and not the others.
    expect((await inbox(puneHr)).map((i) => i.resourceId)).toContain(approved.id);
    expect((await inbox(delhiHr)).map((i) => i.resourceId)).not.toContain(approved.id);
    ok(await api(app, puneHr).post(`/approvals/${approved.approvalId}/approve`).send({ comment: 'Enjoy' }));
    rejected = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.emergency, startDate: weekday(4, 2, 2), endDate: weekday(4, 2, 2), reason: 'Plumbing' }), 201);
    // Reject can be switched apart from approve.
    ok(await perms('hr', puneId, { 'leave.reject': false }));
    expect((await api(app, puneHr).post(`/approvals/${rejected.approvalId}/reject`).send({ comment: 'Busy week' })).status).toBe(403);
    ok(await perms('hr', puneId, { 'leave.reject': true }));
    ok(await api(app, puneHr).post(`/approvals/${rejected.approvalId}/reject`).send({ comment: 'Busy week' }));
    const mine = ok(await as('perm').get('/leave/requests?scope=mine')) as unknown as Any[];
    expect(mine.find((r) => r.id === approved.id).status).toBe('approved');
    expect(mine.find((r) => r.id === rejected.id).status).toBe('rejected');
    const summary = ok(await as('perm').get('/leave/mine')).summary;
    expect(summary).toMatchObject({ approved: 1, rejected: 1, pending: 0 });
    // Every step is in the audit trail, under the request.
    const trail = await pool.find('audit_events', { tenant_id: t.id, resource_id: approved.id });
    expect(trail.map((a: Any) => a.action)).toEqual(expect.arrayContaining(['leave_request.submitted', 'leave_request.approved']));
    // A cancelled request is the fourth status.
    const c = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.casual, startDate: weekday(5, 2, 3), endDate: weekday(5, 2, 3) }), 201);
    expect(ok(await as('perm').post(`/leave/requests/${c.id}/cancel`).send({ reason: 'Plans changed' }), 201).status).toBe('cancelled');
  });

  it('14-15. quantities appear only when entered by hand; otherwise Not Assigned, and nothing is credited automatically', async () => {
    const bal = async (who: string, typeId: string) => (ok(await as(who).get(`/leave/balances?year=${Y}`)).balances as Any[]).find((b) => b.leaveTypeId === typeId);
    expect(await bal('perm', types.casual!)).toMatchObject({ notAssigned: true, assigned: null, available: null, used: '1.00' });
    expect(await bal('central', types.casual!)).toMatchObject({ notAssigned: true, assigned: null });
    // The hourly job and hiring credit nothing.
    ok(await api(app, sup).post('/leave/escalations/run').send({}), 201);
    expect(await pool.count('leave_ledger', { tenant_id: t.id, kind: { $in: ['accrual', 'carry_forward', 'lapse'] } })).toBe(0);
    // Accrual endpoints are gone.
    expect((await api(app, sup).post('/leave/accruals/run').send({})).status).toBe(404);
    // An administrator types 5 days.
    expect((await api(app, puneHr).put('/leave/quantities').send({ employeeId: people.central!.employeeId, leaveTypeId: types.casual, year: Y, quantity: '5' })).status).toBe(404);
    const q = ok(await api(app, puneHr).put('/leave/quantities').send({ employeeId: people.perm!.employeeId, leaveTypeId: types.casual, year: Y, quantity: '5', note: 'Agreed in contract' }));
    expect(q).toMatchObject({ assigned: '5.00', used: '1.00', remaining: '4.00' });
    expect(await bal('perm', types.casual!)).toMatchObject({ notAssigned: false, assigned: '5.00', balance: '4.00', available: '4.00' });
    // Setting it again replaces it (history stays in the ledger and the audit trail).
    ok(await api(app, puneHr).put('/leave/quantities').send({ employeeId: people.perm!.employeeId, leaveTypeId: types.casual, year: Y, quantity: '3' }));
    expect(await bal('perm', types.casual!)).toMatchObject({ assigned: '3.00', balance: '2.00' });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'leave_quantity.assigned' })).toBe(2);
    // The quantities page lists people in scope with Not Assigned shown as null.
    const list = ok(await api(app, puneHr).get(`/leave/quantities?year=${Y}`));
    expect(list.rows.map((r: Any) => r.name)).toEqual(['Pia Permanent']);
    expect(list.rows[0].cells[types.emergency!]).toMatchObject({ assigned: null });
    // Without a quantity the person still applies; with one, going over it warns and does not block.
    const over = ok(await as('perm').post('/leave/requests/preview').send({ leaveTypeId: types.casual, startDate: weekday(6, 1, 1), endDate: plusDays(weekday(6, 1, 1), 4) }), 201);
    expect(over.warnings.join(' ')).toMatch(/more than the 2.00 days/);
    ok(await as('central').post('/leave/requests/preview').send({ leaveTypeId: types.emergency, startDate: weekday(6, 1, 1), endDate: weekday(6, 1, 1) }), 201);
    // Nobody assigns to themselves; an Employee Workspace cannot assign at all.
    expect((await as('perm').put('/leave/quantities').send({ employeeId: people.perm!.employeeId, leaveTypeId: types.casual, year: Y, quantity: '50' })).status).toBe(403);
  });

  it('16. disabling a leave type or changing its visibility keeps every application', async () => {
    const pending = ok(await as('central').post('/leave/requests').send({ leaveTypeId: types.emergency, startDate: weekday(7, 2, 1), endDate: weekday(7, 2, 1) }), 201);
    ok(await api(app, sup).post(`/leave/types/${types.emergency}/status`).send({ active: false, reason: 'Replaced' }), 201);
    expect(await mineCodes(tok.central!)).not.toContain('Emergency Leave');
    const r = await as('central').post('/leave/requests/preview').send({ leaveTypeId: types.emergency, startDate: weekday(8, 2, 1), endDate: weekday(8, 2, 1) });
    expect(r.body.error.code).toBe('invalid_leave_type');
    expect((ok(await as('central').get('/leave/requests?scope=mine')) as unknown as Any[]).map((x) => x.id)).toContain(pending.id);
    expect((ok(await as('perm').get('/leave/requests?scope=mine')) as unknown as Any[]).map((x) => x.id)).toContain(rejected.id);
    // Visibility: Casual Leave for HR only hides it from new applications in Employee Workspace; history stays.
    ok(await api(app, sup).put(`/leave/types/${types.casual}/visibility`).send({ visibility: 'hr' }));
    expect(await mineCodes(tok.perm!)).not.toContain('Casual Leave');
    expect((await as('perm').post('/leave/requests/preview').send({ leaveTypeId: types.casual, startDate: weekday(9, 2, 1), endDate: weekday(9, 2, 1) })).body.error.code).toBe('not_eligible');
    expect((ok(await as('perm').get('/leave/requests?scope=mine')) as unknown as Any[]).find((x) => x.id === approved.id).status).toBe('approved');
    expect(await mineCodes(companyHr)).toContain('Casual Leave');
    ok(await api(app, sup).put(`/leave/types/${types.casual}/visibility`).send({ visibility: 'both' }));
  });

  it('17. a new HR Workspace gets the template chosen for it, and the default template is editable', async () => {
    const view = ok(await api(app, sup).get('/workspace-permissions?level=hr&groupId=central'));
    expect(view.categories.map((c: Any) => c.label)).toEqual(expect.arrayContaining(['Employee Management', 'Leave Management', 'Attendance Management', 'Department Management', 'Reports and Analytics', 'Workspace Management', 'Settings Management']));
    expect(view.templates.map((x: Any) => x.key)).toEqual(['hr_default', 'all']);
    ok(await api(app, sup).put('/workspace-permissions/templates/hr_default').send({ permissions: { 'employees.export': false } }));
    const m = ok(await api(app, sup).post('/hr-workspaces').send({ name: 'Mumbai Branch', code: 'MUMBAI', kind: 'branch', features: ['leave'] }), 201);
    const on = async (id: string) => Object.fromEntries((ok(await api(app, sup).get(`/workspace-permissions?level=hr&groupId=${id}`)).categories as Any[]).flatMap((c) => c.items).map((i: Any) => [i.key, i.on]));
    const mumbai = await on(m.id);
    expect(mumbai).toMatchObject({ 'employees.export': false, 'leave.create_types': false, 'leave.approve': true });
    expect(await on(delhiId)).toMatchObject({ 'employees.export': true, 'leave.create_types': true });
    // Custom switches on creation.
    const c = ok(await api(app, sup).post('/hr-workspaces').send({ name: 'Chennai Branch', code: 'CHENNAI', kind: 'branch', features: ['leave'], permissionTemplate: { template: 'custom', permissions: { 'leave.approve': false } } }), 201);
    expect(await on(c.id)).toMatchObject({ 'leave.approve': false, 'employees.export': false });
    // Resetting the template brings the SampCrew defaults back.
    ok(await api(app, sup).delete('/workspace-permissions/templates/hr_default'));
    expect((ok(await api(app, sup).get('/workspace-permissions?level=hr&groupId=central')).templates as Any[]).find((x) => x.key === 'hr_default').permissions['employees.export']).toBe(true);
  });

  it('18. parent restrictions cannot be bypassed, and the API enforces every switch', async () => {
    // An HR Workspace cannot change permissions or level modules, even its own.
    expect((await perms('hr', puneId, { 'leave.create_types': true }, puneHr)).status).toBe(403);
    expect((await api(app, puneHr).put('/hr-admin/features').send({ changes: [{ key: 'leave', target: 'hr', enabled: true }] })).status).toBe(403);
    // It may read its own permissions, but not another HR Workspace's.
    ok(await api(app, puneHr).get(`/workspace-permissions?level=hr&groupId=${puneId}`));
    expect((await api(app, puneHr).get(`/workspace-permissions?level=hr&groupId=${delhiId}`)).status).toBe(404);
    expect((await api(app, puneHr).get('/workspace-permissions?level=employee')).status).toBe(403);
    // Locked and unknown switches are refused.
    expect((await perms('hr', puneId, { 'employees.view': false })).status).toBe(400);
    expect((await perms('hr', puneId, { 'made.up': true })).status).toBe(400);
    // A route switch: company HR can create departments until it is switched off.
    ok(await api(app, companyHr).post('/org/departments').send({ name: 'Quality' }), 201);
    ok(await perms('hr', 'central', { 'departments.create': false }));
    expect((await api(app, companyHr).post('/org/departments').send({ name: 'Safety' })).status).toBe(403);
    ok(await api(app, sup).post('/org/departments').send({ name: 'Safety' }), 201);
    // A permission switch: approving leave off for Pune is refused by the API and disappears from /me.
    ok(await perms('hr', puneId, { 'leave.approve': false }));
    const me = ok(await api(app, puneHr).get('/me'));
    expect(me.permissions['leave:approve']).toBeUndefined();
    ok(await perms('hr', puneId, { 'leave.approve': true }));
    // Employee Workspace: apply switched off for every Employee Workspace.
    ok(await perms('employee', 'all', { 'leave.apply': false }));
    expect((await as('central').post('/leave/requests').send({ leaveTypeId: types.casual, startDate: weekday(10, 2, 1), endDate: weekday(10, 2, 1) })).status).toBe(403);
    ok(await perms('employee', 'all', { 'leave.apply': true }));
    ok(await as('central').post('/leave/requests').send({ leaveTypeId: types.casual, startDate: weekday(10, 2, 1), endDate: weekday(10, 2, 1) }), 201);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'workspace_permissions.updated' })).toBeGreaterThanOrEqual(5);
  });
});
