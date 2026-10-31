import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, api, createApp, createTenant, login, type TestTenant } from './helpers';

describe('audit trail', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let token: string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    token = (await login(app, t.ownerEmail)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('records changes with a field-level diff in the same transaction', async () => {
    const http = api(app, token);
    const d = await http.post('/org/departments').send({ name: 'Logistics', code: 'LOG' });
    expect(d.status).toBe(201);
    await http.patch(`/org/departments/${d.body.id}`).send({ name: 'Logistics & Supply' });
    const events = await http.get(`/audit-events?resourceId=${d.body.id}`);
    expect(events.body.items.map((e: { action: string }) => e.action)).toEqual(['department.updated', 'department.created']);
    expect(events.body.items[0].changes).toEqual({ name: { from: 'Logistics', to: 'Logistics & Supply' } });
    expect(events.body.items[0].actorLabel).toContain(t.ownerEmail);
  });

  it('does not write an audit event when the change fails', async () => {
    const before = (await pool.query('select count(*)::int as n from audit_events where tenant_id = $1', [t.id])).rows[0].n;
    const res = await api(app, token).post('/org/locations').send({ name: 'Bad', legalEntityId: '00000000-0000-0000-0000-000000000000', timezone: 'Asia/Kolkata', countryCode: 'IN' });
    expect(res.status).toBe(422);
    const after = (await pool.query('select count(*)::int as n from audit_events where tenant_id = $1', [t.id])).rows[0].n;
    expect(after).toBe(before);
  });

  it('is append-only, even for the platform role', async () => {
    await expect(pool.query('update audit_events set action = $1 where tenant_id = $2', ['x.y', t.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_events where tenant_id = $1', [t.id])).rejects.toThrow(/append-only/);
  });

  it('detects tampering through the hash chain', async () => {
    const ok = await api(app, token).get('/audit-events/verify');
    expect(ok.body.intact).toBe(true);
    expect(ok.body.checked).toBeGreaterThan(2);
    // Simulate a DBA editing history behind the application's back.
    await pool.query('alter table audit_events disable trigger audit_events_immutable');
    await pool.query(`update audit_events set changes = '{"name":"forged"}' where tenant_id = $1 and chain_seq = 2`, [t.id]);
    await pool.query('alter table audit_events enable trigger audit_events_immutable');
    const broken = await api(app, token).get('/audit-events/verify');
    expect(broken.body).toMatchObject({ intact: false, firstBrokenSeq: 2 });
  });

  it('redacts secrets from change sets', async () => {
    const { redact } = await import('../src/platform/audit/audit.service');
    expect(redact({ name: 'x', password: 'p', nested: { bank_account_number: '123', ok: 1 } })).toEqual({ name: 'x', password: '[redacted]', nested: { bank_account_number: '[redacted]', ok: 1 } });
  });
});

describe('subscriptions and entitlements', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('gates features by plan', async () => {
    const starter = await createTenant(pool, { plan: 'starter' });
    const { accessToken } = await login(app, starter.ownerEmail);
    const me = await api(app, accessToken).get('/me');
    expect(me.body.features).not.toContain('custom_roles');
    expect(me.body.limits.max_legal_entities).toBe(1);
    // Owner sessions lack MFA here, so use a role-free endpoint guarded only by the feature: entity limit.
    const res = await api(app, accessToken).post('/org/legal-entities').send({ name: 'Second Co', countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('plan_limit_reached');
  });

  it('blocks a downgrade that current usage does not fit, and allows an upgrade', async () => {
    const t = await createTenant(pool, { plan: 'business' });
    await pool.query(`insert into legal_entities (tenant_id, name, country_code, currency, timezone) values ($1, 'Second', 'IN', 'INR', 'Asia/Kolkata')`, [t.id]);
    // billing:manage requires MFA: mark the session as MFA-verified for this test.
    const s = await login(app, t.ownerEmail);
    await pool.query(`update sessions set mfa_verified = true where tenant_id = $1`, [t.id]);
    const refreshed = await api(app).post('/auth/refresh').send({ refreshToken: s.refreshToken });
    const http = api(app, refreshed.body.accessToken);
    const down = await http.put('/billing/subscription').send({ planKey: 'starter', billingCycle: 'monthly', seats: 10 });
    expect(down.status).toBe(409);
    expect(down.body.error.code).toBe('downgrade_blocked');
    const up = await http.put('/billing/subscription').send({ planKey: 'business', billingCycle: 'annual', seats: 60 });
    expect(up.status).toBe(200);
    const sub = await http.get('/billing/subscription');
    expect(sub.body.subscription).toMatchObject({ planKey: 'business', billingCycle: 'annual', seats: 60, unitPrice: '399.00' });
    expect(sub.body.paymentProvider.connected).toBe(false);
  });

  it('honours platform feature overrides', async () => {
    const t = await createTenant(pool, { plan: 'starter' });
    await pool.query(`update subscriptions set feature_overrides = '{"recruitment": true, "max_legal_entities": 3}' where tenant_id = $1`, [t.id]);
    const { accessToken } = await login(app, t.ownerEmail);
    const me = await api(app, accessToken).get('/me');
    expect(me.body.features).toContain('recruitment');
    expect(me.body.limits.max_legal_entities).toBe(3);
  });
});

describe('idempotency', () => {
  let app: INestApplication;
  let pool: Pool;
  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('replays the first response for a retried request and rejects key reuse with a different body', async () => {
    const t = await createTenant(pool);
    const { accessToken } = await login(app, t.ownerEmail);
    const send = (body: object) => api(app, accessToken).post('/org/business-units').set('idempotency-key', 'retry-key-0001').send(body);
    const first = await send({ name: 'Retail' });
    const second = await send({ name: 'Retail' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    const count = await pool.query(`select count(*)::int as n from business_units where tenant_id = $1 and name = 'Retail'`, [t.id]);
    expect(count.rows[0].n).toBe(1);
    expect((await send({ name: 'Different' })).status).toBe(409);
  });
});
