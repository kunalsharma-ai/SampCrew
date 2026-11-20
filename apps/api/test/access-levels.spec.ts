import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { getPermission, permissionAction } from '@crew/contracts';
import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSubject } from '../src/platform/authz/authz.service';
import { can, hasPermission } from '../src/platform/authz/policy';
import { adminPool, api, createApp, createTenant, department, login, loginWithMfa, passwordHash, type TestDb, type TestTenant } from './helpers';

/**
 * Option A: the four access levels replace the 14 built-in roles. An existing workspace is moved by the migration
 * (applyAccessLevelsMongo): every person keeps exactly what they could do, the old roles stay in the database
 * unassigned for rollback, and only the levels give access from then on.
 */
describe('Four access levels replace the old roles', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let uk: string;
  let eng: string;
  type Person = { email: string; membershipId: string; userId: string };
  const people = {} as Record<'owner' | 'coOwner' | 'hr' | 'ukHr' | 'recruiter' | 'payroll' | 'finance' | 'manager' | 'report' | 'auditor' | 'plain' | 'planner', Person>;
  type Who = keyof typeof people;

  /** A person as the old release left them: holding old roles directly. */
  const legacyMember = async (name: string, roles: string[], opts: { constraints?: Record<string, unknown>; departmentId?: string; managerId?: string } = {}) => {
    const email = `${randomUUID().slice(0, 8)}@${t.slug}.test`;
    const hash = await passwordHash();
    return pool.platform(async (tx) => {
      const u = await tx.collection('users').insert({ email, full_name: name, password_hash: hash });
      const m = await tx.collection('memberships').insert({ tenant_id: t.id, user_id: u.id, status: 'active', legal_entity_id: t.legalEntityId, department_id: opts.departmentId ?? null, manager_membership_id: opts.managerId ?? null, joined_at: new Date() });
      for (const key of ['employee', ...roles]) {
        const role = (await tx.collection('roles').findOne({ tenant_id: t.id, key }))!;
        await tx.collection('role_assignments').insert({ tenant_id: t.id, membership_id: m.id, role_id: role.id, constraints: key === 'employee' ? {} : (opts.constraints ?? {}) });
      }
      return { email, membershipId: m.id as string, userId: u.id as string };
    });
  };
  const subject = (who: Who) => pool.tenant(t.id, (tx) => loadSubject(tx as never, people[who]!.membershipId, people[who]!.userId, true));
  const allowed = async (who: Who, permission: string) => hasPermission(await subject(who), permission).allowed;
  const levelsOf = async (who: Who) => {
    const ras = await pool.find('role_assignments', { membership_id: people[who]!.membershipId });
    const keys = new Map((await pool.find('roles', { id: { $in: ras.map((x) => x.role_id) } })).map((r) => [r.id, r.key as string]));
    return ras.map((x) => keys.get(x.role_id)).sort();
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    eng = await department(pool, t, 'Engineering');
    uk = (await pool.insert('legal_entities', { tenant_id: t.id, name: 'UK Ltd', legal_name: 'UK Ltd', country_code: 'GB', currency: 'GBP', timezone: 'Europe/London', fiscal_year_start_month: 4 })).id as string;
    // The workspace as the release before the four access levels left it.
    const ownerRole = (await pool.one('roles', { tenant_id: t.id, key: 'tenant_owner' }))!;
    const levels = await pool.find('roles', { tenant_id: t.id, key: { $in: ['super_workspace', 'employee_workspace'] } });
    await pool.delete('role_assignments', { membership_id: t.ownerMembershipId, role_id: { $in: levels.map((r) => r.id) } });
    await pool.insert('role_assignments', { tenant_id: t.id, membership_id: t.ownerMembershipId, role_id: ownerRole.id, constraints: {} });
    people.owner = { email: t.ownerEmail, membershipId: t.ownerMembershipId, userId: (await pool.one('users', { email: t.ownerEmail }))!.id as string };
    people.coOwner = await legacyMember('Cora Owner', ['tenant_owner']);
    people.hr = await legacyMember('Hana HR', ['hr_admin']);
    people.ukHr = await legacyMember('Uma UK HR', ['hr_manager'], { constraints: { legalEntityIds: [uk] } });
    people.recruiter = await legacyMember('Rita Recruiter', ['recruiter']);
    people.payroll = await legacyMember('Pia Payroll', ['payroll_admin']);
    people.finance = await legacyMember('Fin Finance', ['finance_manager']);
    people.manager = await legacyMember('Mo Manager', ['department_manager'], { departmentId: eng });
    people.report = await legacyMember('Rae Report', [], { departmentId: eng, managerId: people.manager.membershipId });
    people.auditor = await legacyMember('Avi Auditor', ['auditor']);
    people.plain = await legacyMember('Pat Plain', []);
    // A custom role that gives more than Employee Workspace, an approval chain, a waiting step, a field rule.
    const custom = await pool.insert('roles', { tenant_id: t.id, key: 'shift_planner', name: 'Shift planner', is_system: false });
    await pool.insert('role_permissions', { tenant_id: t.id, role_id: custom.id, permission: 'shifts:manage', scope: 'tenant' });
    people.planner = await legacyMember('Sol Planner', ['shift_planner']);
    await pool.insert('approval_policies', { tenant_id: t.id, resource_type: 'leave_request', steps: [{ type: 'manager' }, { type: 'role', role: 'hr_admin' }] });
    await pool.insert('custom_fields', { tenant_id: t.id, entity: 'employee', key: 'blood_group', label: 'Blood group', type: 'text', view_roles: ['hr_admin', 'tenant_owner'], edit_roles: ['hr_admin'] });
    await pool.platform((tx) => mongo.applyAccessLevelsMongo(tx as never));
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('puts everyone on a level: Super, HR or Employee Workspace, with Employee Workspace underneath', async () => {
    expect(await levelsOf('owner')).toEqual(['employee_workspace', 'super_workspace']);
    expect(await levelsOf('coOwner')).toEqual(['employee_workspace', 'super_workspace']);
    for (const who of ['hr', 'ukHr', 'recruiter', 'payroll', 'finance', 'auditor', 'planner'] as const) expect(await levelsOf(who), who).toEqual(['employee_workspace', 'hr_workspace']);
    for (const who of ['manager', 'report', 'plain'] as const) expect(await levelsOf(who), who).toEqual(['employee_workspace']);
    // The old roles are still there, unassigned, so the move can be rolled back.
    expect(await pool.count('roles', { tenant_id: t.id, key: { $in: ['tenant_owner', 'hr_admin', 'recruiter'] } })).toBe(3);
    expect(await pool.count('access_level_migrations', { tenant_id: t.id, kind: 'membership' })).toBe(12);
  });

  it('keeps what each person could do, and no more', async () => {
    // Payroll Admin runs payroll but does not approve it; Finance approves it but does not run it.
    expect(await allowed('payroll', 'payroll:run')).toBe(true);
    expect(await allowed('payroll', 'payroll:approve')).toBe(false);
    expect(await allowed('finance', 'payroll:approve')).toBe(true);
    expect(await allowed('finance', 'payroll:run')).toBe(false);
    // HR Admin looks after people, not pay; a recruiter only recruitment.
    expect(await allowed('hr', 'employees:update')).toBe(true);
    expect(await allowed('hr', 'payroll:run')).toBe(false);
    expect(await allowed('recruiter', 'candidates:manage')).toBe(true);
    expect(await allowed('recruiter', 'employees:update')).toBe(false);
    expect(await allowed('recruiter', 'recruitment:configure')).toBe(true);
    // The UK HR manager still reaches the UK entity only.
    const ukHr = await subject('ukHr');
    expect(can(ukHr, 'employees:read', { legalEntityId: uk }).allowed).toBe(true);
    expect(can(ukHr, 'employees:read', { legalEntityId: t.legalEntityId }).allowed).toBe(false);
    // The auditor reads the audit trail and settings, and changes nothing.
    expect(await allowed('auditor', 'audit:read')).toBe(true);
    expect(await allowed('auditor', 'tenant:manage')).toBe(false);
    expect((await subject('auditor')).grants.filter((g) => g.roleKey === 'hr_workspace').every((g) => permissionAction(getPermission(g.permission)!) === 'view')).toBe(true);
    // The custom role became HR Workspace with exactly its one permission.
    expect(await allowed('planner', 'shifts:manage')).toBe(true);
    expect(await allowed('planner', 'leave:approve')).toBe(false);
    // A manager approves for the people reporting to them; someone nobody reports to has their own records only.
    const mgr = await subject('manager');
    expect(can(mgr, 'leave:approve', { membershipId: people.report.membershipId }).allowed).toBe(true);
    expect(await allowed('plain', 'leave:approve')).toBe(false);
    expect(await allowed('plain', 'leave:request')).toBe(true);
  });

  it('moves approval chains, waiting steps and field rules to the levels', async () => {
    const policy = (await pool.one('approval_policies', { tenant_id: t.id, resource_type: 'leave_request' }))!;
    expect(policy.steps).toEqual([{ type: 'manager' }, { type: 'role', role: 'hr_workspace' }]);
    const field = (await pool.one('custom_fields', { tenant_id: t.id, key: 'blood_group' }))!;
    expect(field.view_roles).toEqual(['hr_workspace', 'super_workspace']);
    expect(field.edit_roles).toEqual(['hr_workspace']);
  });

  it('is safe to run again, and old roles given later give nothing', async () => {
    const before = await pool.count('access_level_migrations', { tenant_id: t.id });
    await pool.platform((tx) => mongo.applyAccessLevelsMongo(tx as never));
    expect(await pool.count('access_level_migrations', { tenant_id: t.id })).toBe(before);
    // Someone writing an old role straight into the database gets nothing from it.
    const hrAdmin = (await pool.one('roles', { tenant_id: t.id, key: 'hr_admin' }))!;
    await pool.insert('role_assignments', { tenant_id: t.id, membership_id: people.plain.membershipId, role_id: hrAdmin.id, constraints: {} });
    expect(await allowed('plain', 'employees:update')).toBe(false);
    await pool.delete('role_assignments', { membership_id: people.plain.membershipId, role_id: hrAdmin.id });
  });

  it('shows and changes workspace access through the API, with the same guards as before', async () => {
    const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const list = await api(app, owner).get('/members?limit=100');
    expect(list.status).toBe(200);
    const row = (id: string) => list.body.items.find((m: { id: string }) => m.id === id);
    expect(row(people.recruiter.membershipId).access).toMatchObject({ level: 'hr', label: 'HR Workspace' });
    expect(row(people.owner.membershipId).access).toMatchObject({ level: 'super', label: 'Super Workspace' });
    expect(row(people.plain.membershipId).access).toMatchObject({ level: 'employee', label: 'Employee Workspace' });
    // Only the access levels are shown as roles.
    expect(list.body.items.flatMap((m: { roles: { key: string }[] }) => m.roles.map((r) => r.key)).every((k: string) => ['super_workspace', 'hr_workspace', 'employee_workspace'].includes(k))).toBe(true);
    const roles = await api(app, owner).get('/roles');
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(['super_workspace', 'hr_workspace', 'employee_workspace']);

    // Give Pat HR Workspace for Leave and Attendance only, view-only for People.
    const set = await api(app, owner).put(`/members/${people.plain.membershipId}/access`).send({ level: 'hr', areas: ['Leave', 'Attendance'], viewAreas: ['People'] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.access).toMatchObject({ level: 'hr', areas: ['Leave', 'Attendance'], viewAreas: ['People'] });
    expect(await allowed('plain', 'leave:approve')).toBe(true);
    expect(await allowed('plain', 'employees:read')).toBe(true);
    expect(await allowed('plain', 'employees:update')).toBe(false);
    expect(await allowed('plain', 'payroll:run')).toBe(false);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'membership.access_changed', resource_id: people.plain.membershipId })).toBe(1);
    // Unknown areas are refused.
    expect((await api(app, owner).put(`/members/${people.plain.membershipId}/access`).send({ level: 'hr', areas: ['Spaceships'] })).status).toBe(422);

    // HR Workspace cannot give Super Workspace, nor change anyone's level.
    const hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    expect((await api(app, hr).put(`/members/${people.plain.membershipId}/access`).send({ level: 'super' })).status).toBe(403);
    // The last Super Workspace person cannot be moved off it, and nobody moves themself off it.
    const coOwner = (await loginWithMfa(app, pool, people.coOwner.email)).accessToken;
    expect((await api(app, coOwner).put(`/members/${people.owner.membershipId}/access`).send({ level: 'employee' })).status).toBe(200);
    expect((await api(app, coOwner).put(`/members/${people.coOwner.membershipId}/access`).send({ level: 'employee' })).body.error.code).toBe('cannot_demote_self');
    expect((await api(app, coOwner).put(`/members/${people.owner.membershipId}/access`).send({ level: 'super' })).status).toBe(200);

    // The old role API still works: the roles sent map to the level they became.
    const viaRoles = await api(app, owner).put(`/members/${people.plain.membershipId}/roles`).send({ assignments: [{ roleKey: 'employee' }, { roleKey: 'payroll_admin' }] });
    expect(viaRoles.status, JSON.stringify(viaRoles.body)).toBe(200);
    expect(viaRoles.body.access.level).toBe('hr');
    expect(await allowed('plain', 'payroll:run')).toBe(true);
    expect(await allowed('plain', 'leave:approve')).toBe(false);

    // A person invited with HR Workspace access signs in with it.
    const invited = await api(app, owner).post('/members/invite').send({ email: `inv.${Date.now()}@example.test`, fullName: 'Ivy Invite', access: { level: 'hr', areas: ['Recruitment'] } });
    expect(invited.status, JSON.stringify(invited.body)).toBe(201);
    expect(invited.body.member.access).toMatchObject({ level: 'hr', areas: ['Recruitment'] });
    // Custom roles cannot be made any more.
    expect((await api(app, owner).post('/roles').send({ key: 'custom_y', name: 'Y', grants: [{ permission: 'org:read', scope: 'tenant' }] })).body.error.code).toBe('access_levels_only');
    expect((await login(app, people.recruiter.email)).accessToken).toBeTruthy();
  });

  it('can be rolled back to the old roles', async () => {
    const other = await createTenant(pool);
    const hrRole = (await pool.one('roles', { tenant_id: other.id, key: 'hr_admin' }))!;
    const m = await pool.platform(async (tx) => {
      const u = await tx.collection('users').insert({ email: `rb.${Date.now()}@example.test`, full_name: 'Rob Back' });
      return tx.collection('memberships').insert({ tenant_id: other.id, user_id: u.id, status: 'active', legal_entity_id: other.legalEntityId, joined_at: new Date() });
    });
    await pool.insert('role_assignments', { tenant_id: other.id, membership_id: m.id, role_id: hrRole.id, constraints: {} });
    await pool.platform((tx) => mongo.applyAccessLevelsMongo(tx as never));
    const keysOf = async () => {
      const ras = await pool.find('role_assignments', { membership_id: m.id });
      return (await pool.find('roles', { id: { $in: ras.map((x) => x.role_id) } })).map((r) => r.key).sort();
    };
    expect(await keysOf()).toEqual(['employee_workspace', 'hr_workspace']);
    const r = await pool.platform((tx) => mongo.rollbackAccessLevelsMongo(tx as never, other.id));
    expect(r.restored).toBeGreaterThan(0);
    expect(await keysOf()).toEqual(['hr_admin']);
  });
});
