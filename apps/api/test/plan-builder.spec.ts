import type { INestApplication } from '@nestjs/common';
import { syncCatalogue } from '@crew/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestTenant } from './helpers';

/**
 * The plan builder: SAMPLEDGE sets what each plan includes in the Console, and a workspace's subscription decides
 * which modules it can use, enforced by the API on every request.
 */
describe('Plan builder and subscription entitlements', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let buyer: TestTenant;
  let superToken: string;
  let viewerToken: string;
  let owner: string;
  const stamp = Date.now().toString(36);
  const pilot = `pilot_${stamp}`;

  async function platformToken(role: string) {
    const email = `plans.${role}.${stamp}@sampledge.test`;
    await pool.query(`insert into platform_admins (email, full_name, password_hash, role) values ($1, $2, $3, $4)`, [email, `Plans ${role}`, await hashPassword(PASSWORD), role]);
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }
  const plan = async (key: string) => ((await api(app, superToken).get('/platform/plans')).body as { key: string; features: { key: string; limitValue: number | null }[]; [k: string]: unknown }[]).find((p) => p.key === key)!;
  const modules = async (key: string) => (await plan(key)).features.filter((f) => f.limitValue === null).map((f) => f.key);
  const limits = async (key: string) => Object.fromEntries((await plan(key)).features.filter((f) => f.limitValue !== null).map((f) => [f.key, f.limitValue]));

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    buyer = await createTenant(pool, { plan: 'professional' });
    superToken = await platformToken('super_admin');
    viewerToken = await platformToken('viewer');
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('lists every plan with its modules, limits and workspace counts; only plan managers can change them', async () => {
    const res = await api(app, viewerToken).get('/platform/plans');
    expect(res.status).toBe(200);
    const business = res.body.find((p: { key: string }) => p.key === 'business');
    expect(business.features.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['payroll', 'performance', 'learning', 'engagement', 'email_signatures', 'onboarding', 'max_employees']));
    expect(business.tenants).toBeGreaterThan(0);
    expect((await api(app, viewerToken).post('/platform/plans').send({ key: 'nope', name: 'Nope' })).status).toBe(403);
    expect((await api(app, viewerToken).put('/platform/plans/business/entitlements').send({ features: [], limits: {} })).status).toBe(403);
    expect((await api(app, owner).get('/platform/plans')).status).toBe(401);
  });

  it('creates a plan as a copy of another, and refuses a duplicate key', async () => {
    const res = await api(app, superToken).post('/platform/plans').send({ key: pilot, name: 'Pilot', tagline: 'Pilot customers', copyFrom: 'business', isPublic: true });
    expect(res.status).toBe(201);
    expect(await modules(pilot)).toEqual(await modules('business'));
    expect(await limits(pilot)).toEqual(await limits('business'));
    expect((await plan(pilot)).prices).toEqual((await plan('business')).prices);
    expect((await api(app, superToken).post('/platform/plans').send({ key: pilot, name: 'Again' })).status).toBe(409);
    // An empty plan has only the foundation and zero limits.
    const empty = `empty_${stamp}`;
    expect((await api(app, superToken).post('/platform/plans').send({ key: empty, name: 'Empty' })).status).toBe(201);
    expect(await modules(empty)).toEqual(['core_hr']);
    expect(Object.values(await limits(empty)).every((v) => v === 0)).toBe(true);
    expect((await api(app, superToken).delete(`/platform/plans/${empty}`)).status).toBe(204);
  });

  it('a module taken out of the plan closes its API and leaves /me at once; putting it back reopens it', async () => {
    expect((await api(app, superToken).put(`/platform/tenants/${t.id}/subscription`).send({ planKey: pilot })).status).toBe(200);
    for (const path of ['/goals', '/learning/courses', '/signatures/settings', '/onboarding/templates']) expect((await api(app, owner).get(path)).status, path).toBe(200);

    const keep = (await modules(pilot)).filter((k) => !['performance', 'email_signatures', 'onboarding', 'audit_export'].includes(k) && k !== 'core_hr');
    const res = await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features: keep, limits: { max_legal_entities: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ removed: ['audit_export', 'email_signatures', 'onboarding', 'performance'], workspaces: 1 });
    // The foundation is always included, even when it is left out.
    expect(await modules(pilot)).toContain('core_hr');

    const me = (await api(app, owner).get('/me')).body;
    expect(me.features).not.toContain('performance');
    expect(me.features).toContain('learning');
    for (const path of ['/goals', '/signatures/settings', '/onboarding/templates', '/audit-events/export.csv']) {
      const r = await api(app, owner).get(path);
      expect(r.status, path).toBe(402);
      expect(r.body.error.code).toBe('feature_not_in_plan');
    }
    expect((await api(app, owner).get('/learning/courses')).status).toBe(200);
    // The workspace's own audit trail says why.
    const trail = (await api(app, owner).get('/audit-events?action=subscription.plan_contents_changed')).body;
    expect(trail.items[0].changes).toMatchObject({ plan: pilot, removed: expect.arrayContaining(['performance']) });

    expect((await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features: [...keep, 'performance', 'audit_export'], limits: {} })).status).toBe(200);
    expect((await api(app, owner).get('/goals')).status).toBe(200);
    const csv = await api(app, owner).get('/audit-events/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Sequence,When (UTC),Actor type');
    expect(csv.text).toContain('subscription.plan_contents_changed');
  });

  it('refuses unknown modules', async () => {
    const res = await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features: ['not_a_module'], limits: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_feature');
  });

  it('a second legal entity needs the multi-entity module', async () => {
    const entity = { name: `Second ${stamp}`, countryCode: 'GB', currency: 'GBP', timezone: 'Europe/London' };
    const keep = (await modules(pilot)).filter((k) => k !== 'multi_entity');
    await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features: keep, limits: { max_legal_entities: 5 } });
    const blocked = await api(app, owner).post('/org/legal-entities').send(entity);
    expect(blocked.status).toBe(402);
    await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features: [...keep, 'multi_entity'], limits: {} });
    expect((await api(app, owner).post('/org/legal-entities').send(entity)).status).toBe(201);
  });

  it('plan limits set in the builder apply to the workspace', async () => {
    const members = Number((await pool.query(`select count(*) from memberships where tenant_id = $1 and status <> 'suspended'`, [t.id])).rows[0].count);
    const features = await modules(pilot);
    await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features, limits: { max_employees: members } });
    const res = await api(app, owner).post('/members/invite').send({ email: `over.${stamp}@example.test`, fullName: 'Over Limit', roleKeys: ['employee'] });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('plan_limit_reached');
    await api(app, superToken).put(`/platform/plans/${pilot}/entitlements`).send({ features, limits: { max_employees: -1 } });
  });

  it('the deploy-time catalogue sync keeps a plan SAMPLEDGE changed, and resets one it did not', async () => {
    const before = await modules('starter');
    await pool.query(`update plans set customised_at = now() where key = 'starter'`);
    await pool.query(`delete from plan_features where feature_key = 'announcements' and plan_id = (select id from plans where key = 'starter')`);
    await syncCatalogue(pool);
    expect(await modules('starter')).not.toContain('announcements');
    await pool.query(`update plans set customised_at = null where key = 'starter'`);
    await syncCatalogue(pool);
    expect((await modules('starter')).sort()).toEqual(before.sort());
  });

  it('archived plans are not sold; workspaces on them keep them', async () => {
    const archived = await api(app, superToken).post(`/platform/plans/${pilot}/archive`);
    expect(archived.status).toBe(200);
    const buyerOwner = (await loginWithMfa(app, pool, buyer.ownerEmail)).accessToken;
    expect(((await api(app, buyerOwner).get('/billing/plans')).body as { key: string }[]).map((p) => p.key)).not.toContain(pilot);
    const move = await api(app, buyerOwner).put('/billing/subscription').send({ planKey: pilot, billingCycle: 'monthly', seats: 50 });
    expect(move.status).toBe(400);
    expect(move.body.error.code).toBe('plan_not_offered');
    // The workspace on the archived plan still sees it and keeps every module.
    const own = ((await api(app, owner).get('/billing/plans')).body as { key: string; offered: boolean }[]).find((p) => p.key === pilot);
    expect(own).toMatchObject({ offered: false });
    expect((await api(app, owner).get('/goals')).status).toBe(200);
    expect((await api(app, superToken).delete(`/platform/plans/${pilot}`)).status).toBe(409);
    expect((await api(app, superToken).post(`/platform/plans/${pilot}/restore`)).status).toBe(200);
  });

  it('a workspace admin requests a quote-only plan and SAMPLEDGE approves it', async () => {
    const buyerOwner = (await loginWithMfa(app, pool, buyer.ownerEmail)).accessToken;
    expect((await api(app, buyerOwner).post('/billing/plan-requests').send({ planKey: 'business', seats: 50, billingCycle: 'annual' })).body.error.code).toBe('self_serve_plan');
    expect((await api(app, buyerOwner).post('/billing/plan-requests').send({ planKey: 'enterprise', seats: 10, billingCycle: 'annual' })).body.error.code).toBe('seats_below_minimum');
    const sent = await api(app, buyerOwner).post('/billing/plan-requests').send({ planKey: 'enterprise', seats: 300, billingCycle: 'annual', message: 'We need SSO for 300 people' });
    expect(sent.status).toBe(201);
    expect((await api(app, buyerOwner).post('/billing/plan-requests').send({ planKey: 'enterprise', seats: 300, billingCycle: 'annual' })).status).toBe(409);
    expect((await api(app, buyerOwner).get('/security/sso')).status).toBe(402);

    const list = (await api(app, superToken).get('/platform/plan-requests?status=pending')).body as { id: string; tenantId: string; planKey: string; message: string }[];
    const req = list.find((r) => r.tenantId === buyer.id)!;
    expect(req).toMatchObject({ planKey: 'enterprise', message: 'We need SSO for 300 people' });
    expect((await api(app, viewerToken).post(`/platform/plan-requests/${req.id}/decision`).send({ decision: 'approved' })).status).toBe(403);
    expect((await api(app, superToken).post(`/platform/plan-requests/${req.id}/decision`).send({ decision: 'approved', note: 'Welcome aboard' })).status).toBe(200);
    expect((await api(app, superToken).post(`/platform/plan-requests/${req.id}/decision`).send({ decision: 'declined' })).status).toBe(409);

    const sub = (await api(app, buyerOwner).get('/billing/subscription')).body.subscription;
    expect(sub).toMatchObject({ planKey: 'enterprise', seats: 300, billingCycle: 'annual' });
    expect((await api(app, buyerOwner).get('/me')).body.features).toContain('sso');
    const mine = (await api(app, buyerOwner).get('/billing/plan-requests')).body;
    expect(mine[0]).toMatchObject({ status: 'approved', decisionNote: 'Welcome aboard' });
    const notes = (await api(app, buyerOwner).get('/notifications')).body;
    expect(JSON.stringify(notes)).toContain('Enterprise plan');
  });
});
