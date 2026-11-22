import type { INestApplication } from '@nestjs/common';
import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * Plan-based workspace limits, end to end through the API:
 * Console sets plan limits -> company subscribes -> limits carried forward -> Super Workspace creation validated ->
 * Console raises the plan / company upgrades -> new limits apply at once, and nothing is ever deleted.
 */
describe('Plan-based workspace limits (HR Workspaces and Employee Workspaces)', () => {
  let app: INestApplication;
  let pool: TestDb;
  let consoleToken: string;
  let t: TestTenant;
  let owner: string;
  const stamp = Date.now().toString(36);
  const basic = `wl_basic_${stamp}`;
  const pro = `wl_pro_${stamp}`;
  let modules: string[];

  const setLimits = (plan: string, limits: Record<string, number>) => api(app, consoleToken).put(`/platform/plans/${plan}/entitlements`).send({ features: modules, limits });
  const limits = async (token = owner) => {
    const r = await api(app, token).get('/workspace-limits');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const createHr = (name: string, token = owner) => api(app, token).post('/hr-workspaces').send({ name, kind: 'branch', features: [], adminMembershipIds: [] });
  const invite = (token = owner) => api(app, token).post('/members/invite').send({ email: `p.${Math.random().toString(36).slice(2, 9)}@${t.slug}.test`, fullName: 'New Person', roleKeys: ['employee'] });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    const email = `wl.${stamp}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Admin', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
    // Two self-serve plans copied from Business, so every module the Super Workspace needs is in them.
    for (const [key, name] of [[basic, 'WL Basic'], [pro, 'WL Pro']] as const) {
      const c = await api(app, consoleToken).post('/platform/plans').send({ key, name, copyFrom: 'business', isPublic: true, minimumSeats: 1 });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
    }
    modules = ((await pool.find('plan_features', { plan_id: (await pool.one('plans', { key: basic }))!.id })) as { feature_key: string; limit_value?: number | null }[])
      .filter((r) => r.limit_value === null || r.limit_value === undefined).map((r) => r.feature_key);
    expect((await setLimits(basic, { max_hr_workspaces: 2, max_employee_workspaces: 3, max_employees: -1 })).status).toBe(200);
    expect((await setLimits(pro, { max_hr_workspaces: 4, max_employee_workspaces: 6, max_employees: -1 })).status).toBe(200);
    t = await createTenant(pool, { plan: basic });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('carries the plan limits to the company without it entering anything: Used / Maximum', async () => {
    const l = await limits();
    expect(l.plan).toMatchObject({ key: basic, name: 'WL Basic' });
    expect(l.hr).toMatchObject({ used: 0, limit: 2, remaining: 2, reached: false, text: '0 / 2' });
    // The owner's own sign-in account is one Employee Workspace.
    expect(l.employee).toMatchObject({ used: 1, limit: 3, remaining: 2, reached: false, text: '1 / 3' });
    expect(l.sources.hr).toEqual({ plan: 2, addons: 0, override: null });
    expect(l.upgrade.canManageBilling).toBe(true);
    expect(l.upgrade.plans.map((p: { key: string }) => p.key)).toContain(pro);
    // The same figures in the Console.
    const c = await api(app, consoleToken).get(`/platform/tenants/${t.id}/workspace-limits`);
    expect(c.status).toBe(200);
    expect(c.body.hr.text).toBe('0 / 2');
    expect(c.body.employee.text).toBe('1 / 3');
    // Plan & billing usage lists them too.
    const usage = (await api(app, owner).get('/billing/usage')).body as { key: string; used: number; limit: number }[];
    expect(usage.find((m) => m.key === 'max_hr_workspaces')).toMatchObject({ used: 0, limit: 2 });
    expect(usage.find((m) => m.key === 'max_employee_workspaces')).toMatchObject({ used: 1, limit: 3 });
  });

  it('allows HR Workspaces while Current < Allowed and blocks the next one with a clear message', async () => {
    expect((await createHr('North')).status).toBe(201);
    expect((await limits()).hr.text).toBe('1 / 2');
    expect((await createHr('South')).status).toBe(201);
    const l = await limits();
    expect(l.hr).toMatchObject({ used: 2, limit: 2, remaining: 0, reached: true, text: '2 / 2' });
    const third = await createHr('East');
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe('workspace_limit_reached');
    expect(third.body.error.message).toMatch(/HR Workspaces limit reached: your plan allows 2 HR Workspaces and all 2 are in use/);
    expect(third.body.error.details).toMatchObject({ kind: 'hr', used: 2, limit: 2 });
    expect(await pool.count('hr_workspaces', { tenant_id: t.id })).toBe(2);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'workspace_limit.reached' })).toBe(1);
  });

  it('tracks Employee Workspaces separately: logins are limited, employee records without a login are not', async () => {
    expect((await invite()).status).toBe(201);
    expect((await invite()).status).toBe(201);
    expect((await limits()).employee.text).toBe('3 / 3');
    const over = await invite();
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe('workspace_limit_reached');
    expect(over.body.error.message).toMatch(/Employee Workspaces limit reached: your plan allows 3 Employee Workspaces/);
    // A hire with a login is refused as a whole (no half-made employee); without a login it goes ahead.
    const hire = (loginMode: string, last: string) => api(app, owner).post('/employees').send({
      firstName: 'Lim', lastName: last, legalEntityId: t.legalEntityId, dateOfJoining: new Date().toISOString().slice(0, 10), probationMonths: 0, onboardingTemplateId: null,
      loginMode, workEmail: `lim.${last.toLowerCase()}@${t.slug}.test`,
    });
    const before = await pool.count('employees', { tenant_id: t.id });
    const withLogin = await hire('password', 'Login');
    expect(withLogin.status, JSON.stringify(withLogin.body)).toBe(402);
    expect(withLogin.body.error.code).toBe('workspace_limit_reached');
    expect(await pool.count('employees', { tenant_id: t.id })).toBe(before);
    const recordOnly = await hire('none', 'Record');
    expect(recordOnly.status, JSON.stringify(recordOnly.body)).toBe(201);
    // The HR Workspace limit is independent: still 2 / 2, not affected by logins.
    expect((await limits()).hr.text).toBe('2 / 2');
  });

  it('cannot be bypassed: the database refuses a write beyond the limit, whatever code makes it', async () => {
    await expect(pool.insert('hr_workspaces', { tenant_id: t.id, name: 'Sneaky', kind: 'branch', features: [], status: 'active', version: 1 })).rejects.toMatchObject({ code: 'P0402' });
    const u = await pool.insert('users', { email: `sneaky.${stamp}@${t.slug}.test`, full_name: 'Sneaky Login' });
    await expect(pool.insert('memberships', { tenant_id: t.id, user_id: u.id, status: 'active' })).rejects.toMatchObject({ code: 'P0402' });
    expect(await pool.count('hr_workspaces', { tenant_id: t.id })).toBe(2);
    expect(await pool.count('memberships', { tenant_id: t.id, status: { $ne: 'suspended' } })).toBe(3);
    // A suspended login coming back counts too.
    const m = await addMember(pool, t).catch((e: { code?: string }) => e);
    expect((m as { code?: string }).code).toBe('P0402');
  });

  it('lets concurrent creations through only up to the limit', async () => {
    expect((await setLimits(basic, { max_hr_workspaces: 3 })).status).toBe(200);
    const results = await Promise.all(['R1', 'R2', 'R3', 'R4'].map((n) => createHr(`Race ${n}`)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 402)).toHaveLength(3);
    expect(await pool.count('hr_workspaces', { tenant_id: t.id, archived_at: null })).toBe(3);
  });

  it('applies a raised plan limit at once to every company on the plan', async () => {
    const r = await setLimits(basic, { max_hr_workspaces: 5, max_employee_workspaces: 5 });
    expect(r.status).toBe(200);
    expect(r.body.overLimit).toEqual([]);
    const l = await limits();
    expect(l.hr.text).toBe('3 / 5');
    expect(l.employee.text).toBe('3 / 5');
    expect((await createHr('West')).status).toBe(201);
    expect((await invite()).status).toBe(201);
    expect((await limits()).employee.text).toBe('4 / 5');
  });

  it('never deletes workspaces when a limit is lowered: the company keeps them and cannot add more', async () => {
    const r = await setLimits(basic, { max_hr_workspaces: 2, max_employee_workspaces: 2 });
    expect(r.status).toBe(200);
    expect(r.body.overLimit).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'hr', used: 4, limit: 2 }),
      expect.objectContaining({ kind: 'employee', used: 4, limit: 2 }),
    ]));
    expect(await pool.count('hr_workspaces', { tenant_id: t.id, archived_at: null })).toBe(4);
    const l = await limits();
    expect(l.hr).toMatchObject({ used: 4, limit: 2, reached: true, over: true, remaining: 0 });
    expect((await createHr('Too many')).status).toBe(402);
    expect((await invite()).status).toBe(402);
    // A plan must keep one Employee Workspace for the Super Workspace's own sign-in.
    expect((await setLimits(basic, { max_employee_workspaces: 0 })).status).toBe(422);
  });

  it('frees a place when a login is suspended, and refuses to bring it back while the limit is full', async () => {
    await setLimits(basic, { max_hr_workspaces: 4, max_employee_workspaces: 4 });
    const invited = (await pool.find('memberships', { tenant_id: t.id, status: 'invited' }))[0]!;
    const member = await pool.platform(async (tx) => {
      // Accepting is not needed: turn one invited place into an active login to suspend it.
      await tx.collection('memberships').updateOne({ id: invited.id }, { $set: { status: 'active' } });
      return invited.id as string;
    });
    expect((await api(app, owner).patch(`/members/${member}`).send({ status: 'suspended' })).status).toBe(200);
    expect((await limits()).employee.text).toBe('3 / 4');
    expect((await invite()).status).toBe(201);
    const back = await api(app, owner).patch(`/members/${member}`).send({ status: 'active' });
    expect(back.status).toBe(402);
    expect(back.body.error.code).toBe('workspace_limit_reached');
    expect((await pool.one('memberships', { id: member }))!.status).toBe('suspended');
  });

  it('blocks a downgrade the current workspaces do not fit, and an upgrade gives the new capacity at once', async () => {
    expect((await setLimits(basic, { max_hr_workspaces: 2 })).status).toBe(200);
    const up = await api(app, owner).put('/billing/subscription').send({ planKey: pro, billingCycle: 'monthly', seats: 50 });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const l = await limits();
    expect(l.plan.key).toBe(pro);
    expect(l.hr).toMatchObject({ used: 4, limit: 4, reached: true });
    expect(l.employee).toMatchObject({ used: 4, limit: 6, remaining: 2 });
    // Existing workspaces are intact; only the extra capacity is new.
    expect(await pool.count('hr_workspaces', { tenant_id: t.id, archived_at: null })).toBe(4);
    expect((await invite()).status).toBe(201);
    // Going back to basic (2 HR Workspaces) is refused while 4 are in use.
    const back = await api(app, owner).put('/billing/subscription').send({ planKey: basic, billingCycle: 'monthly', seats: 50 });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe('downgrade_blocked');
    expect(back.body.error.message).toMatch(/You have 4 HR Workspaces; WL Basic allows 2/);
  });

  it('adds capacity from a limit add-on and from a per-company figure, and the database guard agrees', async () => {
    const key = `more_hr_${stamp}`;
    const a = await api(app, consoleToken).post('/platform/billing/addons').send({ key, name: '2 more HR Workspaces', kind: 'limit', featureKey: 'max_hr_workspaces', unitQuantity: 2, prices: [{ currency: 'INR', monthly: '500', annualPerMonth: '400' }] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect((await limits()).upgrade.addons).toEqual(expect.arrayContaining([expect.objectContaining({ key, kind: 'hr', unitQuantity: 2 })]));
    const bought = await api(app, owner).post('/billing/addons').send({ addonKey: key, quantity: 1 });
    expect(bought.status, JSON.stringify(bought.body)).toBe(201);
    let l = await limits();
    expect(l.hr).toMatchObject({ used: 4, limit: 6, remaining: 2 });
    expect(l.sources.hr).toEqual({ plan: 4, addons: 2, override: null });
    const db = await pool.database();
    expect((await mongo.workspaceLimitFor(db, undefined, t.id, 'hr')).limit).toBe(6);
    expect((await createHr('Add-on North')).status).toBe(201);

    // SAMPLEDGE agreed a figure with this company: it replaces plan + add-ons, for this company only.
    const overrides = ((await pool.one('subscriptions', { tenant_id: t.id }))!.feature_overrides ?? {}) as Record<string, unknown>;
    await pool.update('subscriptions', { tenant_id: t.id }, { $set: { feature_overrides: { ...overrides, max_hr_workspaces: 5 } } });
    l = await limits();
    expect(l.hr).toMatchObject({ used: 5, limit: 5, reached: true });
    expect((await mongo.workspaceLimitFor(db, undefined, t.id, 'hr')).limit).toBe(5);
    expect((await createHr('Over override')).status).toBe(402);
    await pool.update('subscriptions', { tenant_id: t.id }, { $set: { feature_overrides: overrides } });
  });

  it('shows the figures only to those who create workspaces or logins, or look after billing', async () => {
    const plain = await addMember(pool, t);
    const token = (await loginWithMfa(app, pool, plain.email)).accessToken;
    expect((await api(app, token).get('/workspace-limits')).status).toBe(403);
    // Employee Workspace people cannot create HR Workspaces either.
    expect((await createHr('Not mine', token)).status).toBe(403);
  });

  it('keeps companies on the built-in plans working: the catalogue gives each plan its Employee Workspaces', async () => {
    const starter = (await pool.one('plans', { key: 'starter' }))!;
    const rows = await pool.find('plan_features', { plan_id: starter.id, feature_key: { $in: ['max_hr_workspaces', 'max_employee_workspaces'] } });
    expect(Object.fromEntries(rows.map((r) => [r.feature_key, r.limit_value]))).toEqual({ max_hr_workspaces: 2, max_employee_workspaces: 100 });
  });
});
