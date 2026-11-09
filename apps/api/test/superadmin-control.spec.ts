import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { parseDeviceApi } from '../src/modules/attendance/devices.service';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * Phase 16: SAMPLEDGE Super Admin control of a workspace: the Web Portal and mobile app per workspace and per
 * module, the workspace's people (with actions), its activity, its attendance machines, and its subscription.
 */
describe('Super Admin control of workspaces', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let superToken: string;
  let supportToken: string;
  let viewerToken: string;
  let rita: { email: string; membershipId: string; userId: string };
  let pune: string;
  const stamp = Date.now();

  async function platformToken(role: string) {
    const email = `${role}.ctl.${stamp}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: role, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }

  /** Signs in as one app, the way the Web Portal and the mobile app identify themselves. */
  const signIn = (email: string, client: 'web' | 'mobile') =>
    request(app.getHttpServer()).post('/api/v1/auth/login').set('x-crew-client', client).send({ email, password: PASSWORD });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    other = await createTenant(pool, { plan: 'business' });
    rita = await addMember(pool, t, { roles: ['recruiter'], name: 'Rita Recruiter' });
    pune = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: t.legalEntityId, name: 'Pune Plant', kind: 'factory', timezone: 'Asia/Kolkata', country_code: 'IN' })).id as string;
    superToken = await platformToken('super_admin');
    supportToken = await platformToken('support');
    viewerToken = await platformToken('viewer');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('apps: Web Portal and mobile app', () => {
    it('switching the mobile app off ends its sessions, refuses sign-in on it and leaves the web working', async () => {
      const mobile = await signIn(rita.email, 'mobile');
      const web = await signIn(rita.email, 'web');
      expect(mobile.body.status).toBe('ok');
      expect((await api(app, mobile.body.accessToken).get('/me')).body.client).toBe('mobile');

      const off = await api(app, superToken).put(`/platform/tenants/${t.id}/access/apps`).send({ mobile: false });
      expect(off.status).toBe(200);
      expect(off.body.channels).toMatchObject({ web: true, mobile: false });

      // The open mobile session ends at once; a new mobile sign-in is refused with a clear reason.
      expect((await api(app, mobile.body.accessToken).get('/me')).status).toBe(401);
      const again = await signIn(rita.email, 'mobile');
      expect(again.status).toBe(403);
      expect(again.body.error.code).toBe('app_switched_off');
      expect((await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: mobile.body.refreshToken })).status).toBe(401);
      expect((await api(app, web.body.accessToken).get('/me')).status).toBe(200);
      // Another workspace is untouched.
      expect((await signIn(other.ownerEmail, 'mobile')).body.status).toBe('ok');

      expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/apps`).send({ web: false })).body.error.code).toBe('no_app_left');
      await api(app, superToken).put(`/platform/tenants/${t.id}/access/apps`).send({ mobile: true });
      expect((await signIn(rita.email, 'mobile')).body.status).toBe('ok');
    });

    it('a module switched off in the mobile app only is closed there and open on the web', async () => {
      const res = await api(app, superToken).put(`/platform/tenants/${t.id}/access/apps`).send({ modules: [{ key: 'leave', web: true, mobile: false }] });
      expect(res.body.channels.mobileOff).toEqual(['leave']);
      const mobile = (await signIn(rita.email, 'mobile')).body.accessToken;
      const web = (await signIn(rita.email, 'web')).body.accessToken;
      const me = (await api(app, mobile).get('/me')).body;
      expect(me.features).not.toContain('leave');
      expect(me.featureBlocks.leave).toBe('channel_off');
      const closed = await api(app, mobile).get('/leave/balances');
      expect(closed.status).toBe(403);
      expect(closed.body.error.code).toBe('feature_off_in_app');
      expect((await api(app, web).get('/me')).body.features).toContain('leave');

      await api(app, superToken).put(`/platform/tenants/${t.id}/access/apps`).send({ modules: [{ key: 'leave', web: true, mobile: true }] });
      expect((await api(app, mobile).get('/me')).body.features).toContain('leave');
    });

    it('only Super admins switch apps, and every change is in both audit trails', async () => {
      expect((await api(app, viewerToken).put(`/platform/tenants/${t.id}/access/apps`).send({ mobile: false })).status).toBe(403);
      expect((await api(app, superToken).put(`/platform/tenants/${t.id}/access/apps`).send({})).status).toBe(422);
      const audit = await pool.find('audit_events', { action: { $in: ['access.apps_switched', 'platform.access_apps_switched'] }, $or: [{ tenant_id: t.id }, { tenant_id: null, resource_id: t.id }] });
      expect(audit.some((r) => r.tenant_id === t.id)).toBe(true);
      expect(audit.some((r) => r.tenant_id === null)).toBe(true);
    });
  });

  describe('people', () => {
    it('lists a workspace\'s people with sign-in details, and everyone across workspaces', async () => {
      const res = await api(app, superToken).get(`/platform/tenants/${t.id}/users`);
      expect(res.status).toBe(200);
      const row = res.body.items.find((u: { email: string }) => u.email === rita.email);
      expect(row).toMatchObject({ fullName: 'Rita Recruiter', status: 'active', tenantId: t.id, mfaEnabled: false });
      expect(row.roles).toContain('Recruiter');
      expect(row.liveSessions.web).toBeGreaterThan(0);
      expect(res.body.summary.active).toBeGreaterThanOrEqual(2);
      // Account details only: no HR fields.
      expect(Object.keys(row)).not.toContain('salary');

      const all = await api(app, superToken).get(`/platform/users?q=${encodeURIComponent(other.ownerEmail)}`);
      expect(all.body.items).toHaveLength(1);
      expect(all.body.items[0]).toMatchObject({ tenantId: other.id, email: other.ownerEmail });
      expect((await api(app, supportToken).get('/platform/users')).status).toBe(403);
    });

    it('signs a person out, suspends and reactivates them, with a reason, audited for the customer', async () => {
      const s = await signIn(rita.email, 'web');
      const out = await api(app, superToken).post(`/platform/tenants/${t.id}/users/${rita.membershipId}/actions`).send({ action: 'sign_out', reason: 'Ticket 42: lost laptop' });
      expect(out.status).toBe(200);
      expect(out.body.sessionsEnded).toBeGreaterThan(0);
      expect((await api(app, s.body.accessToken).get('/me')).status).toBe(401);

      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/users/${rita.membershipId}/actions`).send({ action: 'suspend', reason: 'x' })).status).toBe(422);
      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/users/${rita.membershipId}/actions`).send({ action: 'suspend', reason: 'Customer asked by email' })).status).toBe(200);
      expect((await signIn(rita.email, 'web')).body.status).not.toBe('ok');
      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/users/${rita.membershipId}/actions`).send({ action: 'reactivate', reason: 'Customer asked by email' })).status).toBe(200);
      expect((await signIn(rita.email, 'web')).body.status).toBe('ok');

      const trail = await pool.find('audit_events', { tenant_id: t.id, action: /^membership\..*_by_sampledge$/ }, { sort: { chain_seq: 1 } });
      expect(trail.map((r) => r.action)).toEqual(['membership.sign_out_by_sampledge', 'membership.suspend_by_sampledge', 'membership.reactivate_by_sampledge']);
      expect(trail[0]!.metadata.by).toBe('SAMPLEDGE');
    });

    it('will not suspend the only owner, and resets two-step verification', async () => {
      const owner = (await pool.one('memberships', { tenant_id: t.id, id: t.ownerMembershipId }))!;
      const r = await api(app, superToken).post(`/platform/tenants/${t.id}/users/${t.ownerMembershipId}/actions`).send({ action: 'suspend', reason: 'Testing the guard' });
      expect(r.body.error.code).toBe('last_owner');
      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/users/${t.ownerMembershipId}/actions`).send({ action: 'reset_mfa', reason: 'Lost their phone' })).body.error.code).toBe('mfa_not_enabled');
      await pool.update('users', { id: owner.user_id }, { $set: { mfa_enabled: true, mfa_secret_enc: 'x' } });
      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/users/${t.ownerMembershipId}/actions`).send({ action: 'reset_mfa', reason: 'Lost their phone' })).status).toBe(200);
      expect(await pool.one('users', { id: owner.user_id })).toMatchObject({ mfa_enabled: false, mfa_secret_enc: null });
    });

    it('resends an invitation to someone who has not joined', async () => {
      const u = await pool.insert('users', { email: `ivy.${stamp}@${t.slug}.test`, full_name: 'Ivy Invited' });
      const m = await pool.insert('memberships', { tenant_id: t.id, user_id: u.id, status: 'invited' });
      const res = await api(app, superToken).post(`/platform/tenants/${t.id}/users/${m.id}/actions`).send({ action: 'resend_invite', reason: 'Invitation expired' });
      expect(res.status).toBe(200);
      expect(res.body.inviteUrl).toContain('/accept-invite?token=');
      expect(await pool.count('email_messages', { to_email: `ivy.${stamp}@${t.slug}.test` })).toBe(1);
      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/users/${rita.membershipId}/actions`).send({ action: 'resend_invite', reason: 'Invitation expired' })).body.error.code).toBe('not_invited');
    });
  });

  describe('activity', () => {
    it('lists what happened, who and from which app, with contents left to each event', async () => {
      const res = await api(app, superToken).get(`/platform/tenants/${t.id}/activity?limit=5`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBe(5);
      expect(res.body.nextBefore).toBeTypeOf('number');
      for (const row of res.body.items) {
        expect(row).not.toHaveProperty('changes');
        expect(row).not.toHaveProperty('metadata');
      }
      const logins = await api(app, superToken).get(`/platform/tenants/${t.id}/activity?area=auth`);
      expect(logins.body.items.every((r: { area: string }) => r.area === 'auth')).toBe(true);
      expect(logins.body.items.some((r: { client: string }) => r.client === 'mobile')).toBe(true);
      expect(res.body.summary.mobileSignIns30d).toBeGreaterThan(0);
      const next = await api(app, superToken).get(`/platform/tenants/${t.id}/activity?limit=5&before=${res.body.nextBefore}`);
      expect(Number(next.body.items[0].id)).toBeLessThan(res.body.nextBefore);
      expect((await api(app, viewerToken).get(`/platform/tenants/${t.id}/activity`)).status).toBe(403);
    });

    it('opens one event with its recorded contents and the record\'s history, and audits every read', async () => {
      const list = await api(app, superToken).get(`/platform/tenants/${t.id}/activity?area=membership`);
      const suspended = list.body.items.find((r: { action: string }) => r.action === 'membership.suspend_by_sampledge');
      expect(suspended.hasChanges).toBe(true);

      const res = await api(app, superToken).get(`/platform/tenants/${t.id}/activity/${suspended.id}`);
      expect(res.status).toBe(200);
      expect(res.body.changes).toMatchObject({ member: rita.email, action: 'suspend', reason: 'Customer asked by email' });
      expect(res.body.metadata.by).toBe('SAMPLEDGE');
      // The same person's other events, with their contents, newest first.
      const history = res.body.history.map((h: { action: string }) => h.action);
      expect(history).toEqual(expect.arrayContaining(['membership.reactivate_by_sampledge', 'membership.sign_out_by_sampledge']));
      expect(res.body.history.find((h: { action: string }) => h.action === 'membership.reactivate_by_sampledge').changes.reason).toBe('Customer asked by email');

      // Every read is in the customer's own trail (who looked at what) and the platform log.
      const seen = (await pool.find('audit_events', { action: { $in: ['activity.contents_viewed_by_sampledge', 'platform.activity_contents_viewed'] }, 'changes.eventId': suspended.id }))
        .sort((a, b) => Number(a.tenant_id === null) - Number(b.tenant_id === null));
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ tenant_id: t.id, metadata: { by: 'SAMPLEDGE' }, changes: { eventAction: 'membership.suspend_by_sampledge' } });
      expect(seen[0]!.metadata.admin).toBeTruthy();
      expect(seen[1]!.tenant_id).toBeNull();
      await api(app, superToken).get(`/platform/tenants/${t.id}/activity/${suspended.id}`);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'activity.contents_viewed_by_sampledge' })).toBe(2);

      // Super admins only; an event from another workspace, or a malformed id, is not found.
      expect((await api(app, supportToken).get(`/platform/tenants/${t.id}/activity/${suspended.id}`)).status).toBe(403);
      expect((await api(app, superToken).get(`/platform/tenants/${other.id}/activity/${suspended.id}`)).status).toBe(404);
      expect((await api(app, superToken).get(`/platform/tenants/${t.id}/activity/1;drop`)).status).toBe(404);
    });
  });

  describe('attendance machines', () => {
    let owner: string;
    let token: string;
    let deviceId: string;

    beforeAll(async () => {
      owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    });

    it('registers a Hikvision machine on the device API with a one-time token, and takes punches', async () => {
      const ints = await api(app, owner).get('/attendance/devices/integrations');
      expect(ints.body.find((i: { key: string }) => i.key === 'hikvision')).toMatchObject({ enabled: true, protocols: ['device_api'] });
      expect((await api(app, owner).post('/attendance/devices').send({ name: 'Gate', vendor: 'hikvision', protocol: 'push_http', serialNumber: `HK${stamp}`, locationId: pune })).body.error.code).toBe('protocol_not_supported');
      const dev = await api(app, owner).post('/attendance/devices').send({ name: 'Main gate face reader', vendor: 'hikvision', model: 'DS-K1T341', serialNumber: `HK${stamp}`, locationId: pune });
      expect(dev.status).toBe(201);
      expect(dev.body.protocol).toBe('device_api');
      expect(dev.body.token).toMatch(/^crewdev_/);
      token = dev.body.token;
      deviceId = dev.body.id;

      const device = (path: string, tk = token) => request(app.getHttpServer()).post(`/api/v1/device-api/${path}`).set('authorization', `Bearer ${tk}`);
      expect((await device('heartbeat', 'crewdev_wrong').send({})).status).toBe(401);
      expect((await device('heartbeat').send({ firmware: 'V3.2', users: 40 })).status).toBe(200);
      const body = { punches: [{ userId: '101', time: '2026-01-05 09:01:00', direction: 'in', verify: 'face' }, { userId: '101', time: '2026-01-05T12:31:00Z', direction: 'out', id: 'evt-2' }] };
      const up = await device('punches').send(body);
      expect(up.body).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
      expect((await device('punches').send(body)).body).toMatchObject({ accepted: 0, duplicates: 2 });
      expect((await device('punches').send({ punches: [{ userId: '1', time: 'yesterday' }] })).status).toBe(422);

      const detail = (await api(app, owner).get(`/attendance/devices/${deviceId}`)).body;
      expect(detail).toMatchObject({ status: 'online', firmware: 'V3.2', reportedUserCount: 40, setup: { protocol: 'device_api', tokenHint: token.slice(-4) } });
      const stored = await pool.find('attendance_events', { device_id: deviceId }, { sort: { captured_at: 1 } });
      expect(stored.map((r) => r.device_local_time)).toEqual(['2026-01-05 09:01:00', '2026-01-05 18:01:00']);

      const rotated = await api(app, owner).post(`/attendance/devices/${deviceId}/token`);
      expect((await device('heartbeat').send({})).status).toBe(401);
      token = rotated.body.token;
      expect((await device('heartbeat').send({})).status).toBe(200);
    });

    it('SAMPLEDGE sees every machine, pauses one and switches an integration off; pushes are refused and logged', async () => {
      const all = await api(app, viewerToken).get('/platform/devices');
      expect(all.body.items.find((d: { id: string }) => d.id === deviceId)).toMatchObject({ tenantId: t.id, vendor: 'hikvision', status: 'online', punches7d: expect.any(Number) });
      const device = (path: string) => request(app.getHttpServer()).post(`/api/v1/device-api/${path}`).set('authorization', `Bearer ${token}`);

      expect((await api(app, viewerToken).post(`/platform/tenants/${t.id}/devices/${deviceId}/pause`).send({ reason: 'Suspicious traffic' })).status).toBe(403);
      expect((await api(app, superToken).post(`/platform/tenants/${t.id}/devices/${deviceId}/pause`).send({ reason: 'Suspicious traffic' })).status).toBe(200);
      const refused = await device('heartbeat').send({});
      expect(refused.status).toBe(403);
      expect((await api(app, owner).get(`/attendance/devices/${deviceId}`)).body).toMatchObject({ status: 'paused', pausedReason: 'Suspicious traffic' });
      expect((await pool.one('device_ingest_log', { device_id: deviceId, kind: 'rejected' }, { sort: { id: -1 } }))!.detail).toBe('machine paused by SAMPLEDGE');
      await api(app, superToken).post(`/platform/tenants/${t.id}/devices/${deviceId}/resume`);
      expect((await device('heartbeat').send({})).status).toBe(200);

      const ints = await api(app, superToken).put(`/platform/tenants/${t.id}/devices/integrations`).send({ changes: [{ key: 'hikvision', enabled: false }] });
      expect(ints.body.find((i: { key: string }) => i.key === 'hikvision')).toMatchObject({ enabled: false, devices: 1 });
      expect((await device('heartbeat').send({})).status).toBe(403);
      const add = await api(app, owner).post('/attendance/devices').send({ name: 'Second', vendor: 'hikvision', serialNumber: `HK2${stamp}`, locationId: pune });
      expect(add.status).toBe(403);
      expect((await api(app, superToken).get(`/platform/tenants/${t.id}/devices`)).body.integrations.find((i: { key: string }) => i.key === 'hikvision').enabled).toBe(false);
      await api(app, superToken).put(`/platform/tenants/${t.id}/devices/integrations`).send({ changes: [{ key: 'hikvision', enabled: true }] });
      expect((await device('heartbeat').send({})).status).toBe(200);
    });

    it('reads device API times in the machine\'s zone, or exactly when an offset is given', () => {
      const r = parseDeviceApi({ punches: [{ userId: '7', time: '2026-03-01 08:00', direction: 'in', verify: 'card' }, { userId: '7', time: '2026-03-01T08:00:00+05:30', direction: 'in', verify: 'card' }, { userId: '7', time: '2999-01-01 08:00:00', direction: 'in', verify: 'card' }] }, 'dev', 'Asia/Kolkata', true);
      expect(r.punches.map((p) => p.localTime)).toEqual(['2026-03-01 08:00:00', '2026-03-01 08:00:00']);
      expect(r.punches[0]!.capturedAt).toBe(r.punches[1]!.capturedAt);
      expect(r.rejected[0]!.reason).toBe('time is in the future');
    });
  });

  describe('subscription', () => {
    it('sets cycle, negotiated price, period end and limits without touching module switches, with a history', async () => {
      await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'payroll', state: 'off' }] });
      const res = await api(app, superToken).put(`/platform/tenants/${t.id}/subscription`).send({ billingCycle: 'annual', unitPrice: '350.00', currentPeriodEnd: '2030-12-31', cancelAtPeriodEnd: true, limits: { max_employees: 75 } });
      expect(res.status).toBe(200);
      const detail = (await api(app, viewerToken).get(`/platform/tenants/${t.id}`)).body.subscription;
      expect(detail).toMatchObject({ billingCycle: 'annual', unitPrice: '350.00', currentPeriodEnd: '2030-12-31', cancelAtPeriodEnd: true });
      expect(detail.featureOverrides).toEqual({ payroll: false, max_employees: 75 });
      const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
      expect((await api(app, owner).get('/me')).body.limits.max_employees).toBe(75);

      await api(app, superToken).put(`/platform/tenants/${t.id}/subscription`).send({ limits: { max_employees: null } });
      expect((await api(app, viewerToken).get(`/platform/tenants/${t.id}`)).body.subscription.featureOverrides).toEqual({ payroll: false });
      expect((await api(app, superToken).put(`/platform/tenants/${t.id}/subscription`).send({ currentPeriodEnd: '2000-01-01' })).body.error.code).toBe('period_end_before_start');
      expect((await api(app, superToken).put(`/platform/tenants/${t.id}/subscription`).send({ unitPrice: 'free' })).status).toBe(422);

      const history = await api(app, viewerToken).get(`/platform/tenants/${t.id}/subscription/history`);
      expect(history.body.filter((h: { action: string }) => h.action === 'platform.subscription_overridden').length).toBeGreaterThanOrEqual(2);
      await api(app, superToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'payroll', state: 'plan' }] });
    });
  });
});
