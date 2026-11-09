import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/platform/config/config';
import { PushService } from '../src/platform/notify/push.service';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const HOUR = 3_600_000;

/** Phase 7 mobile API: devices, push delivery through a stand-in for the Expo push service, and offline punches. */
describe('mobile', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let pushServer: Server;
  const pushed: { to: string; title: string; body: string; data: Record<string, unknown> }[][] = [];
  const unregistered = new Set<string>();
  let hrToken: string;
  let op: { email: string; membershipId: string; employeeId?: string };
  let peer: { email: string; membershipId: string };
  let opSession: { accessToken: string; refreshToken: string };
  let peerToken: string;
  let pune: string;
  let deviceId: string;
  const as = (tk: string) => api(app, tk);

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const sync = (body: Record<string, unknown>) => as(opSession.accessToken).post('/mobile/punches').set('x-crew-client', 'mobile').send({ deviceId, ...body });

  beforeAll(async () => {
    pushServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const msgs = JSON.parse(raw) as { to: string; title: string; body: string; data: Record<string, unknown> }[];
        pushed.push(msgs);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: msgs.map((m, i) => (unregistered.has(m.to)
            ? { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok', id: `ticket-${pushed.length}-${i}` })),
        }));
      });
    });
    await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', r));
    process.env.EXPO_PUSH_ENABLED = 'true';
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(pushServer.address() as AddressInfo).port}/--/api/v2/push/send`;
    resetConfigForTests();
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    const assembly = await department(pool, t, 'Assembly');
    pune = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: t.legalEntityId, name: 'Pune Plant', kind: 'factory', timezone: 'Asia/Kolkata', country_code: 'IN', latitude: '18.5204', longitude: '73.8567', geofence_radius_m: 200 })).id as string;
    const hr = await addMember(pool, t, { roles: ['hr_admin'] });
    op = await addMember(pool, t, { departmentId: assembly, name: 'Olu Operator' });
    peer = await addMember(pool, t, { departmentId: assembly, name: 'Pat Peer' });
    hrToken = (await loginWithMfa(app, pool, hr.email)).accessToken;
    for (const [m, first] of [[op, 'Olu'], [peer, 'Pat']] as const) {
      const res = await as(hrToken).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-15', probationMonths: 0, locationId: pune, departmentId: assembly, membershipId: m.membershipId, onboardingTemplateId: null });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      if (m === op) op.employeeId = res.body.employee.id;
    }
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-crew-client', 'mobile').send({ email: op.email, password: 'Correct-Horse-42!' });
    opSession = res.body;
    peerToken = (await login(app, peer.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await new Promise((r) => pushServer.close(r));
    delete process.env.EXPO_PUSH_ENABLED;
    delete process.env.EXPO_PUSH_URL;
    resetConfigForTests();
  });

  describe('devices and push', () => {
    it('registers a phone once per installation and marks the sign-in as mobile', async () => {
      const body = { installationId: 'install-olu-0000000001', platform: 'android', appVersion: '1.0.0', model: 'Pixel 8', osVersion: '15' };
      const d = ok(await as(opSession.accessToken).post('/mobile/devices').send(body));
      deviceId = d.id;
      expect(d).toMatchObject({ platform: 'android', model: 'Pixel 8', pushEnabled: false, revokedAt: null });
      const again = ok(await as(opSession.accessToken).post('/mobile/devices').send({ ...body, appVersion: '1.0.1' }));
      expect(again).toMatchObject({ id: deviceId, appVersion: '1.0.1' });
      expect((ok(await as(opSession.accessToken).get('/mobile/devices')) as unknown as unknown[]).length).toBe(1);
      const s = await pool.one('sessions', { refresh_token_hash: createHash('sha256').update(opSession.refreshToken).digest('hex') });
      expect(s!.client).toBe('mobile');
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'mobile.device_registered' })).toBe(1);
    });

    it('accepts only Expo push tokens, and only for my own device', async () => {
      expect((await as(opSession.accessToken).put(`/mobile/devices/${deviceId}/push-token`).send({ token: 'not-a-token' })).status).toBe(422);
      expect((await as(peerToken).put(`/mobile/devices/${deviceId}/push-token`).send({ token: 'ExponentPushToken[aaaaaaaaaaaaaaaa]' })).status).toBe(404);
      ok(await as(opSession.accessToken).put(`/mobile/devices/${deviceId}/push-token`).send({ token: 'ExponentPushToken[aaaaaaaaaaaaaaaa]' }));
    });

    it('pushes new notifications without their text, and drops tokens the push service no longer knows', async () => {
      // A helpdesk reply from HR creates a notification for the operator.
      const cats = (await as(opSession.accessToken).get('/helpdesk/categories')).body as { id: string; name: string }[];
      const c = ok(await as(opSession.accessToken).post('/helpdesk/cases').send({ categoryId: cats[0]!.id, subject: 'Payslip PDF', description: 'How do I save my payslip as a file?' }), 201);
      ok(await as(hrToken).post(`/helpdesk/cases/${c.id}/messages`).send({ body: 'Open the payslip and use Save as PDF.' }));
      const r = await app.get(PushService).sendBatch();
      expect(r).toEqual({ sent: 1, failed: 0, skipped: 0 });
      const msg = pushed.at(-1)![0]!;
      expect(msg).toMatchObject({ to: 'ExponentPushToken[aaaaaaaaaaaaaaaa]', title: 'SampCrew', body: 'You have something new in SampCrew.' });
      expect(msg.data.link).toBe(`/helpdesk/${c.id}`);
      expect(JSON.stringify(msg)).not.toContain('Payslip');
      unregistered.add('ExponentPushToken[aaaaaaaaaaaaaaaa]');
      ok(await as(hrToken).post(`/helpdesk/cases/${c.id}/messages`).send({ body: 'Did that work?' }));
      expect(await app.get(PushService).sendBatch()).toEqual({ sent: 0, failed: 1, skipped: 0 });
      expect(ok(await as(opSession.accessToken).get('/mobile/devices'))[0].pushEnabled).toBe(false);
    });
  });

  describe('offline punches', () => {
    it('records queued punches once, with the time worked out from the server clock', async () => {
      const now = Date.now();
      const first = ok(await sync({
        sentElapsedMs: 10 * 60_000, sentRunId: 'run-aaaaaaaa',
        punches: [
          { sequence: 1, direction: 'in', capturedAt: new Date(now - 5 * 60_000).toISOString(), capturedElapsedMs: 5 * 60_000, capturedRunId: 'run-aaaaaaaa', latitude: 18.5205, longitude: 73.8568, accuracyM: 15, offline: true },
        ],
      }));
      expect(first.results[0]).toMatchObject({ sequence: 1, status: 'accepted', punch: { direction: 'in', geofence: 'inside', flags: ['offline'] } });
      const at = new Date(first.results[0].punch.capturedAt).getTime();
      expect(Math.abs(at - (now - 5 * 60_000))).toBeLessThan(10_000);
      const retry = ok(await sync({ punches: [{ sequence: 1, direction: 'in', capturedAt: new Date(now - 5 * 60_000).toISOString() }] }));
      expect(retry.results[0]).toMatchObject({ status: 'duplicate' });
      expect(await pool.count('attendance_events', { mobile_device_id: deviceId })).toBe(1);
    });

    it('flags a changed phone clock and keeps both times; flags unverifiable times and mock locations', async () => {
      const now = Date.now();
      // The phone claims the punch was 3 hours ago, but its monotonic clock says 2 minutes passed.
      const r = ok(await sync({
        sentElapsedMs: 1_000_000, sentRunId: 'run-bbbbbbbb',
        punches: [
          { sequence: 2, direction: 'out', capturedAt: new Date(now - 3 * HOUR).toISOString(), capturedElapsedMs: 1_000_000 - 120_000, capturedRunId: 'run-bbbbbbbb', latitude: 18.5205, longitude: 73.8568 },
          { sequence: 3, direction: 'in', capturedAt: new Date(now - 60_000).toISOString(), capturedElapsedMs: 50, capturedRunId: 'run-old-11111', latitude: 18.5205, longitude: 73.8568, mockLocation: true },
        ],
      }));
      expect(r.results[0]).toMatchObject({ status: 'accepted', punch: { flags: ['clock_changed'] } });
      expect(Math.abs(new Date(r.results[0].punch.capturedAt).getTime() - (now - 120_000))).toBeLessThan(10_000);
      expect(r.results[1]).toMatchObject({ status: 'accepted', punch: { flags: ['clock_unverified', 'mock_location'] } });
      const ev = (await pool.one('attendance_events', { source: 'mobile', source_event_id: `${deviceId}:2` }))!;
      expect(new Date(ev.device_local_time).toISOString()).toBe(new Date(now - 3 * HOUR).toISOString());
      expect(ev.raw).toMatchObject({ timeBasis: 'monotonic', sameRun: true });
      const today = ok(await as(opSession.accessToken).get('/attendance/today'));
      expect(today.punches.flatMap((p: { flags: string[] }) => p.flags)).toEqual(expect.arrayContaining(['offline', 'clock_changed', 'mock_location']));
    });

    it('refuses punches that are too old, in the future, or outside an enforced geofence, each with a reason', async () => {
      const now = Date.now();
      ok(await as(hrToken).put('/attendance/policies').send({ locationId: pune, geofenceMode: 'enforce', defaultShiftId: null }));
      const r = ok(await sync({
        punches: [
          { sequence: 10, direction: 'in', capturedAt: new Date(now - 80 * HOUR).toISOString(), latitude: 18.5205, longitude: 73.8568 },
          { sequence: 11, direction: 'in', capturedAt: new Date(now + 30 * 60_000).toISOString(), latitude: 18.5205, longitude: 73.8568 },
          { sequence: 12, direction: 'in', capturedAt: new Date(now - 60_000).toISOString(), latitude: 18.6, longitude: 73.8567 },
          { sequence: 13, direction: 'in', capturedAt: new Date(now - 60_000).toISOString() },
        ],
      }));
      expect(r.results.map((x: { reason: string }) => x.reason)).toEqual(['too_old', 'in_future', 'outside_geofence', 'location_required']);
      expect(r.results[0].message).toMatch(/Ask for an attendance correction/);
      const audit = (await pool.one('audit_events', { tenant_id: t.id, action: 'attendance.punch_refused', 'metadata.sequence': 12 }))!;
      expect(audit.metadata).toMatchObject({ source: 'mobile', sequence: 12 });
      ok(await as(hrToken).put('/attendance/policies').send({ locationId: pune, geofenceMode: 'warn', defaultShiftId: null }));
    });

    it('keeps a punch for a locked payroll period without changing the locked day', async () => {
      const yesterday = new Date(Date.now() - 24 * HOUR);
      const date = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      ok(await as(hrToken).post('/attendance/locks').send({ legalEntityId: t.legalEntityId, periodStart: date, periodEnd: date, reason: 'Payroll test lock' }), 201);
      const r = ok(await sync({ punches: [{ sequence: 20, direction: 'in', capturedAt: yesterday.toISOString(), latitude: 18.5205, longitude: 73.8568, offline: true }] }));
      expect(r.results[0]).toMatchObject({ status: 'accepted', punch: { arrivedAfterLock: true } });
      expect(r.results[0].message).toMatch(/locked for payroll/);
    });

    it("refuses another person's device", async () => {
      const res = await as(peerToken).post('/mobile/punches').send({ deviceId, punches: [{ sequence: 99, capturedAt: new Date().toISOString() }] });
      expect(res.status).toBe(404);
    });

    it('signs a device out: its sign-in ends and its queue is refused', async () => {
      expect((await as(peerToken).post(`/mobile/devices/${deviceId}/sign-out`)).status).toBe(404);
      expect((await as(opSession.accessToken).post(`/mobile/devices/${deviceId}/sign-out`)).status).toBe(204);
      const refreshed = await request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken: opSession.refreshToken });
      expect(refreshed.status).toBe(401);
      const fresh = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-crew-client', 'mobile').send({ email: op.email, password: 'Correct-Horse-42!' });
      const res = await as(fresh.body.accessToken).post('/mobile/punches').send({ deviceId, punches: [{ sequence: 30, capturedAt: new Date().toISOString() }] });
      expect(res.status).toBe(404);
    });
  });
});
