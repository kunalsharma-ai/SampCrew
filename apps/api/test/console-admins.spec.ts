import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { adminPool, api, createApp, PASSWORD, type TestDb } from './helpers';

const run = promisify(execFile);
const DB_PACKAGE = resolve(__dirname, '../../../packages/db');

/** The console admin recovery command (packages/db/scripts/platform-admin.ts), run as an operator would. */
async function recovery(args: string[], env: Record<string, string> = {}) {
  try {
    const r = await run(resolve(DB_PACKAGE, 'node_modules/.bin/tsx'), ['scripts/platform-admin.ts', ...args], {
      cwd: DB_PACKAGE, env: { ...process.env, ...env }, timeout: 60_000,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

/** Managing SAMPLEDGE console admins: roles, disabling, temporary passwords, two-step resets and the recovery command. */
describe('Console admins', () => {
  let app: INestApplication;
  let pool: TestDb;
  const stamp = Date.now();
  const secrets = new Map<string, string>();
  let superToken: string;
  let superId: string;

  /** Signs in, enrolling two-step verification the first time; returns the login body with an MFA-verified token. */
  async function signIn(email: string, password = PASSWORD) {
    const secret = secrets.get(email);
    const res = await api(app).post('/platform/auth/login').send({ email, password, ...(secret ? { code: currentTotp(secret) } : {}) });
    if (res.body.status === 'mfa_required') throw new Error(`${email} needs a code but the test has no secret`);
    if (res.status !== 200) return res;
    if (!res.body.mfaEnrolmentRequired) return res;
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    secrets.set(email, setup.body.secret);
    const enabled = await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) });
    return { ...enabled, body: { ...enabled.body, passwordChangeRequired: res.body.passwordChangeRequired } };
  }

  async function seedAdmin(role: string, name = role) {
    const email = `${name}.${stamp}@sampledge.test`;
    const row = await pool.insert('platform_admins', { email, full_name: `${name} admin`, password_hash: await hashPassword(PASSWORD), role });
    return { email, id: row.id as string };
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    const s = await seedAdmin('super_admin', 'chief');
    superId = s.id;
    superToken = (await signIn(s.email)).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('a new admin enrols two-step verification, then must replace the temporary password before anything else', async () => {
    const email = `new.${stamp}@sampledge.test`;
    const temp = 'Temporary-Pass-91!';
    const created = await api(app, superToken).post('/platform/admins').send({ email, fullName: 'New Person', role: 'support', password: temp });
    expect(created.status).toBe(201);

    const first = await signIn(email, temp);
    expect(first.body.passwordChangeRequired).toBe(true);
    const token = first.body.accessToken as string;
    expect((await api(app, token).get('/platform/auth/me')).body).toMatchObject({ mustChangePassword: true, session: { mfa: true } });
    expect((await api(app, token).get('/platform/tenants')).body.error.code).toBe('password_change_required');

    expect((await api(app, token).post('/platform/auth/password').send({ currentPassword: 'wrong', newPassword: 'Own-Secret-Pass-77' })).body.error.code).toBe('wrong_password');
    expect((await api(app, token).post('/platform/auth/password').send({ currentPassword: temp, newPassword: temp })).body.error.code).toBe('same_password');
    expect((await api(app, token).post('/platform/auth/password').send({ currentPassword: temp, newPassword: 'short' })).status).toBe(422);
    expect((await api(app, token).post('/platform/auth/password').send({ currentPassword: temp, newPassword: 'Own-Secret-Pass-77' })).status).toBe(204);

    expect((await api(app, token).get('/platform/tenants')).status).toBe(200);
    expect((await api(app).post('/platform/auth/login').send({ email, password: temp, code: currentTotp(secrets.get(email)!) })).status).toBe(401);
    expect((await signIn(email, 'Own-Secret-Pass-77')).body.passwordChangeRequired).toBe(false);
    const audit = await pool.find('audit_events', { action: 'platform.password_changed', resource_id: created.body.id });
    expect(audit[0]?.metadata).toMatchObject({ wasTemporary: true });
  });

  it('changing your own password signs out your other sessions', async () => {
    const a = await seedAdmin('viewer', 'mover');
    const one = (await signIn(a.email)).body.accessToken as string;
    const two = (await signIn(a.email)).body.accessToken as string;
    expect((await api(app, two).post('/platform/auth/password').send({ currentPassword: PASSWORD, newPassword: 'Moved-Password-55' })).status).toBe(204);
    expect((await api(app, one).get('/platform/metrics')).status).toBe(401);
    expect((await api(app, two).get('/platform/metrics')).status).toBe(200);
  });

  it('a role change applies at once and nobody changes their own role or status', async () => {
    const a = await seedAdmin('support', 'promoted');
    const before = (await signIn(a.email)).body.accessToken as string;
    expect((await api(app, before).get('/platform/plans')).status).toBe(403);
    const res = await api(app, superToken).patch(`/platform/admins/${a.id}`).send({ role: 'billing_ops', fullName: 'Promoted Person' });
    expect(res.body).toMatchObject({ role: 'billing_ops', fullName: 'Promoted Person' });
    expect((await api(app, before).get('/platform/plans')).status).toBe(401);
    expect((await api(app, (await signIn(a.email)).body.accessToken).get('/platform/plans')).status).toBe(200);

    expect((await api(app, superToken).patch(`/platform/admins/${superId}`).send({ role: 'viewer' })).body.error.code).toBe('own_account');
    expect((await api(app, superToken).patch(`/platform/admins/${superId}`).send({ status: 'disabled' })).body.error.code).toBe('own_account');
    // Renaming yourself is fine.
    expect((await api(app, superToken).patch(`/platform/admins/${superId}`).send({ fullName: 'Chief Admin' })).status).toBe(200);
    expect((await api(app, superToken).patch(`/platform/admins/${superId}`).send({})).status).toBe(422);
  });

  it('disabling signs the admin out and blocks sign-in until re-enabled', async () => {
    const a = await seedAdmin('viewer', 'leaver');
    const token = (await signIn(a.email)).body.accessToken as string;
    expect((await api(app, superToken).patch(`/platform/admins/${a.id}`).send({ status: 'disabled' })).status).toBe(200);
    expect((await api(app, token).get('/platform/metrics')).status).toBe(401);
    expect((await api(app).post('/platform/auth/login').send({ email: a.email, password: PASSWORD, code: currentTotp(secrets.get(a.email)!) })).status).toBe(401);
    expect((await api(app, superToken).patch(`/platform/admins/${a.id}`).send({ status: 'active' })).status).toBe(200);
    expect((await signIn(a.email)).status).toBe(200);
    const actions = (await pool.find('audit_events', { resource_id: a.id })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.admin_disabled', 'platform.admin_enabled']));
  });

  it('the last active Super admin cannot be demoted or disabled, even by two at once', async () => {
    const deputy = await seedAdmin('super_admin', 'deputy');
    const deputyToken = (await signIn(deputy.email)).body.accessToken as string;
    // Make "chief" and "deputy" the only active Super admins for this test, then put everyone back.
    const parked = (await pool.find('platform_admins', { role: 'super_admin', status: 'active', id: { $nin: [superId, deputy.id] } })).map((r) => r.id as string);
    await pool.update('platform_admins', { id: { $in: parked } }, { $set: { status: 'disabled' } });
    try {
      // Each demotes the other at the same moment: one wins, the other is refused, and a Super admin is left.
      const results = await Promise.all([
        api(app, superToken).patch(`/platform/admins/${deputy.id}`).send({ role: 'support' }),
        api(app, deputyToken).patch(`/platform/admins/${superId}`).send({ role: 'support' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]);
      for (const r of results) if (r.status === 409) expect(r.body.error.code).toBe('last_super_admin');
      expect(await pool.count('platform_admins', { role: 'super_admin', status: 'active', id: { $in: [superId, deputy.id] } })).toBe(1);

      // The one left cannot be disabled by the recovery command either.
      const survivor = (await pool.one('platform_admins', { role: 'super_admin', status: 'active', id: { $in: [superId, deputy.id] } }))!;
      const refused = await recovery(['disable', '--email', survivor.email as string]);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('last active Super admin');
      expect(await pool.count('platform_admins', { role: 'super_admin', status: 'active', id: { $in: [superId, deputy.id] } })).toBe(1);
    } finally {
      await pool.update('platform_admins', { id: { $in: parked } }, { $set: { status: 'active' } });
      await pool.update('platform_admins', { id: { $in: [superId, deputy.id] } }, { $set: { role: 'super_admin', status: 'active' } });
      superToken = (await signIn((await pool.one('platform_admins', { id: superId }))!.email as string)).body.accessToken;
    }
  });

  it('a temporary password unlocks, signs out and must be replaced; a two-step reset makes them enrol again', async () => {
    const a = await seedAdmin('support', 'forgetful');
    const token = (await signIn(a.email)).body.accessToken as string;
    for (let i = 0; i < 5; i++) await api(app).post('/platform/auth/login').send({ email: a.email, password: 'not-it' });
    expect((await api(app).post('/platform/auth/login').send({ email: a.email, password: PASSWORD })).status).toBe(429);
    const list = await api(app, superToken).get('/platform/admins');
    expect(list.body.find((x: { id: string }) => x.id === a.id)).toMatchObject({ locked: true, mfaEnabled: true });

    expect((await api(app, superToken).post(`/platform/admins/${a.id}/unlock`)).status).toBe(200);
    expect((await signIn(a.email)).status).toBe(200);

    expect((await api(app, superToken).post(`/platform/admins/${a.id}/reset-password`).send({ password: 'weak' })).status).toBe(422);
    expect((await api(app, superToken).post(`/platform/admins/${a.id}/reset-password`).send({ password: 'Reset-By-Chief-31' })).status).toBe(200);
    expect((await api(app, token).get('/platform/metrics')).status).toBe(401);
    const after = await signIn(a.email, 'Reset-By-Chief-31');
    expect(after.body.passwordChangeRequired).toBe(true);

    expect((await api(app, superToken).post(`/platform/admins/${a.id}/reset-mfa`)).status).toBe(200);
    secrets.delete(a.email);
    const again = await api(app).post('/platform/auth/login').send({ email: a.email, password: 'Reset-By-Chief-31' });
    expect(again.body).toMatchObject({ status: 'ok', mfaEnrolmentRequired: true });
    expect((await api(app, again.body.accessToken).get('/platform/metrics')).body.error.code).toBe('mfa_required');

    expect((await api(app, superToken).post(`/platform/admins/${superId}/reset-mfa`)).body.error.code).toBe('own_account');
    expect((await api(app, superToken).post(`/platform/admins/${superId}/reset-password`).send({ password: 'Reset-By-Chief-31' })).body.error.code).toBe('own_account');
    const actions = (await pool.find('audit_events', { resource_id: a.id })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['platform.admin_unlocked', 'platform.admin_password_reset', 'platform.admin_mfa_reset']));
  });

  it('only Super admins manage admins', async () => {
    const support = await seedAdmin('support', 'helper');
    const target = await seedAdmin('viewer', 'target');
    const token = (await signIn(support.email)).body.accessToken as string;
    expect((await api(app, token).get('/platform/admins')).status).toBe(403);
    expect((await api(app, token).patch(`/platform/admins/${target.id}`).send({ status: 'disabled' })).status).toBe(403);
    expect((await api(app, token).post(`/platform/admins/${target.id}/reset-password`).send({ password: 'Sneaky-Change-12' })).status).toBe(403);
    expect((await api(app, token).post(`/platform/admins/${target.id}/reset-mfa`)).status).toBe(403);
    expect((await api(app, token).post(`/platform/admins/${target.id}/unlock`)).status).toBe(403);
  });

  describe('recovery command', () => {
    it('creates a Super admin with a one-time password that must be replaced, and audits it', async () => {
      const email = `Rescue.${stamp}@SampEdge.test`;
      const r = await recovery(['create', '--email', email, '--name', 'Rescue Person']);
      expect(r.code).toBe(0);
      const temp = /Temporary password \(shown once[^:]*\): (\S+)/.exec(r.out)?.[1];
      expect(temp).toBeTruthy();
      const row = await pool.one('platform_admins', { email: email.toLowerCase() });
      expect(row).toMatchObject({ role: 'super_admin', must_change_password: true, mfa_enabled: false });
      const first = await signIn(email.toLowerCase(), temp!);
      expect(first.body.passwordChangeRequired).toBe(true);
      const event = await pool.one('audit_events', { action: 'platform.admin_created', resource_id: row!.id });
      expect(event).toMatchObject({ tenant_id: null, actor_type: 'system', metadata: { via: 'recovery_command' } });
      expect(event!.actor_label).toMatch(/^recovery command \(/);
      expect(event!.hash).toMatch(/^[0-9a-f]{64}$/);
      expect((await recovery(['create', '--email', email, '--name', 'Again'])).code).toBe(2);
    });

    it('resets two-step verification and the password of a locked-out admin and signs them out', async () => {
      const a = await seedAdmin('super_admin', 'lostphone');
      const token = (await signIn(a.email)).body.accessToken as string;
      for (let i = 0; i < 5; i++) await api(app).post('/platform/auth/login').send({ email: a.email, password: 'not-it' });

      const mfa = await recovery(['reset-mfa', '--email', a.email]);
      expect(mfa.code).toBe(0);
      expect((await api(app, token).get('/platform/metrics')).status).toBe(401);
      const relogin = await api(app).post('/platform/auth/login').send({ email: a.email, password: PASSWORD });
      expect(relogin.body).toMatchObject({ status: 'ok', mfaEnrolmentRequired: true });

      const pw = await recovery(['reset-password', '--email', a.email], { CREW_ADMIN_PASSWORD: 'Given-By-Operator-88' });
      expect(pw.code).toBe(0);
      expect(pw.out).not.toContain('Given-By-Operator-88');
      expect((await api(app).post('/platform/auth/login').send({ email: a.email, password: PASSWORD })).status).toBe(401);
      secrets.delete(a.email);
      expect((await signIn(a.email, 'Given-By-Operator-88')).body.passwordChangeRequired).toBe(true);
      expect((await recovery(['reset-password', '--email', a.email], { CREW_ADMIN_PASSWORD: 'weak' })).code).toBe(2);
    });

    it('lists admins, changes roles, disables and re-enables, and refuses bad input', async () => {
      const a = await seedAdmin('viewer', 'cli');
      expect((await recovery(['list'])).out).toContain(a.email);
      expect((await recovery(['set-role', '--email', a.email, '--role', 'support'])).code).toBe(0);
      expect((await pool.one('platform_admins', { id: a.id }))!.role).toBe('support');
      expect((await recovery(['disable', '--email', a.email])).code).toBe(0);
      expect((await pool.one('platform_admins', { id: a.id }))!.status).toBe('disabled');
      expect((await recovery(['enable', '--email', a.email])).code).toBe(0);
      expect((await pool.one('platform_admins', { id: a.id }))!.status).toBe('active');
      expect((await recovery(['set-role', '--email', a.email, '--role', 'owner'])).code).toBe(2);
      expect((await recovery(['unlock', '--email', `nobody.${stamp}@sampledge.test`])).code).toBe(2);
      expect((await recovery(['explode'])).code).toBe(2);
    });
  });
});
