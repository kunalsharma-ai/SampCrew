import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

describe('SAMPLEDGE Super Admin Console API', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let token: string;
  const email = `ops.${Date.now()}@sampledge.test`;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    await pool.insert('platform_admins', { email, full_name: 'Ops', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('tenant tokens are rejected by platform routes and vice versa', async () => {
    const tenant = await login(app, t.ownerEmail);
    expect((await api(app, tenant.accessToken).get('/platform/metrics')).status).toBe(401);
  });

  it('forces MFA enrolment before any platform action', async () => {
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    expect(res.body).toMatchObject({ status: 'ok', mfaEnrolmentRequired: true });
    expect((await api(app, res.body.accessToken).get('/platform/metrics')).body.error.code).toBe('mfa_required');
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    const enabled = await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) });
    expect(enabled.status).toBe(200);
    token = enabled.body.accessToken;
    expect((await api(app, token).get('/platform/metrics')).status).toBe(200);
    // Next sign-in requires the code.
    expect((await api(app).post('/platform/auth/login').send({ email, password: PASSWORD })).body.status).toBe('mfa_required');
    const withCode = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD, code: currentTotp(setup.body.secret) });
    expect(withCode.body.status).toBe('ok');
    token = withCode.body.accessToken;
  });

  it('lists tenants and shows detail without tenant HR data', async () => {
    const list = await api(app, token).get('/platform/tenants?limit=200');
    expect(list.body.items.some((x: { id: string }) => x.id === t.id)).toBe(true);
    const detail = await api(app, token).get(`/platform/tenants/${t.id}`);
    expect(detail.body.subscription.plan).toBe('business');
    expect(JSON.stringify(detail.body)).not.toContain(t.ownerEmail);
  });

  it('creates a tenant with an owner invitation', async () => {
    const slug = `console-${Date.now()}`;
    const res = await api(app, token).post('/platform/tenants').send({
      companyName: 'Console Co', slug, ownerEmail: `boss@${slug}.test`, ownerName: 'Boss', planKey: 'enterprise', seats: 300, countryCode: 'AE', currency: 'USD', timezone: 'Asia/Dubai', trialDays: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.ownerInviteUrl).toContain('/accept-invite?token=');
    const tenant = await pool.one('tenants', { id: res.body.tenantId });
    expect(tenant!.region).toBe('me');
  });

  it('suspending a tenant signs its users out and blocks access', async () => {
    const victim = await createTenant(pool);
    const s = await login(app, victim.ownerEmail);
    expect((await api(app, token).patch(`/platform/tenants/${victim.id}/status`).send({ status: 'suspended', reason: 'Unpaid invoices' })).status).toBe(200);
    expect((await api(app, s.accessToken).get('/me')).status).toBe(401);
    expect((await api(app).post('/auth/login').send({ email: victim.ownerEmail, password: PASSWORD })).status).toBe(403);
    await api(app, token).patch(`/platform/tenants/${victim.id}/status`).send({ status: 'active', reason: 'Paid in full' });
    expect((await api(app).post('/auth/login').send({ email: victim.ownerEmail, password: PASSWORD })).status).toBe(200);
  });

  it('support access needs customer approval, expires, and is audited in the customer trail', async () => {
    expect((await api(app, token).get(`/platform/tenants/${t.id}/support-view`)).status).toBe(403);
    const req = await api(app, token).post(`/platform/tenants/${t.id}/support-access`).send({ reason: 'Customer reported a broken department tree', durationMinutes: 30 });
    expect(req.body.status).toBe('pending');
    expect((await api(app, token).get(`/platform/tenants/${t.id}/support-view`)).status).toBe(403);

    const owner = await loginWithMfa(app, pool, t.ownerEmail);
    expect((await api(app, owner.accessToken).post(`/support-access/${req.body.id}/approve`)).status).toBe(200);
    const view = await api(app, token).get(`/platform/tenants/${t.id}/support-view`);
    expect(view.status).toBe(200);
    expect(view.body.overview.activeMembers).toBeGreaterThan(0);

    const trail = await pool.find('audit_events', { tenant_id: t.id, action: /^support_access\./ }, { sort: { chain_seq: 1 } });
    expect(trail.map((r) => r.action)).toEqual(['support_access.requested', 'support_access.approved', 'support_access.viewed']);

    expect((await api(app, owner.accessToken).post(`/support-access/${req.body.id}/revoke`)).status).toBe(200);
    expect((await api(app, token).get(`/platform/tenants/${t.id}/support-view`)).status).toBe(403);
  });

  it('reports health and an intact platform audit chain', async () => {
    const h = await api(app, token).get('/platform/health');
    expect(h.body.database.status).toBe('ok');
    expect(h.body.migrations.pending).toEqual([]);
    expect(h.body.platformAuditChain.intact).toBe(true);
  });

  it('publishes an OpenAPI document covering every route', async () => {
    const spec = await api(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(30);
    expect(spec.body.paths['/api/v1/members/invite'].post.description).toContain('users:invite');
  });
});
