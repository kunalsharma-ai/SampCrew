import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptField, hashPassword } from '../src/platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../src/platform/config/config';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, PASSWORD, type TestDb, type TestTenant } from './helpers';

const NEW_PASSWORD = 'Brand-New-Secret-58!';

/**
 * Forgot password by email at every level: Super, HR and Employee Workspace (web link or phone-app code) and the
 * SAMPLEDGE Console. The record shows up in the Console (everyone) and in the Super Workspace (its own people).
 */
describe('forgot password', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let superToken: string;
  let consoleToken: string;
  const stamp = Date.now();

  /** The newest reset email to an address, with the link token and the 6-digit code it carries. */
  async function inbox(email: string) {
    const m = await pool.one('email_messages', { to_email: email, template: 'password_reset' }, { sort: { created_at: -1 } });
    if (!m) throw new Error(`no reset email to ${email}`);
    const token = /reset-password\?token=([\w-]+)/.exec(m.text_body)?.[1];
    const code = /code: (\d{6})/.exec(m.text_body)?.[1];
    return { message: m, token: token!, code: code!, body: m.text_body as string };
  }

  async function consoleAdmin(role = 'super_admin') {
    const email = `reset.${role}.${stamp}.${Math.random().toString(36).slice(2, 6)}@sampledge.test`;
    const secret = 'JBSWY3DPEHPK3PXP';
    const keys = app.get<AppConfig>(APP_CONFIG).fieldKeys;
    const row = await pool.insert('platform_admins', { email, full_name: 'Reset Admin', password_hash: await hashPassword(PASSWORD), role, mfa_enabled: true, mfa_secret_enc: encryptField(secret, keys) });
    return { email, id: row.id as string, secret };
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    superToken = (await login(app, t.ownerEmail)).accessToken;
    const a = await consoleAdmin();
    const res = await api(app).post('/platform/auth/login').send({ email: a.email, password: PASSWORD, code: currentTotp(a.secret) });
    consoleToken = res.body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('gives the same answer for an unknown email and records it for the Console only', async () => {
    const known = await addMember(pool, t);
    const a = await api(app).post('/auth/password-reset/request').send({ email: known.email });
    const b = await api(app).post('/auth/password-reset/request').send({ email: `nobody.${stamp}@nowhere.test` });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
    const unknown = await pool.one('password_resets', { email: `nobody.${stamp}@nowhere.test` });
    expect(unknown).toMatchObject({ status: 'no_account', tenant_ids: [] });
    expect(await pool.one('email_messages', { to_email: `nobody.${stamp}@nowhere.test` })).toBeUndefined();
    // No link or code is ever stored in clear.
    const row = await pool.one('password_resets', { email: known.email });
    const mail = await inbox(known.email);
    expect(row!.token_hash).not.toContain(mail.token);
    expect(row!.code_hash).not.toContain(mail.code);
  });

  it('an Employee Workspace person resets with the emailed link: password changes, every session ends, link is single-use', async () => {
    const m = await addMember(pool, t, { name: 'Esha Employee' });
    const session = await login(app, m.email);
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    const { token, body } = await inbox(m.email);
    expect(body).toContain('http://localhost:3000/reset-password?token=');

    const check = await api(app).post('/auth/password-reset/check').send({ token });
    expect(check.body).toMatchObject({ valid: true });
    expect(check.body.email).not.toBe(m.email);

    expect((await api(app).post('/auth/password-reset/complete').send({ token, newPassword: 'short' })).status).toBe(422);
    expect((await api(app).post('/auth/password-reset/complete').send({ token, newPassword: PASSWORD })).body.error.code).toBe('same_password');
    const done = await api(app).post('/auth/password-reset/complete').send({ token, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);

    // The old session is gone, the old password no longer works, the new one does.
    expect((await api(app).post('/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
    expect((await api(app).post('/auth/login').send({ email: m.email, password: PASSWORD })).status).toBe(401);
    expect((await api(app).post('/auth/login').send({ email: m.email, password: NEW_PASSWORD })).body.status).toBe('ok');
    // The link works once.
    expect((await api(app).post('/auth/password-reset/complete').send({ token, newPassword: 'Another-Secret-77!' })).body.error.code).toBe('reset_link_invalid');
    expect((await api(app).post('/auth/password-reset/check').send({ token })).body).toEqual({ valid: false });
    // A confirmation email goes out, and the stored copy of the reset email no longer holds the link once sent.
    expect(await pool.one('email_messages', { to_email: m.email, template: 'password_reset_done' })).toBeTruthy();
    const row = await pool.one('password_resets', { subject_id: m.userId, status: 'completed' });
    expect(row).toMatchObject({ level: 'employee', sessions_revoked: 1, tenant_ids: [t.id] });
    // The workspace's own audit trail has the request and the completion.
    const audit = await pool.find('audit_events', { tenant_id: t.id, resource_id: m.userId });
    expect(audit.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.password_reset_requested', 'auth.password_reset_completed']));
  });

  it('the phone app resets with email + 6-digit code; five wrong codes stop the request', async () => {
    const m = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hari HR' });
    await api(app).post('/auth/password-reset/request').set('x-crew-client', 'mobile').send({ email: m.email });
    const { code } = await inbox(m.email);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await api(app).post('/auth/password-reset/complete').send({ email: m.email, code: wrong, newPassword: NEW_PASSWORD });
    expect(bad.body.error.code).toBe('reset_code_invalid');
    const ok = await api(app).post('/auth/password-reset/complete').send({ email: m.email, code, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(await pool.one('password_resets', { subject_id: m.userId, status: 'completed' })).toMatchObject({ level: 'hr', client: 'mobile', code_attempts: 1 });

    const n = await addMember(pool, t);
    await api(app).post('/auth/password-reset/request').send({ email: n.email });
    const real = (await inbox(n.email)).code;
    const miss = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await api(app).post('/auth/password-reset/complete').send({ email: n.email, code: miss, newPassword: NEW_PASSWORD });
    // Even the right code no longer works.
    expect((await api(app).post('/auth/password-reset/complete').send({ email: n.email, code: real, newPassword: NEW_PASSWORD })).body.error.code).toBe('reset_code_invalid');
    expect(await pool.one('password_resets', { subject_id: n.userId }, { sort: { created_at: -1 } })).toMatchObject({ status: 'locked' });
  });

  it('only the newest link works, three emails an hour at most, and a reset clears a sign-in lock', async () => {
    const m = await addMember(pool, t);
    await pool.update('users', { id: m.userId }, { $set: { failed_login_count: 5, locked_until: new Date(Date.now() + 15 * 60_000) } });
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    const first = await inbox(m.email);
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    const second = await inbox(m.email);
    expect(second.token).not.toBe(first.token);
    expect((await api(app).post('/auth/password-reset/check').send({ token: first.token })).body.valid).toBe(false);
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    const third = await inbox(m.email);
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    expect((await inbox(m.email)).token).toBe(third.token);
    expect(await pool.one('password_resets', { subject_id: m.userId }, { sort: { created_at: -1 } })).toMatchObject({ status: 'limited' });

    expect((await api(app).post('/auth/password-reset/complete').send({ token: third.token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await api(app).post('/auth/login').send({ email: m.email, password: NEW_PASSWORD })).body.status).toBe('ok');
  });

  it('a reset keeps two-step verification: the code is still asked at sign-in', async () => {
    const m = await addMember(pool, t);
    await pool.update('users', { id: m.userId }, { $set: { mfa_enabled: true } });
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    await api(app).post('/auth/password-reset/complete').send({ token: (await inbox(m.email)).token, newPassword: NEW_PASSWORD });
    expect((await api(app).post('/auth/login').send({ email: m.email, password: NEW_PASSWORD })).body.status).toBe('mfa_required');
  });

  it('an expired link does not work, and a suspended person gets no email', async () => {
    const m = await addMember(pool, t);
    await api(app).post('/auth/password-reset/request').send({ email: m.email });
    const { token } = await inbox(m.email);
    await pool.update('password_resets', { subject_id: m.userId }, { $set: { expires_at: new Date(Date.now() - 1000) } });
    expect((await api(app).post('/auth/password-reset/complete').send({ token, newPassword: NEW_PASSWORD })).body.error.code).toBe('reset_link_invalid');

    const s = await addMember(pool, t);
    await pool.update('memberships', { id: s.membershipId }, { $set: { status: 'suspended' } });
    await api(app).post('/auth/password-reset/request').send({ email: s.email });
    expect(await pool.one('email_messages', { to_email: s.email })).toBeUndefined();
    expect(await pool.one('password_resets', { subject_id: s.userId })).toMatchObject({ status: 'inactive' });
  });

  it('the Super Workspace sees its own people\'s resets, never another company\'s or unknown addresses; HR and Employee Workspace do not', async () => {
    const mine = await addMember(pool, t, { name: 'Mine Person' });
    const theirs = await addMember(pool, other, { name: 'Their Person' });
    await api(app).post('/auth/password-reset/request').send({ email: mine.email });
    await api(app).post('/auth/password-reset/request').send({ email: theirs.email });

    const list = await api(app, superToken).get('/password-resets?limit=200');
    expect(list.status).toBe(200);
    const emails = list.body.items.map((r: { email: string }) => r.email);
    expect(emails).toContain(mine.email);
    expect(emails).not.toContain(theirs.email);
    expect(list.body.items.every((r: { status: string }) => r.status !== 'no_account')).toBe(true);
    const row = list.body.items.find((r: { email: string }) => r.email === mine.email);
    expect(row).toMatchObject({ level: 'employee', status: 'pending', workspaces: [{ id: t.id, level: 'employee' }] });
    expect(list.body.summary.requested).toBeGreaterThan(0);

    const hr = await addMember(pool, t, { roles: ['hr_admin'] });
    const hrToken = (await login(app, hr.email)).accessToken;
    expect((await api(app, hrToken).get('/password-resets')).status).toBe(403);
    const emp = await addMember(pool, t);
    const empToken = (await login(app, emp.email)).accessToken;
    expect((await api(app, empToken).get('/password-resets')).status).toBe(403);
  });

  it('the Console sees every level, filters by level and status, and resets its own admins\' passwords', async () => {
    const hrPerson = await addMember(pool, other, { roles: ['hr_admin'] });
    const employee = await addMember(pool, other);
    for (const e of [hrPerson.email, employee.email]) await api(app).post('/auth/password-reset/request').send({ email: e });
    await api(app).post('/auth/password-reset/request').send({ email: `ghost.${stamp}@nowhere.test` });
    const admin = await consoleAdmin('support');
    await api(app).post('/platform/auth/password-reset/request').send({ email: admin.email });
    const mail = await inbox(admin.email);
    expect(mail.body).toContain('http://localhost:3001/reset-password?token=');
    // A Console link is not a workspace link, and the other way round.
    expect((await api(app).post('/auth/password-reset/check').send({ token: mail.token })).body.valid).toBe(false);
    expect((await api(app).post('/platform/auth/password-reset/check').send({ token: mail.token })).body.valid).toBe(true);
    const done = await api(app).post('/platform/auth/password-reset/complete').send({ token: mail.token, newPassword: NEW_PASSWORD });
    expect(done.status).toBe(200);
    // Two-step verification is still asked.
    expect((await api(app).post('/platform/auth/login').send({ email: admin.email, password: NEW_PASSWORD })).body.status).toBe('mfa_required');
    expect((await api(app).post('/platform/auth/login').send({ email: admin.email, password: NEW_PASSWORD, code: currentTotp(admin.secret) })).body.status).toBe('ok');

    const all = await api(app, consoleToken).get('/platform/password-resets?limit=200');
    expect(all.status).toBe(200);
    const levels = new Set(all.body.items.map((r: { level: string | null }) => r.level));
    for (const l of ['console', 'hr', 'employee']) expect(levels).toContain(l);
    expect(all.body.items.some((r: { status: string }) => r.status === 'no_account')).toBe(true);
    const consoleOnly = await api(app, consoleToken).get('/platform/password-resets?level=console&status=completed');
    expect(consoleOnly.body.items.map((r: { email: string }) => r.email)).toContain(admin.email);
    expect(consoleOnly.body.items.every((r: { level: string; status: string }) => r.level === 'console' && r.status === 'completed')).toBe(true);
    const byTenant = await api(app, consoleToken).get(`/platform/password-resets?tenantId=${other.id}`);
    expect(byTenant.body.items.every((r: { workspaces: { id: string }[] }) => r.workspaces.some((w) => w.id === other.id))).toBe(true);
    // The email's delivery is shown (no mail server in tests: it waits in the queue).
    expect(all.body.items.find((r: { email: string }) => r.email === admin.email).delivery).toBe('queued');
    // Workspace people cannot read the Console list.
    expect((await api(app, superToken).get('/platform/password-resets')).status).toBe(401);
  });

  it('a Super Workspace owner resets too, and shows as Super Workspace', async () => {
    await api(app).post('/auth/password-reset/request').send({ email: other.ownerEmail });
    await api(app).post('/auth/password-reset/complete').send({ token: (await inbox(other.ownerEmail)).token, newPassword: NEW_PASSWORD });
    expect(await pool.one('password_resets', { email: other.ownerEmail, status: 'completed' })).toMatchObject({ level: 'super', tenant_ids: [other.id] });
  });
});
