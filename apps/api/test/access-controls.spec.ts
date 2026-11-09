import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestTenant, type TestDb } from './helpers';

/** Super Admin Console switches: modules and permissions per workspace, modules per member, all enforced by the API. */
describe('Workspace access controls', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let superToken: string;
  let viewerToken: string;
  let member: { email: string; membershipId: string };
  const stamp = Date.now();

  async function platformToken(role: string) {
    const email = `${role}.${stamp}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: role, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    other = await createTenant(pool, { plan: 'business' });
    member = await addMember(pool, t, { roles: ['recruiter'], name: 'Rita Recruiter' });
    superToken = await platformToken('super_admin');
    viewerToken = await platformToken('viewer');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('shows plan defaults for every module and permission', async () => {
    const res = await api(app, superToken).get(`/platform/tenants/${t.id}/access`);
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ key: 'business' });
    const payroll = res.body.features.find((f: { key: string }) => f.key === 'payroll');
    expect(payroll).toMatchObject({ inPlan: true, override: null, effective: true });
    expect(res.body.features.find((f: { key: string }) => f.key === 'sso')).toMatchObject({ inPlan: false, effective: false });
    expect(res.body.features.find((f: { key: string }) => f.key === 'core_hr')).toMatchObject({ core: true, effective: true });
    expect(res.body.permissions.every((p: { enabled: boolean }) => p.enabled)).toBe(true);
    expect(res.body.permissions.find((p: { key: string }) => p.key === 'payroll:run')).toMatchObject({ feature: 'payroll', featureOn: true });
  });

  it('only Super admins can change switches; viewers can read them', async () => {
    expect((await api(app, viewerToken).get(`/platform/tenants/${t.id}/access`)).status).toBe(200);
    expect((await api(app, viewerToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'payroll', state: 'off' }] })).status).toBe(403);
    expect((await api(app, viewerToken).put(`/platform/tenants/${t.id}/access/permissions`).send({ changes: [{ key: 'leave:approve', enabled: false }] })).status).toBe(403);
    expect((await api(app, viewerToken).get(`/platform/tenants/${t.id}/access/members`)).status).toBe(403);
    const owner = await login(app, t.ownerEmail);
    expect((await api(app, owner.accessToken).get(`/platform/tenants/${t.id}/access`)).status).toBe(401);
  });

  it('refuses unknown modules and switching off Core HR', async () => {
    expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'core_hr', state: 'off' }] })).status).toBe(422);
    expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'nope', state: 'off' }] })).status).toBe(422);
    expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/permissions`).send({ changes: [{ key: 'nope:x', enabled: false }] })).status).toBe(422);
  });

  it('a module switched off disappears from /me and its API is closed, then comes back', async () => {
    const owner = await loginWithMfa(app, pool, t.ownerEmail);
    expect((await api(app, owner.accessToken).get('/staffing/bids')).status).toBe(200);
    const off = await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'staffing_bids', state: 'off' }, { key: 'crew_iq', state: 'off' }] });
    expect(off.status).toBe(200);
    expect(off.body.features.find((f: { key: string }) => f.key === 'staffing_bids')).toMatchObject({ override: false, effective: false });

    const me = (await api(app, owner.accessToken).get('/me')).body;
    expect(me.features).not.toContain('staffing_bids');
    expect(me.featureBlocks).toMatchObject({ staffing_bids: 'workspace_off', crew_iq: 'workspace_off' });
    const closed = await api(app, owner.accessToken).get('/staffing/bids');
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('feature_disabled');
    expect((await api(app, owner.accessToken).post('/iq/ask').send({ question: 'how many approvals do I have' })).body.error.code).toBe('feature_disabled');
    // Another workspace is untouched.
    const o = await login(app, other.ownerEmail);
    expect((await api(app, o.accessToken).get('/me')).body.features).toContain('staffing_bids');

    await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'staffing_bids', state: 'plan' }, { key: 'crew_iq', state: 'plan' }] });
    expect((await api(app, owner.accessToken).get('/staffing/bids')).status).toBe(200);
  });

  it('a module outside the plan can be switched on', async () => {
    const owner = await login(app, t.ownerEmail);
    expect((await api(app, owner.accessToken).get('/me')).body.features).not.toContain('sso');
    await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'sso', state: 'on' }] });
    expect((await api(app, owner.accessToken).get('/me')).body.features).toContain('sso');
    await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'sso', state: 'plan' }] });
  });

  it('a permission switched off is removed from every role, including the owner, until switched back on', async () => {
    const owner = await loginWithMfa(app, pool, t.ownerEmail);
    expect((await api(app, owner.accessToken).get('/me')).body.permissions['leave:configure']).toBe('tenant');
    expect((await api(app, owner.accessToken).get('/leave/types')).status).toBe(200);

    const res = await api(app, superToken).put(`/platform/tenants/${t.id}/access/permissions`).send({ changes: [{ key: 'leave:configure', enabled: false }, { key: 'audit:read', enabled: false }] });
    expect(res.status).toBe(200);
    expect(res.body.permissions.find((p: { key: string }) => p.key === 'leave:configure')).toMatchObject({ enabled: false });

    const me = (await api(app, owner.accessToken).get('/me')).body;
    expect(me.permissions['leave:configure']).toBeUndefined();
    expect(me.disabledPermissions).toEqual(['audit:read', 'leave:configure']);
    expect((await api(app, owner.accessToken).post('/leave/types').send({ code: 'XX', name: 'Blocked' })).status).toBe(403);
    expect((await api(app, owner.accessToken).get('/audit-events')).status).toBe(403);
    // Other workspace keeps it.
    const o = await login(app, other.ownerEmail);
    expect((await api(app, o.accessToken).get('/me')).body.permissions['leave:configure']).toBe('tenant');

    await api(app, superToken).put(`/platform/tenants/${t.id}/access/permissions`).send({ changes: [{ key: 'leave:configure', enabled: true }, { key: 'audit:read', enabled: true }] });
    expect((await api(app, owner.accessToken).get('/me')).body.permissions['leave:configure']).toBe('tenant');
  });

  it('the workspace cannot change its own switches from the database role it uses', async () => {
    // crew_app (all customer traffic) can read the controls but never write them.
    await expect(pool.tenant(t.id, (tx) => tx.collection('tenant_access_controls').update({ tenant_id: t.id }, { $set: { disabled_permissions: [] } }))).rejects.toThrow(/not allowed/);
    await expect(pool.tenant(t.id, (tx) => tx.collection('tenant_access_controls').delete({ tenant_id: t.id }))).rejects.toThrow(/not allowed/);
  });

  it('per-member module access: one person loses a module, others keep it', async () => {
    const list = await api(app, superToken).get(`/platform/tenants/${t.id}/access/members?q=Rita`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({ email: member.email, blockedFeatures: [] });
    expect(list.body.items[0].roles).toContain('Recruiter');

    const rita = await login(app, member.email);
    expect((await api(app, rita.accessToken).get('/recruitment/requisitions')).status).toBe(200);

    const set = await api(app, superToken).put(`/platform/tenants/${t.id}/access/members/${member.membershipId}`).send({ blockedFeatures: ['recruitment', 'leave', 'recruitment'] });
    expect(set.status).toBe(200);
    expect(set.body.blockedFeatures).toEqual(['leave', 'recruitment']);

    const me = (await api(app, rita.accessToken).get('/me')).body;
    expect(me.features).not.toContain('recruitment');
    expect(me.featureBlocks).toMatchObject({ recruitment: 'member_blocked', leave: 'member_blocked' });
    const res = await api(app, rita.accessToken).get('/recruitment/requisitions');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('feature_not_for_member');
    expect((await api(app, rita.accessToken).get('/leave/balances')).body.error.code).toBe('feature_not_for_member');

    // The owner is not affected.
    const owner = await login(app, t.ownerEmail);
    expect((await api(app, owner.accessToken).get('/me')).body.features).toContain('recruitment');

    const access = await api(app, superToken).get(`/platform/tenants/${t.id}/access`);
    expect(access.body.features.find((f: { key: string }) => f.key === 'recruitment').blockedMembers).toBe(1);

    // Core HR cannot be taken away from a person either; empty restores full access.
    expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/members/${member.membershipId}`).send({ blockedFeatures: ['core_hr'] })).status).toBe(422);
    await api(app, superToken).put(`/platform/tenants/${t.id}/access/members/${member.membershipId}`).send({ blockedFeatures: [] });
    expect((await api(app, rita.accessToken).get('/recruitment/requisitions')).status).toBe(200);
  });

  it('a member of another workspace cannot be targeted', async () => {
    const outsider = await addMember(pool, other);
    expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/members/${outsider.membershipId}`).send({ blockedFeatures: ['leave'] })).status).toBe(404);
  });

  it('every change is in the customer audit trail and the platform audit log', async () => {
    const tenantAudit = await pool.find('audit_events', { tenant_id: t.id, action: /^access\./ }, { sort: { chain_seq: 1 } });
    const actions = tenantAudit.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['access.modules_switched', 'access.permissions_switched', 'access.member_modules_changed']));
    const platformAudit = await pool.count('audit_events', { tenant_id: null, resource_id: t.id, action: /^platform\.access_/ });
    expect(platformAudit).toBeGreaterThanOrEqual(actions.length);
  });
});
