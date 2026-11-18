import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentTotp } from '../src/platform/auth/mfa';
import { adminPool, api, createApp, createTenant, login, type TestDb, type TestTenant } from './helpers';

const PROFILE = { legalName: 'ABC', addressLine1: 'Pitampura Rohini', city: 'Delhi', stateCode: '07', postalCode: '110085', countryCode: 'IN', email: 'accounts@abc.test' };

/**
 * Actions that need MFA (billing details, statutory settings) used to fail with "needs multi-factor authentication"
 * and no way forward inside the page. A session can now be verified in place: by turning MFA on, or, when it is
 * already on, with a code (step-up), and the same save then goes through.
 */
describe('MFA step-up for billing and payroll settings', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let secret: string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('an owner without MFA is asked for it, turns it on in place, and both saves then work', async () => {
    const s = await login(app, t.ownerEmail, undefined, t.slug);
    const blocked = await api(app, s.accessToken).put('/billing/profile').send(PROFILE);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_required');
    expect((await api(app, s.accessToken).get('/payroll/statutory')).body.error.code).toBe('mfa_required');

    // Step-up is only for people who already use an authenticator app; the web form then offers enrolment.
    const notOn = await api(app, s.accessToken).post('/me/mfa/verify').send({ code: '123456' });
    expect(notOn.status).toBe(400);
    expect(notOn.body.error.code).toBe('mfa_not_enabled');

    const setup = await api(app, s.accessToken).post('/me/mfa/setup');
    secret = setup.body.secret;
    const enabled = await api(app, s.accessToken).post('/me/mfa/enable').send({ code: currentTotp(setup.body.secret) });
    expect(enabled.status).toBe(200);
    const token = enabled.body.accessToken as string;

    expect((await api(app, token).put('/billing/profile').send(PROFILE)).status).toBe(200);
    expect((await api(app, token).get('/billing/profile')).body).toMatchObject({ legalName: 'ABC', stateCode: '07', city: 'Delhi' });

    // Statutory settings: the India starting values are offered, and saving them is what lets payroll run.
    const st = await api(app, token).get('/payroll/statutory');
    expect(st.status).toBe(200);
    expect(st.body.settings).toEqual([]);
    expect(st.body.startingValues.countryCode).toBe('IN');
    const saved = await api(app, token).post('/payroll/statutory').send({ legalEntityId: t.legalEntityId, effectiveFrom: '2026-04-01', settings: st.body.startingValues.settings });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const after = await api(app, token).get('/payroll/statutory');
    expect(after.body.settings).toHaveLength(1);
    expect(after.body.settings[0]).toMatchObject({ legalEntityId: t.legalEntityId, effectiveFrom: '2026-04-01', lopSource: 'attendance_and_leave' });
  });

  it('a session opened without a code is verified with one, keeps the person signed in and is audited', async () => {
    // A second session from before MFA was turned on (the same as one opened with SSO or an invitation link).
    const user = (await pool.one('users', { email: t.ownerEmail }))!;
    await pool.update('users', { id: user.id }, { $set: { mfa_enabled: false } });
    const old = await login(app, t.ownerEmail, undefined, t.slug);
    await pool.update('users', { id: user.id }, { $set: { mfa_enabled: true } });
    expect((await api(app, old.accessToken).get('/me')).body.session.mfa).toBe(false);
    expect((await api(app, old.accessToken).put('/billing/profile').send(PROFILE)).body.error.code).toBe('mfa_required');

    const wrong = await api(app, old.accessToken).post('/me/mfa/verify').send({ code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('invalid_code');
    expect((await api(app, old.accessToken).post('/me/mfa/verify').send({ code: 'abc' })).status).toBe(422);

    const ok = await api(app, old.accessToken).post('/me/mfa/verify').send({ code: currentTotp(secret) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await api(app, ok.body.accessToken).get('/me')).body.session.mfa).toBe(true);
    // The unverified session is replaced, not left open beside the verified one.
    expect((await api(app, old.accessToken).get('/me')).status).toBe(401);
    expect((await api(app, ok.body.accessToken).put('/billing/profile').send({ ...PROFILE, legalName: 'ABC Pvt Ltd' })).status).toBe(200);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'auth.mfa_step_up' })).toBe(1);
    // Wrong codes count towards the sign-in lock; a good code clears the count.
    expect((await pool.one('users', { id: user.id }))!.failed_login_count).toBe(0);
  });
});
