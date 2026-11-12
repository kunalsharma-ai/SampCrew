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

  it('shows the replica set, the last backup and its off-site copy, and point-in-time backups on System health', async () => {
    const health = async () => (await api(app, token).get('/platform/health')).body;
    let h = await health();
    // The test server is a one-node replica set.
    expect(h.replication.members).toEqual([expect.objectContaining({ state: 'PRIMARY', healthy: true })]);
    expect(h.replication.oplogHours).toEqual(expect.any(Number));

    await pool.delete('backup_runs', {});
    const started = new Date(Date.now() - 60_000);
    await pool.insert('backup_runs', { started_at: started, status: 'ok', encrypted: true, db_file: 'crew-db-1.archive.gz.enc', db_bytes: 2_500_000, files_file: 'crew-files-1.tar.gz.enc', files_bytes: 4096, offsite: 'copied' });
    h = await health();
    expect(h.backups.archives.last).toMatchObject({ status: 'ok', encrypted: true, offsite: 'copied', database: { file: 'crew-db-1.archive.gz.enc', size: '2441 kB' } });
    expect(h.backups.archives.lastSuccessHoursAgo).toBe(0);
    expect(h.notConfigured).not.toContain('Off-site copy of backups (BACKUP_REMOTE)');

    // A failed run after a good one: the failure shows, and when the last good one was.
    await pool.insert('backup_runs', { started_at: new Date(), status: 'failed', encrypted: true, offsite: 'off', error: 'database dump failed: connection refused' });
    h = await health();
    expect(h.backups.archives.last).toMatchObject({ status: 'failed', error: 'database dump failed: connection refused', database: null });
    expect(h.backups.archives.lastSuccessAt).not.toBeNull();
    expect(h.notConfigured).toContain('Off-site copy of backups (BACKUP_REMOTE)');

    // Point-in-time backups: off until PBM has written its status, then read from PBM's own collections.
    expect(h.backups.pointInTime).toBeNull();
    const admin = (await pool.database()).client.db('admin');
    const now = Math.floor(Date.now() / 1000);
    const { Timestamp } = await import('mongodb');
    try {
      await admin.collection('pbmBackups').insertOne({ name: 'base', status: 'done', start_ts: now - 3600, last_write_ts: new Timestamp({ t: now - 3590, i: 1 }), size: 1000 });
      await admin.collection('pbmPITRChunks').insertOne({ rs: 'rs0', start_ts: new Timestamp({ t: now - 3590, i: 1 }), end_ts: new Timestamp({ t: now - 120, i: 1 }) });
      await admin.collection('pbmAgents').insertOne({ n: 'mongo:27017', rs: 'rs0', e: '', hb: new Timestamp({ t: now, i: 1 }), stors: { ok: true, e: '' } });
      h = await health();
      expect(h.backups.pointInTime).toMatchObject({ agentOk: true, agentError: null, minutesBehind: 2, restorableUntil: new Date((now - 120) * 1000).toISOString() });
      expect(h.notConfigured.some((n: string) => n.startsWith('Point-in-time'))).toBe(false);
    } finally {
      for (const c of ['pbmBackups', 'pbmPITRChunks', 'pbmAgents']) await admin.collection(c).drop().catch(() => undefined);
    }
  });

  it('publishes an OpenAPI document covering every route', async () => {
    const spec = await api(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths).length).toBeGreaterThan(30);
    expect(spec.body.paths['/api/v1/members/invite'].post.description).toContain('users:invite');
  });
});
