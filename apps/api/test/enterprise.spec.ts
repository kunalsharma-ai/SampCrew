import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestTenant } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const oidcStub = require('../../../e2e/oidc-stub.cjs') as { start: (o: object) => Promise<Stub> };
interface Stub { issuer: string; clientId: string; clientSecret: string; state: { user: Record<string, unknown>; tamper: string | null; authorizeRequests: Record<string, string>[] }; close: () => Promise<void> }

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
const today = () => new Date().toISOString().slice(0, 10);
const plus = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

describe('Enterprise: single sign-on, SCIM provisioning and privacy requests', () => {
  let app: INestApplication;
  let pool: Pool;
  let idp: Stub;
  let ent: TestTenant;
  let other: TestTenant;
  let biz: TestTenant;
  const tokens: Record<string, string> = {};
  const people: Record<string, { email: string; membershipId: string; userId: string }> = {};
  const ids: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const fails = (res: { status: number; body: any }, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(res.body.error.code).toBe(code);
    return res.body;
  };

  /** Plays the browser: follow the provider's redirect, then hand code and state to CREW like the web app does. */
  const ssoRound = async (authorizationUrl: string) => {
    const r = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const back = new URL(r.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('http://localhost:3000/sso/callback');
    return api(app).post('/auth/sso/callback').send({ code: back.searchParams.get('code'), state: back.searchParams.get('state') });
  };
  const signInWithSso = async (email: string, user: Record<string, unknown> = {}) => {
    Object.assign(idp.state.user, { email, emailVerified: true, amr: ['pwd'], ...user });
    const start = ok(await api(app).post('/auth/sso/start').send({ email }));
    return ssoRound(start.authorizationUrl);
  };

  const scim = (token: string) => ({
    get: (p: string) => request(app.getHttpServer()).get(`/api/v1/scim/v2${p}`).set('authorization', `Bearer ${token}`),
    post: (p: string, body: object) => request(app.getHttpServer()).post(`/api/v1/scim/v2${p}`).set('authorization', `Bearer ${token}`).set('content-type', 'application/scim+json').send(JSON.stringify(body)),
    put: (p: string, body: object) => request(app.getHttpServer()).put(`/api/v1/scim/v2${p}`).set('authorization', `Bearer ${token}`).set('content-type', 'application/scim+json').send(JSON.stringify(body)),
    patch: (p: string, body: object) => request(app.getHttpServer()).patch(`/api/v1/scim/v2${p}`).set('authorization', `Bearer ${token}`).set('content-type', 'application/scim+json').send(JSON.stringify(body)),
    del: (p: string) => request(app.getHttpServer()).delete(`/api/v1/scim/v2${p}`).set('authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    idp = await oidcStub.start({ port: 0 });
    app = await createApp();
    pool = adminPool();
    ent = await createTenant(pool, { plan: 'enterprise' });
    other = await createTenant(pool, { plan: 'enterprise' });
    biz = await createTenant(pool);
    people.hr = await addMember(pool, ent, { roles: ['hr_admin'], name: 'Hana HR' });
    people.worker = await addMember(pool, ent, { name: 'Wanda Worker' });
    people.manager = await addMember(pool, ent, { roles: ['department_manager'], name: 'Mo Manager' });
    tokens.owner = (await loginWithMfa(app, pool, ent.ownerEmail)).accessToken;
    tokens.otherOwner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
    tokens.bizOwner = (await loginWithMfa(app, pool, biz.ownerEmail)).accessToken;
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.ownerNoMfa = (await login(app, ent.ownerEmail)).accessToken;
    tokens.worker = (await login(app, people.worker.email)).accessToken;
    tokens.manager = (await loginWithMfa(app, pool, people.manager.email)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await idp?.close();
  });

  const domain = () => `${ent.slug}.test`;
  const settings = () => ({ issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, domains: [domain()] });

  describe('single sign-on', () => {
    it('is for owners with two-step verification on the Enterprise plan', async () => {
      fails(await as('hr').get('/security/sso'), 403);
      fails(await as('ownerNoMfa').get('/security/sso'), 403, 'mfa_required');
      fails(await as('bizOwner').get('/security/sso'), 402);
      expect(ok(await as('owner').get('/security/sso'))).toEqual({ connection: null, redirectUri: 'http://localhost:3000/sso/callback' });
    });

    it('checks the provider before saving, keeps the secret encrypted and claims the domain', async () => {
      fails(await as('owner').put('/security/sso').send({ ...settings(), issuer: 'http://127.0.0.1:9/nothing' }), 400, 'idp_unreachable');
      fails(await as('owner').put('/security/sso').send({ ...settings(), issuer: `${idp.issuer}/` }), 400, 'idp_issuer_mismatch');
      fails(await as('owner').put('/security/sso').send({ ...settings(), clientSecret: undefined }), 422);
      const s = ok(await as('owner').put('/security/sso').send(settings()));
      expect(s.connection).toMatchObject({ status: 'draft', issuer: idp.issuer, domains: [domain()], verifiedAt: null, enforced: false });
      expect(JSON.stringify(s)).not.toContain(idp.clientSecret);
      const row = await pool.query('select client_secret_enc from sso_connections where tenant_id = $1', [ent.id]);
      expect(row.rows[0].client_secret_enc).not.toContain(idp.clientSecret);
      fails(await as('otherOwner').put('/security/sso').send({ ...settings() }), 409, 'domain_taken');
      // Not switched on until a test passes.
      fails(await as('owner').post('/security/sso/status').send({ status: 'active' }), 409, 'sso_not_tested');
      fails(await api(app).post('/auth/sso/start').send({ email: people.worker.email }), 404);
    });

    it('passes a test sign-in through the provider with PKCE, then switches on', async () => {
      const { authorizationUrl } = ok(await as('owner').post('/security/sso/test'));
      const u = new URL(authorizationUrl);
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: idp.clientId, code_challenge_method: 'S256', scope: 'openid email profile' });
      Object.assign(idp.state.user, { email: ent.ownerEmail, emailVerified: true });
      expect(ok(await ssoRound(authorizationUrl))).toEqual({ status: 'sso_test_passed', email: ent.ownerEmail.toLowerCase() });
      const s = ok(await as('owner').post('/security/sso/status').send({ status: 'active' }));
      expect(s.connection).toMatchObject({ status: 'active', verifiedEmail: ent.ownerEmail.toLowerCase() });
    });

    it('signs members in, and passes on whether the provider used more than a password', async () => {
      const r = ok(await signInWithSso(people.worker.email));
      expect(r.status).toBe('ok');
      expect(claims(r.accessToken)).toMatchObject({ tid: ent.id, mid: people.worker.membershipId, mfa: false });
      expect(ok(await api(app, r.accessToken).get('/me')).user.email).toBe(people.worker.email);
      const strong = ok(await signInWithSso(people.manager.email, { amr: ['pwd', 'mfa'] }));
      expect(claims(strong.accessToken).mfa).toBe(true);
      const audit = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'auth.sso_login'`, [ent.id]);
      expect(audit.rows[0].n).toBe(2);
    });

    it('refuses tokens that do not check out, and every code and state works once', async () => {
      for (const tamper of ['wrong_nonce', 'bad_signature', 'wrong_aud']) {
        idp.state.tamper = tamper;
        fails(await signInWithSso(people.worker.email), 401);
      }
      idp.state.tamper = null;
      fails(await signInWithSso(people.worker.email, { emailVerified: false }), 401);
      // The provider vouches for an address outside the workspace's domains.
      Object.assign(idp.state.user, { email: 'mallory@elsewhere.test', emailVerified: true });
      const start = ok(await api(app).post('/auth/sso/start').send({ email: people.worker.email }));
      fails(await ssoRound(start.authorizationUrl), 401);
      // Replaying a finished sign-in.
      Object.assign(idp.state.user, { email: people.worker.email });
      const s2 = ok(await api(app).post('/auth/sso/start').send({ email: people.worker.email }));
      const r = await fetch(s2.authorizationUrl, { redirect: 'manual' });
      const back = new URL(r.headers.get('location')!);
      const body = { code: back.searchParams.get('code'), state: back.searchParams.get('state') };
      ok(await api(app).post('/auth/sso/callback').send(body));
      fails(await api(app).post('/auth/sso/callback').send(body), 401);
      const failed = await pool.query(`select metadata->>'reason' as reason from audit_events where tenant_id = $1 and action = 'auth.sso_failed' order by id`, [ent.id]);
      expect(failed.rows.map((x) => x.reason).join(' | ')).toMatch(/nonce.*verify.*verify.*verified.*domains/s);
    });

    it('turns away people who are not members unless just-in-time provisioning is on', async () => {
      const newcomer = `newcomer@${domain()}`;
      fails(await signInWithSso(newcomer), 403);
      ok(await as('owner').put('/security/sso').send({ issuer: idp.issuer, clientId: idp.clientId, domains: [domain()], jitProvisioning: true }));
      // Same provider and client: still tested and on.
      expect(ok(await as('owner').get('/security/sso')).connection).toMatchObject({ status: 'active', jitProvisioning: true });
      const r = ok(await signInWithSso(newcomer, { name: 'Nia Newcomer' }));
      const m = await pool.query(
        `select m.status, m.provisioned_by, array_agg(r.key) as roles from memberships m join role_assignments ra on ra.membership_id = m.id join roles r on r.id = ra.role_id where m.id = $1 group by m.id`,
        [claims(r.accessToken).mid],
      );
      expect(m.rows[0]).toMatchObject({ status: 'active', provisioned_by: 'sso', roles: ['employee'] });
    });

    it('can be required for members; owners keep a password as a way in', async () => {
      ok(await as('owner').post('/security/sso/status').send({ status: 'active', enforced: true }));
      fails(await api(app).post('/auth/login').send({ email: people.worker.email, password: PASSWORD }), 403, 'sso_required');
      // Members' password sessions were ended; the owner's were not.
      expect((await as('worker').get('/me')).status).toBe(401);
      ok(await as('owner').get('/security/sso'));
      expect((await api(app).post('/auth/login').send({ email: ent.ownerEmail, password: PASSWORD })).body.status).toMatch(/ok|mfa_required/);
      tokens.worker = ok(await signInWithSso(people.worker.email)).accessToken;
      // Changing the provider takes it back to draft and stops requiring it until tested again.
      const s = ok(await as('owner').put('/security/sso').send({ ...settings(), clientSecret: 'a-new-secret' }));
      expect(s.connection).toMatchObject({ status: 'draft', enforced: false, verifiedAt: null });
      ok(await api(app).post('/auth/login').send({ email: people.hr.email, password: PASSWORD }));
      // HR and the manager were signed out when it was required; they sign in again for the tests below.
      tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
      tokens.manager = (await loginWithMfa(app, pool, people.manager.email)).accessToken;
    });
  });

  describe('SCIM provisioning', () => {
    it('authenticates with a workspace token shown once', async () => {
      fails(await as('hr').post('/security/scim/token'), 403);
      const t = ok(await as('owner').post('/security/scim/token'), 201);
      expect(t.token).toMatch(/^scim_[a-z0-9]{10}_/);
      tokens.scim = t.token;
      tokens.otherScim = ok(await as('otherOwner').post('/security/scim/token'), 201).token;
      expect((await scim('scim_nope').get('/Users')).status).toBe(401);
      // A SCIM token is not a session and an API session is not a SCIM token.
      expect((await api(app, tokens.scim).get('/me')).status).toBe(401);
      expect((await scim(tokens.owner!).get('/Users')).status).toBe(401);
      const cfg = await scim(tokens.scim).get('/ServiceProviderConfig');
      expect(cfg.body.patch.supported).toBe(true);
    });

    it('creates, finds, updates and deactivates users the way identity providers call it', async () => {
      const email = `sam.scim@${domain()}`;
      const created = await scim(tokens.scim!).post('/Users', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: email, externalId: 'okta-001', active: true,
        name: { givenName: 'Sam', familyName: 'Scim' }, emails: [{ value: email, primary: true, type: 'work' }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ userName: email, externalId: 'okta-001', active: true, name: { givenName: 'Sam', familyName: 'Scim' } });
      ids.scimUser = created.body.id;
      const dup = await scim(tokens.scim!).post('/Users', { userName: email });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ scimType: 'uniqueness', status: '409', schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'] });
      const found = await scim(tokens.scim!).get(`/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`);
      expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id: ids.scimUser }] });
      expect((await scim(tokens.scim!).get(`/Users?filter=${encodeURIComponent('name.familyName co "S"')}`)).body.scimType).toBe('invalidFilter');
      // The other workspace's token sees none of it.
      expect((await scim(tokens.otherScim!).get(`/Users/${ids.scimUser}`)).status).toBe(404);
      expect((await scim(tokens.otherScim!).get(`/Users?filter=${encodeURIComponent(`userName eq "${email}"`)}`)).body.totalResults).toBe(0);

      // They sign in through single sign-on (set up again after the earlier change to a secret the provider does not know).
      ok(await as('owner').put('/security/sso').send(settings()));
      Object.assign(idp.state.user, { email: ent.ownerEmail });
      ok(await ssoRound(ok(await as('owner').post('/security/sso/test')).authorizationUrl));
      ok(await as('owner').post('/security/sso/status').send({ status: 'active' }));
      const session = ok(await signInWithSso(email)).accessToken;
      expect((await api(app, session).get('/me')).status).toBe(200);

      const off = await scim(tokens.scim!).patch(`/Users/${ids.scimUser}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', value: { active: false } }] });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.active).toBe(false);
      expect((await api(app, session).get('/me')).status).toBe(401);
      fails(await signInWithSso(email), 403);
      const on = await scim(tokens.scim!).put(`/Users/${ids.scimUser}`, { userName: email, externalId: 'okta-001', active: true, name: { givenName: 'Samira', familyName: 'Scim' } });
      expect(on.body).toMatchObject({ active: true, displayName: 'Samira Scim' });
      expect((await scim(tokens.scim!).del(`/Users/${ids.scimUser}`)).status).toBe(204);
      expect((await scim(tokens.scim!).get(`/Users/${ids.scimUser}`)).body.active).toBe(false);
      const owner = await pool.query(`select m.id from memberships m join users u on u.id = m.user_id where u.email = $1 and m.tenant_id = $2`, [ent.ownerEmail, ent.id]);
      expect((await scim(tokens.scim!).patch(`/Users/${owner.rows[0].id}`, { Operations: [{ op: 'replace', path: 'active', value: false }] })).body.scimType).toBe('mutability');
      const log = ok(await as('owner').get('/security/scim'));
      expect(log.events.map((e: any) => `${e.method} ${e.status}`)).toEqual(expect.arrayContaining(['POST 201', 'POST 409', 'PATCH 200', 'DELETE 204', 'PATCH 400']));
      expect(log.token.prefix).toBe(tokens.scim!.slice(5, 15));
      const audit = await pool.query(`select action from audit_events where tenant_id = $1 and resource_id = $2 order by id`, [ent.id, ids.scimUser]);
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['membership.provisioned', 'membership.suspended', 'membership.reactivated']));
    });

    it('stops working when revoked or replaced', async () => {
      const next = ok(await as('owner').post('/security/scim/token'), 201).token;
      expect((await scim(tokens.scim!).get('/Users')).status).toBe(401);
      expect((await scim(next).get('/Users')).status).toBe(200);
      ok(await as('owner').post('/security/scim/token/revoke'));
      expect((await scim(next).get('/Users')).status).toBe(401);
    });
  });

  describe('privacy requests', () => {
    let employeeId: string;
    let leaverId: string;
    let leaver: { email: string; membershipId: string; userId: string };

    beforeAll(async () => {
      const hired = ok(await as('hr').post('/employees').send({ legalEntityId: ent.legalEntityId, firstName: 'Pia', lastName: 'Private', dateOfJoining: '2023-01-02', onboardingTemplateId: null, personalEmail: 'pia@home.example', phone: '+44 7700 900123' }), 201);
      employeeId = hired.employee.id;
      leaver = await addMember(pool, ent, { name: 'Lou Leaver' });
      const l = ok(await as('hr').post('/employees').send({ legalEntityId: ent.legalEntityId, firstName: 'Lou', lastName: 'Leaver', dateOfJoining: '2022-01-03', membershipId: leaver.membershipId, onboardingTemplateId: null, personalEmail: 'lou@home.example' }), 201);
      leaverId = l.employee.id;
      ok(await as('hr').put(`/employees/${leaverId}/sensitive`).send({ bankName: 'Test Bank', bankAccount: '12345678', taxId: 'ABCDE1234F' }));
    });

    it('is for HR and owners with two-step verification', async () => {
      fails(await as('manager').get('/privacy/requests'), 403);
      fails(await as('worker').post('/privacy/requests').send({ employeeId, kind: 'access', source: 'Email' }), 403);
      ok(await as('hr').get('/privacy/requests'));
    });

    it('logs an access request with a due date and exports the person\'s data', async () => {
      const r = ok(await as('hr').post('/privacy/requests').send({ employeeId, kind: 'access', source: 'Email from Pia to HR on 1 November' }), 201);
      fails(await as('hr').post('/privacy/requests').send({ employeeId, kind: 'access', source: 'Again' }), 409, 'request_open');
      const listed = ok(await as('hr').get('/privacy/requests?status=open'));
      expect(listed.find((x: any) => x.id === r.id)).toMatchObject({ kind: 'access', dueOn: expect.any(String), overdue: false, employeeName: 'Pia Private' });
      const done = ok(await as('hr').post(`/privacy/requests/${r.id}/export`).send({ note: 'Sent to Pia by secure email' }));
      expect(done.records.employment_records).toBeGreaterThan(0);
      const file = await request(app.getHttpServer()).get(`/api/v1/privacy/requests/${r.id}/export`).set('authorization', `Bearer ${tokens.hr}`).buffer(true).parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c));
        res.on('end', () => cb(null, d));
      });
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toMatch(/attachment; filename="personal-data-/);
      const data = JSON.parse(file.body as string);
      expect(data).toMatchObject({ format: 'crew-personal-data-export/1', employee: { first_name: 'Pia', personal_email: 'pia@home.example' } });
      expect(Object.keys(data.records)).toContain('employment_records');
      expect(JSON.stringify(data)).not.toMatch(/_enc"|storage_key/);
      const audit = await pool.query(`select action from audit_events where tenant_id = $1 and resource_id = $2 order by id`, [ent.id, r.id]);
      expect(audit.rows.map((x) => x.action)).toEqual(['privacy.request_logged', 'privacy.export_prepared', 'privacy.export_downloaded']);
      fails(await as('hr').post(`/privacy/requests/${r.id}/reject`).send({ note: 'Too late' }), 409, 'request_closed');
    });

    it('does not erase someone who still works here', async () => {
      const r = ok(await as('hr').post('/privacy/requests').send({ employeeId, kind: 'erasure', source: 'Letter' }), 201);
      fails(await as('hr').post(`/privacy/requests/${r.id}/erase`).send({ note: 'Asked to' }), 409, 'still_employed');
      ok(await as('hr').post(`/privacy/requests/${r.id}/reject`).send({ note: 'Pia still works here; explained by phone' }));
      expect(ok(await as('hr').get(`/privacy/requests/${r.id}`))).toMatchObject({ status: 'rejected', decisionNote: 'Pia still works here; explained by phone' });
    });

    it('erases a leaver\'s identity, contact details and login, and keeps what the law needs', async () => {
      ok(await as('hr').post(`/employees/${leaverId}/exit`).send({ exitType: 'resignation', resignationDate: plus(today(), -30), lastWorkingDay: plus(today(), -1) }), 201);
      const access = ok(await as('hr').post('/privacy/requests').send({ employeeId: leaverId, kind: 'access', source: 'Portal' }), 201);
      ok(await as('hr').post(`/privacy/requests/${access.id}/export`).send({ note: 'Prepared' }));
      const r = ok(await as('hr').post('/privacy/requests').send({ employeeId: leaverId, kind: 'erasure', source: 'Email from Lou' }), 201);
      const before = ok(await as('hr').get(`/privacy/requests/${r.id}`));
      expect(before.erasureRules.map((x: any) => x.action)).toContain('kept');
      const res = ok(await as('hr').post(`/privacy/requests/${r.id}/erase`).send({ note: 'Lou left last month; payroll kept for tax' }));
      expect(res.removed).toMatchObject({ sensitive: 1, loginErased: 1 });
      const e = (await pool.query('select first_name, last_name, employee_code, personal_email, erased_at from employees where id = $1', [leaverId])).rows[0];
      expect(e).toMatchObject({ first_name: 'Erased', last_name: 'person', personal_email: null });
      expect(e.employee_code).toMatch(/^ERASED-/);
      expect(e.erased_at).not.toBeNull();
      expect((await pool.query('select 1 from employee_sensitive where employee_id = $1', [leaverId])).rowCount).toBe(0);
      const u = (await pool.query('select email, full_name, password_hash, status from users where id = $1', [leaver.userId])).rows[0];
      expect(u).toMatchObject({ full_name: 'Erased person', password_hash: null, status: 'disabled' });
      expect(u.email).toMatch(/@erased\.invalid$/);
      // The earlier export was the last copy of the details, so it is gone too.
      fails(await as('hr').get(`/privacy/requests/${access.id}/export`), 409, 'export_deleted');
      // Employment history stays, against the anonymous record.
      expect((await pool.query('select count(*)::int as n from employment_records where employee_id = $1', [leaverId])).rows[0].n).toBeGreaterThan(0);
      fails(await as('hr').post('/privacy/requests').send({ employeeId: leaverId, kind: 'access', source: 'Again' }), 409, 'already_erased');
      // Finished requests cannot be changed, even directly in the database.
      await expect(pool.query(`update privacy_requests set decision_note = 'edited' where id = $1`, [r.id])).rejects.toThrow(/closed/);
      fails(await as('otherOwner').get(`/privacy/requests/${r.id}`), 404);
    });
  });
});
