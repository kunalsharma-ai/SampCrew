import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestTenant } from './helpers';

describe('authentication', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('self sign-up creates a workspace, owner, trial subscription and audit record', async () => {
    const slug = `signup-${Date.now()}`;
    const res = await api(app).post('/auth/signup').send({
      companyName: 'Acme Logistics', slug, fullName: 'Asha Rao', email: `asha@${slug}.test`, password: 'Str0ng-Passphrase',
      countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', acceptTerms: true,
    });
    expect(res.status).toBe(201);
    const me = await api(app, res.body.accessToken).get('/me');
    expect(me.body.tenant.slug).toBe(slug);
    expect(me.body.membership.roles.map((r: { key: string }) => r.key)).toContain('tenant_owner');
    expect(me.body.subscription).toMatchObject({ plan: 'professional', status: 'trialing' });
    expect(me.body.features).toContain('recruitment');
    const audit = await pool.query(`select action from audit_events where tenant_id = $1 order by chain_seq`, [res.body.tenantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['tenant.created', 'auth.login']);
  });

  it('rejects a duplicate slug and an existing email', async () => {
    const body = { companyName: 'X', slug: t.slug, fullName: 'Y', email: 'new@x.test', password: 'Str0ng-Passphrase', countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', acceptTerms: true };
    expect((await api(app).post('/auth/signup').send(body)).body.error.code).toBe('slug_taken');
    expect((await api(app).post('/auth/signup').send({ ...body, slug: `fresh-${Date.now()}`, email: t.ownerEmail })).body.error.code).toBe('account_exists');
  });

  it('validates input with field-level errors', async () => {
    const res = await api(app).post('/auth/signup').send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password', 'slug']));
  });

  it('locks the account after repeated wrong passwords', async () => {
    const m = await addMember(pool, t);
    for (let i = 0; i < 5; i++) expect((await api(app).post('/auth/login').send({ email: m.email, password: 'wrong-password' })).status).toBe(401);
    const locked = await api(app).post('/auth/login').send({ email: m.email, password: PASSWORD });
    expect(locked.status).toBe(429);
  });

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const first = await login(app, t.ownerEmail);
    const second = await api(app).post('/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(second.status).toBe(200);
    // Replaying the old refresh token signals theft.
    expect((await api(app).post('/auth/refresh').send({ refreshToken: first.refreshToken })).status).toBe(401);
    // The legitimately rotated token is now revoked too.
    expect((await api(app).post('/auth/refresh').send({ refreshToken: second.body.refreshToken })).status).toBe(401);
    expect((await api(app, second.body.accessToken).get('/me')).status).toBe(401);
  });

  it('logout invalidates the access token immediately', async () => {
    const s = await login(app, t.ownerEmail);
    expect((await api(app, s.accessToken).post('/auth/logout')).status).toBe(204);
    expect((await api(app, s.accessToken).get('/me')).status).toBe(401);
  });

  it('enrols TOTP MFA, then requires it at sign-in, and unlocks MFA-only permissions', async () => {
    const m = await addMember(pool, t, { roles: ['org_admin'] });
    let s = await login(app, m.email);
    // roles:manage requires an MFA session.
    const denied = await api(app, s.accessToken).post('/roles').send({ key: 'custom_x', name: 'X', grants: [{ permission: 'org:read', scope: 'tenant' }] });
    expect(denied.body.error.code).toBe('mfa_required');

    const setup = await api(app, s.accessToken).post('/me/mfa/setup');
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await api(app, s.accessToken).post('/me/mfa/enable').send({ code: '000000' })).status).toBe(400);
    const enabled = await api(app, s.accessToken).post('/me/mfa/enable').send({ code: currentTotp(setup.body.secret) });
    expect(enabled.status).toBe(200);
    expect((await api(app, enabled.body.accessToken).get('/me')).body.session.mfa).toBe(true);

    const challenge = await api(app).post('/auth/login').send({ email: m.email, password: PASSWORD });
    expect(challenge.body.status).toBe('mfa_required');
    expect((await api(app).post('/auth/mfa/verify').send({ mfaToken: challenge.body.mfaToken, code: '123456' })).status).toBe(401);
    const ok = await api(app).post('/auth/mfa/verify').send({ mfaToken: challenge.body.mfaToken, code: currentTotp(setup.body.secret) });
    expect(ok.body.status).toBe('ok');
    s = ok.body;
    const allowed = await api(app, s.accessToken).post('/roles').send({ key: 'custom_x', name: 'X', grants: [{ permission: 'org:read', scope: 'tenant' }] });
    expect(allowed.status).toBe(201);
  });

  it('offers a workspace picker to people in several tenants', async () => {
    const other = await createTenant(pool);
    const userId = (await pool.query(`select id from users where email = $1`, [t.ownerEmail])).rows[0].id;
    await pool.query(`insert into memberships (tenant_id, user_id, status, legal_entity_id) values ($1, $2, 'active', $3)`, [other.id, userId, other.legalEntityId]);
    const res = await api(app).post('/auth/login').send({ email: t.ownerEmail, password: PASSWORD });
    expect(res.body.status).toBe('select_tenant');
    expect(res.body.tenants.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([t.id, other.id]));
    const picked = await api(app).post('/auth/select-tenant').send({ selectToken: res.body.selectToken, tenantId: other.id });
    expect(picked.body.status).toBe('ok');
    const me = await api(app, picked.body.accessToken).get('/me');
    expect(me.body.tenant.id).toBe(other.id);
    expect(me.body.tenants).toHaveLength(2);
    // Switching back issues a token for the original workspace.
    const back = await api(app, picked.body.accessToken).post('/auth/switch-tenant').send({ tenantId: t.id });
    expect((await api(app, back.body.accessToken).get('/me')).body.tenant.id).toBe(t.id);
  });

  it('invites a member who accepts and signs in with the roles they were given', async () => {
    const plain = await login(app, t.ownerEmail, PASSWORD, t.slug);
    const noMfa = await api(app, plain.accessToken).post('/members/invite').send({ email: `x.${Date.now()}@example.test`, fullName: 'X', roleKeys: ['recruiter'] });
    expect(noMfa.body.error.code).toBe('mfa_required');
    const owner = await loginWithMfa(app, pool, t.ownerEmail, t.slug);
    const inv = await api(app, owner.accessToken).post('/members/invite').send({ email: `new.hire.${Date.now()}@example.test`, fullName: 'New Hire', roleKeys: ['recruiter'] });
    expect(inv.status).toBe(201);
    expect(inv.body.member.status).toBe('invited');
    const token = new URL(inv.body.inviteUrl).searchParams.get('token')!;
    expect((await api(app).get(`/auth/invitations/${token}`)).body.tenantName).toContain('Tenant');
    const accepted = await api(app).post('/auth/invitations/accept').send({ token, fullName: 'New Hire', password: 'Another-Str0ng-Pass' });
    expect(accepted.status).toBe(200);
    const me = await api(app, accepted.body.accessToken).get('/me');
    expect(me.body.membership.roles.map((r: { key: string }) => r.key).sort()).toEqual(['employee', 'recruiter']);
    // Single use.
    expect((await api(app).post('/auth/invitations/accept').send({ token, fullName: 'X', password: 'Another-Str0ng-Pass' })).status).toBe(404);
  });
});
