import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AttendanceService } from '../src/modules/attendance/attendance.service';
import { HrJobsService } from '../src/modules/hr-jobs/hr-jobs.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestTenant } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const samlStub = require('../../../e2e/saml-stub.cjs') as {
  start: (o: object) => Promise<SamlStub>;
  readPostForm: (html: string) => { action: string; samlResponse: string; relayState: string };
};
interface SamlStub { entityId: string; ssoUrl: string; cert: string; state: { user: Record<string, unknown>; tamper: string | null; requests: Record<string, string>[] }; close: () => Promise<void> }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const oidcStub = require('../../../e2e/oidc-stub.cjs') as { start: (o: object) => Promise<OidcStub> };
interface OidcStub { issuer: string; clientId: string; clientSecret: string; state: { user: Record<string, unknown>; tamper: string | null }; close: () => Promise<void> }

const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

describe('Phase 11 hardening', () => {
  let app: INestApplication;
  let pool: Pool;
  let idp: SamlStub;
  let oidc: OidcStub;
  let ent: TestTenant;
  let mob: TestTenant;
  const tokens: Record<string, string> = {};
  const people: Record<string, { email: string; membershipId: string; userId: string }> = {};
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

  /** Plays the browser: the provider's auto-post page, posted on to CREW like the Web Portal's /sso/saml route does. */
  const samlRound = async (authorizationUrl: string) => {
    const r = await fetch(authorizationUrl);
    expect(r.status).toBe(200);
    const form = samlStub.readPostForm(await r.text());
    expect(form.action).toBe('http://localhost:3000/sso/saml');
    return api(app).post('/auth/sso/saml/callback').send({ samlResponse: form.samlResponse, relayState: form.relayState });
  };
  const samlSignIn = async (email: string, user: Record<string, unknown> = {}) => {
    Object.assign(idp.state.user, { email, name: 'Someone', authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport', ...user });
    const start = ok(await api(app).post('/auth/sso/start').send({ email }));
    return samlRound(start.authorizationUrl);
  };

  beforeAll(async () => {
    idp = await samlStub.start({ port: 0 });
    oidc = await oidcStub.start({ port: 0 });
    app = await createApp();
    pool = adminPool();
    ent = await createTenant(pool, { plan: 'enterprise' });
    mob = await createTenant(pool, { plan: 'enterprise' });
    people.worker = await addMember(pool, ent, { name: 'Wanda Worker' });
    people.manager = await addMember(pool, ent, { roles: ['department_manager'], name: 'Mo Manager' });
    people.mobile = await addMember(pool, mob, { name: 'Max Mobile' });
    tokens.owner = (await loginWithMfa(app, pool, ent.ownerEmail)).accessToken;
    tokens.mobOwner = (await loginWithMfa(app, pool, mob.ownerEmail)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await idp?.close();
    await oidc?.close();
  });

  const domain = () => `${ent.slug}.test`;
  const samlSettings = (over: Record<string, unknown> = {}) => ({ protocol: 'saml', idpEntityId: idp.entityId, ssoUrl: idp.ssoUrl, certificate: idp.cert, domains: [domain()], ...over });

  describe('SAML 2.0 single sign-on', () => {
    it("publishes CREW's service provider metadata", async () => {
      const r = await api(app).get('/auth/sso/saml/metadata');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('application/samlmetadata+xml');
      expect(r.text).toContain('entityID="http://localhost:4000/api/v1/auth/sso/saml/metadata"');
      expect(r.text).toContain('Location="http://localhost:3000/sso/saml"');
      const s = ok(await as('owner').get('/security/sso'));
      expect(s.saml).toEqual({ entityId: 'http://localhost:4000/api/v1/auth/sso/saml/metadata', acsUrl: 'http://localhost:3000/sso/saml', metadataUrl: 'http://localhost:4000/api/v1/auth/sso/saml/metadata' });
    });

    it('checks the certificate before saving and shows its fingerprint and expiry', async () => {
      fails(await as('owner').put('/security/sso').send(samlSettings({ certificate: 'not a certificate '.repeat(10) })), 422);
      fails(await as('owner').put('/security/sso').send(samlSettings({ ssoUrl: undefined })), 422);
      const s = ok(await as('owner').put('/security/sso').send(samlSettings()));
      expect(s.connection).toMatchObject({ protocol: 'saml', status: 'draft', issuer: idp.entityId, samlSsoUrl: idp.ssoUrl, domains: [domain()] });
      expect(s.connection.samlCertFingerprint).toMatch(/^[0-9A-F:]{95}$/);
      expect(Date.parse(s.connection.samlCertExpiresAt)).toBeGreaterThan(Date.now());
      fails(await as('owner').post('/security/sso/status').send({ status: 'active' }), 409, 'sso_not_tested');
    });

    it('passes a test sign-in, then signs members in and reads multi-factor from the authentication context', async () => {
      const { authorizationUrl } = ok(await as('owner').post('/security/sso/test'));
      expect(new URL(authorizationUrl).searchParams.get('SAMLRequest')).toBeTruthy();
      Object.assign(idp.state.user, { email: ent.ownerEmail });
      expect(ok(await samlRound(authorizationUrl))).toEqual({ status: 'sso_test_passed', email: ent.ownerEmail.toLowerCase() });
      const req = idp.state.requests.at(-1)!;
      expect(req).toMatchObject({ acs: 'http://localhost:3000/sso/saml', issuer: 'http://localhost:4000/api/v1/auth/sso/saml/metadata' });
      ok(await as('owner').post('/security/sso/status').send({ status: 'active' }));

      const r = ok(await samlSignIn(people.worker.email));
      expect(r.status).toBe('ok');
      expect(claims(r.accessToken)).toMatchObject({ tid: ent.id, mid: people.worker.membershipId, mfa: false });
      const strong = ok(await samlSignIn(people.manager.email.toUpperCase(), { authnContext: 'http://schemas.microsoft.com/claims/multipleauthn' }));
      expect(claims(strong.accessToken)).toMatchObject({ mid: people.manager.membershipId, mfa: true });
    });

    it('refuses responses that do not check out, and every request is answered once', async () => {
      const reasons: string[] = [];
      for (const tamper of ['bad_signature', 'wrong_audience', 'wrong_in_response_to', 'unsigned', 'expired', 'altered']) {
        idp.state.tamper = tamper;
        const body = fails(await samlSignIn(people.worker.email), 401, 'sso_failed');
        expect(body.error.details).toMatchObject({ purpose: 'login' });
        reasons.push(`${tamper}: ${body.error.message}`);
      }
      idp.state.tamper = null;
      expect(reasons.join('\n')).toMatch(
        /bad_signature: .*Invalid signature.*\nwrong_audience: .*audience mismatch.*\nwrong_in_response_to: .*InResponseTo is not valid.*\nunsigned: .*Invalid signature.*\nexpired: .*subject confirmation.*\naltered: .*Invalid signature/,
      );
      // An address outside the workspace's domains.
      Object.assign(idp.state.user, { email: 'mallory@elsewhere.test' });
      fails(await samlRound(ok(await api(app).post('/auth/sso/start').send({ email: people.worker.email })).authorizationUrl), 401);
      // Replaying a response that already signed someone in.
      Object.assign(idp.state.user, { email: people.worker.email });
      const start = ok(await api(app).post('/auth/sso/start').send({ email: people.worker.email }));
      const form = samlStub.readPostForm(await (await fetch(start.authorizationUrl)).text());
      ok(await api(app).post('/auth/sso/saml/callback').send({ samlResponse: form.samlResponse, relayState: form.relayState }));
      fails(await api(app).post('/auth/sso/saml/callback').send({ samlResponse: form.samlResponse, relayState: form.relayState }), 401);
      // A SAML response cannot finish an OpenID Connect state, and the other way round.
      fails(await api(app).post('/auth/sso/callback').send({ code: 'x', state: form.relayState }), 401);
      const failed = await pool.query(`select metadata->>'reason' as reason from audit_events where tenant_id = $1 and action = 'auth.sso_failed' order by id`, [ent.id]);
      expect(failed.rows.length).toBe(7); // six bad responses and the foreign domain; replays name no workspace
      expect(failed.rows.map((x) => x.reason).join(' | ')).toMatch(/did not verify.*domains/s);
    });

    it('needs a new test when the certificate changes', async () => {
      const other = await samlStub.start({ port: 0 });
      try {
        const s = ok(await as('owner').put('/security/sso').send(samlSettings({ certificate: other.cert })));
        expect(s.connection).toMatchObject({ status: 'draft', enforced: false, verifiedAt: null });
        // Same certificate again: stays as it is.
        ok(await as('owner').put('/security/sso').send(samlSettings()));
        // Leaving the certificate out keeps the stored one.
        const kept = ok(await as('owner').put('/security/sso').send(samlSettings({ certificate: undefined })));
        expect(kept.connection.samlCertFingerprint).toBe(ok(await as('owner').get('/security/sso')).connection.samlCertFingerprint);
        const { authorizationUrl } = ok(await as('owner').post('/security/sso/test'));
        Object.assign(idp.state.user, { email: ent.ownerEmail });
        ok(await samlRound(authorizationUrl));
        const again = ok(await as('owner').put('/security/sso').send(samlSettings({ jitProvisioning: true })));
        expect(again.connection).toMatchObject({ status: 'draft' }); // not switched on yet after the re-test
      } finally {
        await other.close();
      }
    });
  });

  describe('single sign-on in the mobile app', () => {
    const mobDomain = () => `${mob.slug}.test`;
    const mobile = () => api(app);
    const start = (body: Record<string, unknown>) => mobile().post('/auth/sso/start').set('x-crew-client', 'mobile').send(body);
    /** The system browser: provider, then the Web Portal callback, which answers with where to send the app. */
    const browser = async (authorizationUrl: string) => {
      const r = await fetch(authorizationUrl, { redirect: 'manual' });
      const back = new URL(r.headers.get('location')!);
      return api(app).post('/auth/sso/callback').send({ code: back.searchParams.get('code'), state: back.searchParams.get('state') });
    };

    beforeAll(async () => {
      ok(await api(app, tokens.mobOwner).put('/security/sso').send({ issuer: oidc.issuer, clientId: oidc.clientId, clientSecret: oidc.clientSecret, domains: [mobDomain()] }));
      const { authorizationUrl } = ok(await api(app, tokens.mobOwner).post('/security/sso/test'));
      Object.assign(oidc.state.user, { email: mob.ownerEmail, emailVerified: true });
      ok(await browser(authorizationUrl));
      ok(await api(app, tokens.mobOwner).post('/security/sso/status').send({ status: 'active', enforced: true }));
    });

    it('only hands sessions to allowed app addresses, with a PKCE challenge', async () => {
      const { challenge } = pkce();
      fails(await start({ email: people.mobile.email }), 422);
      fails(await start({ email: people.mobile.email, returnTo: 'https://evil.example/steal', appChallenge: challenge }), 400, 'return_to_not_allowed');
    });

    it('gives the app a one-time code that only the app holding the verifier can exchange', async () => {
      const { verifier, challenge } = pkce();
      Object.assign(oidc.state.user, { email: people.mobile.email, emailVerified: true, amr: ['pwd', 'mfa'] });
      const s = ok(await start({ email: people.mobile.email, returnTo: 'crew://sso', appChallenge: challenge }));
      const handoff = ok(await browser(s.authorizationUrl));
      expect(handoff.status).toBe('mobile_handoff');
      const to = new URL(handoff.redirectTo);
      expect(`${to.protocol}//${to.host}`).toBe('crew://sso');
      const code = to.searchParams.get('code')!;
      expect(code.length).toBeGreaterThanOrEqual(20);
      // The code alone, or with someone else's verifier, gets nothing; and it is then spent.
      fails(await mobile().post('/auth/sso/exchange').send({ code, verifier: pkce().verifier }), 401);
      fails(await mobile().post('/auth/sso/exchange').send({ code, verifier }), 401);
      const failed = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'auth.sso_failed' and metadata->>'protocol' = 'handoff'`, [mob.id]);
      expect(failed.rows[0].n).toBe(1);

      const s2 = ok(await start({ email: people.mobile.email, returnTo: 'crew://sso', appChallenge: challenge }));
      const code2 = new URL(ok(await browser(s2.authorizationUrl)).redirectTo).searchParams.get('code')!;
      const session = ok(await mobile().post('/auth/sso/exchange').send({ code: code2, verifier }));
      expect(session.status).toBe('ok');
      expect(claims(session.accessToken)).toMatchObject({ tid: mob.id, mid: people.mobile.membershipId, mfa: true });
      const row = await pool.query(`select client from sessions where id = $1`, [claims(session.accessToken).sid]);
      expect(row.rows[0].client).toBe('mobile');
      ok(await api(app, session.accessToken).get('/me'));
      // Used once.
      fails(await mobile().post('/auth/sso/exchange').send({ code: code2, verifier }), 401);
      // Stored hashed.
      const stored = await pool.query(`select code_hash from sso_handoffs where tenant_id = $1`, [mob.id]);
      expect(stored.rows.map((x) => x.code_hash)).not.toContain(code2);
    });

    it('expires codes after two minutes', async () => {
      const { verifier, challenge } = pkce();
      const s = ok(await start({ email: people.mobile.email, returnTo: 'crew://sso', appChallenge: challenge }));
      const code = new URL(ok(await browser(s.authorizationUrl)).redirectTo).searchParams.get('code')!;
      await pool.query(`update sso_handoffs set expires_at = now() - interval '1 second' where tenant_id = $1 and used_at is null`, [mob.id]);
      fails(await mobile().post('/auth/sso/exchange').send({ code, verifier }), 401);
    });
  });
  describe('SCIM Groups mapped to CREW roles', () => {
    const scim = (token: string) => {
      const r = () => request(app.getHttpServer());
      const auth = <T extends { set: (k: string, v: string) => T }>(x: T) => x.set('authorization', `Bearer ${token}`);
      const json = <T extends { set: (k: string, v: string) => T; send: (b: string) => T }>(x: T, body: object) => auth(x).set('content-type', 'application/scim+json').send(JSON.stringify(body));
      return {
        get: (p: string) => auth(r().get(`/api/v1/scim/v2${p}`)),
        post: (p: string, body: object) => json(r().post(`/api/v1/scim/v2${p}`), body),
        put: (p: string, body: object) => json(r().put(`/api/v1/scim/v2${p}`), body),
        patch: (p: string, body: object) => json(r().patch(`/api/v1/scim/v2${p}`), body),
        del: (p: string) => auth(r().delete(`/api/v1/scim/v2${p}`)),
      };
    };
    const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
    const roleId = async (t: TestTenant, key: string) => (await pool.query(`select id from roles where tenant_id = $1 and key = $2`, [t.id, key])).rows[0].id as string;
    const rolesOf = async (membershipId: string) =>
      (await pool.query(`select r.key, ra.source from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = $1 order by r.key`, [membershipId])).rows.map((x) => `${x.key}:${x.source}`);
    const groups: Record<string, string> = {};

    beforeAll(async () => {
      tokens.scim = ok(await as('owner').post('/security/scim/token'), 201).token;
      tokens.mobScim = ok(await api(app, tokens.mobOwner).post('/security/scim/token'), 201).token;
    });

    it('creates groups from the provider, which grant nothing until an owner maps them', async () => {
      const types = await scim(tokens.scim).get('/ResourceTypes');
      expect(types.body.Resources.map((t: { id: string }) => t.id)).toEqual(['User', 'Group']);
      const g = await scim(tokens.scim).post('/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Payroll team', externalId: 'okta-g1', members: [{ value: people.worker.membershipId }] });
      expect(g.status, JSON.stringify(g.body)).toBe(201);
      expect(g.body).toMatchObject({ displayName: 'Payroll team', externalId: 'okta-g1', members: [{ value: people.worker.membershipId, display: people.worker.email }], meta: { resourceType: 'Group' } });
      groups.payroll = g.body.id;
      expect(await rolesOf(people.worker.membershipId)).toEqual(['employee:manual']);
      expect((await scim(tokens.scim).post('/Groups', { displayName: 'payroll TEAM' })).status).toBe(409);
      const bad = await scim(tokens.scim).post('/Groups', { displayName: 'Ghosts', members: [{ value: '00000000-0000-4000-8000-000000000000' }] });
      expect(bad.status).toBe(400);
      expect(bad.body.scimType).toBe('invalidValue');
      // Found the way Okta and Entra look groups up, and without members when asked.
      const found = await scim(tokens.scim).get('/Groups?filter=' + encodeURIComponent('displayName eq "Payroll team"') + '&excludedAttributes=members');
      expect(found.body).toMatchObject({ totalResults: 1, Resources: [{ id: groups.payroll, displayName: 'Payroll team' }] });
      expect(found.body.Resources[0].members).toBeUndefined();
      // Another workspace's token sees nothing.
      expect((await scim(tokens.mobScim).get(`/Groups/${groups.payroll}`)).status).toBe(404);
      expect((await scim(tokens.mobScim).get('/Groups')).body.totalResults).toBe(0);
    });

    it('lets owners map a group to a role, never the owner role, and grants it to members', async () => {
      const list = ok(await as('owner').get('/security/scim/groups'));
      expect(list).toEqual([expect.objectContaining({ id: groups.payroll, displayName: 'Payroll team', roleId: null, memberCount: 1 })]);
      fails(await as('owner').put(`/security/scim/groups/${groups.payroll}/role`).send({ roleId: await roleId(ent, 'tenant_owner') }), 400, 'role_not_mappable');
      fails(await as('owner').put(`/security/scim/groups/${groups.payroll}/role`).send({ roleId: await roleId(mob, 'payroll_admin') }), 404);
      const mapped = ok(await as('owner').put(`/security/scim/groups/${groups.payroll}/role`).send({ roleId: await roleId(ent, 'payroll_admin') }));
      expect(mapped[0], JSON.stringify(mapped)).toMatchObject({ roleKey: 'payroll_admin' });
      expect(await rolesOf(people.worker.membershipId)).toEqual(['employee:manual', 'payroll_admin:scim']);
      const audit = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'scim_group.role_mapped'`, [ent.id]);
      expect(audit.rows[0].n).toBe(1);
    });

    it('follows membership changes the way providers send them, and keeps roles given by hand', async () => {
      // The manager already holds payroll_admin by hand, then joins the group.
      await pool.query(`insert into role_assignments (tenant_id, membership_id, role_id) values ($1, $2, $3)`, [ent.id, people.manager.membershipId, await roleId(ent, 'payroll_admin')]);
      const add = await scim(tokens.scim).patch(`/Groups/${groups.payroll}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'members', value: [{ value: people.manager.membershipId }] }] });
      expect(add.status, JSON.stringify(add.body)).toBe(200);
      expect(add.body.members.map((m: { value: string }) => m.value).sort()).toEqual([people.worker.membershipId, people.manager.membershipId].sort());
      // A second group grants the same role to the worker.
      const g2 = await scim(tokens.scim).post('/Groups', { displayName: 'Finance', members: [{ value: people.worker.membershipId }] });
      groups.finance = g2.body.id;
      ok(await as('owner').put(`/security/scim/groups/${groups.finance}/role`).send({ roleId: await roleId(ent, 'payroll_admin') }));
      // Entra's shape: remove one member by filter path.
      for (const id of [people.worker.membershipId, people.manager.membershipId]) {
        const r = await scim(tokens.scim).patch(`/Groups/${groups.payroll}`, { schemas: [PATCH], Operations: [{ op: 'remove', path: `members[value eq "${id}"]` }] });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      // Still in Finance, so the worker keeps it; the manager keeps the one given by hand.
      expect(await rolesOf(people.worker.membershipId)).toEqual(['employee:manual', 'payroll_admin:scim']);
      expect(await rolesOf(people.manager.membershipId)).toEqual(['department_manager:manual', 'employee:manual', 'payroll_admin:manual']);
      // Editing roles by hand in CREW leaves the group's role in place.
      ok(await as('owner').put(`/members/${people.worker.membershipId}/roles`).send({ assignments: [{ roleKey: 'employee' }, { roleKey: 'recruiter' }] }));
      expect(await rolesOf(people.worker.membershipId)).toEqual(['employee:manual', 'payroll_admin:scim', 'recruiter:manual']);
      // Replacing the member list (PUT) and renaming.
      const put = await scim(tokens.scim).put(`/Groups/${groups.finance}`, { displayName: 'Finance and payroll', members: [] });
      expect(put.body).toMatchObject({ displayName: 'Finance and payroll', members: [] });
      expect(await rolesOf(people.worker.membershipId)).toEqual(['employee:manual', 'recruiter:manual']);
    });

    it('removes the roles a deleted or unmapped group granted', async () => {
      await scim(tokens.scim).patch(`/Groups/${groups.finance}`, { schemas: [PATCH], Operations: [{ op: 'add', value: { members: [{ value: people.worker.membershipId }] } }] });
      expect(await rolesOf(people.worker.membershipId)).toContain('payroll_admin:scim');
      ok(await as('owner').put(`/security/scim/groups/${groups.finance}/role`).send({ roleId: await roleId(ent, 'auditor') }));
      expect(await rolesOf(people.worker.membershipId)).toEqual(['auditor:scim', 'employee:manual', 'recruiter:manual']);
      expect((await scim(tokens.scim).del(`/Groups/${groups.finance}`)).status).toBe(204);
      expect(await rolesOf(people.worker.membershipId)).toEqual(['employee:manual', 'recruiter:manual']);
      const log = await pool.query(`select method, path from scim_events where tenant_id = $1 and path like '/Groups%' order by created_at`, [ent.id]);
      expect(log.rows.map((x) => x.method)).toEqual(expect.arrayContaining(['POST', 'PATCH', 'PUT', 'DELETE']));
      const changed = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'membership.roles_changed' and metadata->>'via' = 'scim_group'`, [ent.id]);
      expect(changed.rows[0].n).toBeGreaterThanOrEqual(5);
    });
  });
  describe('erasure reaches free text, and the retention schedule', () => {
    const today = () => new Date().toISOString().slice(0, 10);
    const plus = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
    const ids: Record<string, string> = {};
    const SECRET = 'Lou mentioned a private medical matter';
    const employee = async (first: string, membershipId?: string) =>
      ok(await as('owner').post('/employees').send({ legalEntityId: ent.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2018-01-08', membershipId, onboardingTemplateId: null }), 201).employee.id as string;

    beforeAll(async () => {
      people.leaver = await addMember(pool, ent, { name: 'Lou Leaver' });
      ids.leaver = await employee('Lou', people.leaver.membershipId);
      ids.colleague = await employee('Cara');
      const q = (sql: string, params: unknown[]) => pool.query(sql, [ent.id, ...params]);
      const t = ent.id;
      const cat = (await q(`select id from expense_categories where tenant_id = $1 limit 1`, [])).rows[0]?.id ?? (await q(`insert into expense_categories (tenant_id, name) values ($1, 'Travel test') returning id`, [])).rows[0].id;
      await q(`insert into expense_claims (tenant_id, employee_id, category_id, spent_on, amount, currency, description) values ($1, $2, $3, '2024-03-01', 1250.50, 'INR', $4)`, [ids.leaver, cat, `Taxi to clinic: ${SECRET}`]);
      const goal = (await q(`insert into goals (tenant_id, employee_id, title, description, period_start, period_end) values ($1, $2, $3, $4, '2024-01-01', '2024-12-31') returning id`, [ids.leaver, `Goal about ${SECRET}`, SECRET])).rows[0].id;
      await q(`insert into goal_checkins (tenant_id, goal_id, progress, confidence, note, by_membership_id) values ($1, $2, 40, 'at_risk', $3, $4)`, [goal, SECRET, people.leaver.membershipId]);
      const cycle = (await q(`insert into review_cycles (tenant_id, name, period_start, period_end, questions, rating_scale) values ($1, 'FY24 review', '2024-01-01', '2024-12-31', '[]', '[]') returning id`, [])).rows[0].id;
      const review = (await q(
        `insert into reviews (tenant_id, cycle_id, employee_id, self_status, self_answers, self_rating, self_submitted_at, manager_status, manager_answers, manager_rating, manager_submitted_at, final_rating, released_at, employee_comment)
         values ($1, $2, $3, 'submitted', $4, 3, now(), 'submitted', $4, 4, now(), 4, now(), $5) returning id`,
        [cycle, ids.leaver, JSON.stringify({ q1: SECRET }), SECRET],
      )).rows[0].id;
      ids.review = review;
      await q(`insert into review_feedback (tenant_id, review_id, reviewer_employee_id, requested_by_membership_id, status, answers, submitted_at) values ($1, $2, $3, $4, 'submitted', $5, now())`, [review, ids.colleague, people.manager.membershipId, JSON.stringify({ q1: SECRET })]);
      await q(`insert into recognitions (tenant_id, from_employee_id, to_employee_id, message) values ($1, $2, $3, $4)`, [ids.colleague, ids.leaver, `Thanks Lou, ${SECRET}`]);
      await q(`insert into recognitions (tenant_id, from_employee_id, to_employee_id, message) values ($1, $2, $3, 'Thanks Cara, great work')`, [ids.leaver, ids.colleague]);
      await q(`insert into attendance_corrections (tenant_id, employee_id, work_date, punches, reason, status) values ($1, $2, '2024-02-02', '[{"at": "2024-02-02T09:00:00Z", "direction": "in"}]', $3, 'approved')`, [ids.leaver, SECRET]);
      await q(`insert into overtime_claims (tenant_id, employee_id, work_date, minutes, computed_minutes, reason, status) values ($1, $2, '2024-02-03', 60, 60, $3, 'approved')`, [ids.leaver, SECRET]);
      await q(`insert into approval_requests (tenant_id, resource_type, resource_id, subject_employee_id, summary, status) values ($1, 'leave_request', gen_random_uuid(), $2, $3, 'approved')`, [ids.leaver, `Leave for Lou: ${SECRET}`]);
      await q(`insert into attrition_scores (tenant_id, employee_id, computed_on, score, band, factors, inputs, rules_version) values ($1, $2, '2024-05-01', 70, 'high', '[]', '{}', 'v1')`, [ids.leaver]);
      const conv = (await q(`insert into iq_conversations (tenant_id, membership_id, title) values ($1, $2, 'My leave') returning id`, [people.leaver.membershipId])).rows[0].id;
      await q(`insert into iq_messages (tenant_id, conversation_id, membership_id, question, intent, match, answer) values ($1, $2, $3, $4, 'help', '{}', '{}')`, [conv, people.leaver.membershipId, SECRET]);
      await q(`insert into notifications (tenant_id, membership_id, kind, title) values ($1, $2, 'info', 'Hello Lou')`, [people.leaver.membershipId]);
      await q(`insert into member_preferences (tenant_id, membership_id, notes) values ($1, $2, $3)`, [people.leaver.membershipId, SECRET]);
      await q(`insert into mobile_devices (tenant_id, membership_id, installation_id, platform) values ($1, $2, 'install-0123456789abcdef', 'android')`, [people.leaver.membershipId]);
      void t;
    });

    it('erases text written by or about the person, and keeps amounts, ratings and what they wrote to others', async () => {
      ok(await as('owner').post(`/employees/${ids.leaver}/exit`).send({ exitType: 'resignation', resignationDate: plus(today(), -30), lastWorkingDay: plus(today(), -1) }), 201);
      const r = ok(await as('owner').post('/privacy/requests').send({ employeeId: ids.leaver, kind: 'erasure', source: 'Email from Lou' }), 201);
      const res = ok(await as('owner').post(`/privacy/requests/${r.id}/erase`).send({ note: 'Lou left; payroll kept for tax' }));
      expect(res.removed.freeText).toBeGreaterThanOrEqual(15);
      // Nothing in the workspace still holds the text.
      const tables = ['expense_claims', 'goals', 'goal_checkins', 'reviews', 'review_feedback', 'recognitions', 'attendance_corrections', 'overtime_claims', 'approval_requests', 'iq_messages', 'member_preferences'];
      for (const t of tables) {
        const hit = await pool.query(`select count(*)::int as n from ${t} x where tenant_id = $1 and to_jsonb(x)::text like '%' || $2 || '%'`, [ent.id, SECRET]);
        expect(hit.rows[0].n, t).toBe(0);
      }
      const claim = (await pool.query(`select amount::text, description from expense_claims where employee_id = $1`, [ids.leaver])).rows[0];
      expect(claim).toEqual({ amount: '1250.50', description: '[erased]' });
      const review = (await pool.query(`select self_rating, manager_rating, final_rating, self_answers, employee_comment, released_at from reviews where id = $1`, [ids.review])).rows[0];
      expect(review).toMatchObject({ self_rating: 3, manager_rating: 4, final_rating: 4, self_answers: { erased: true }, employee_comment: null });
      expect(review.released_at).not.toBeNull();
      // What Lou wrote to a colleague stays; their own app data and attrition scores are gone.
      expect((await pool.query(`select message from recognitions where to_employee_id = $1`, [ids.colleague])).rows[0].message).toBe('Thanks Cara, great work');
      for (const t of ['iq_conversations', 'notifications', 'member_preferences', 'mobile_devices']) {
        expect((await pool.query(`select count(*)::int as n from ${t} where membership_id = $1`, [people.leaver.membershipId])).rows[0].n, t).toBe(0);
      }
      expect((await pool.query(`select count(*)::int as n from attrition_scores where employee_id = $1`, [ids.leaver])).rows[0].n).toBe(0);
      // The frozen-record guards still refuse anything but the erasure marker, even with the erasure flag on.
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`set local crew.erasure = 'on'`);
        await expect(c.query(`update reviews set self_rating = 1 where id = $1`, [ids.review])).rejects.toThrow(/erasure may only blank/);
      } finally {
        await c.query('rollback');
        c.release();
      }
      await expect(pool.query(`update reviews set final_rating = 1 where id = $1`, [ids.review])).rejects.toThrow(/released review/);
    });

    it('keeps a retention schedule that only owners and HR change, with automatic erasure off by default', async () => {
      const def = ok(await as('owner').get('/privacy/retention'));
      expect(def).toMatchObject({ isDefault: true, policy: { exitedErasureYears: null, exportDays: 30, signInLogDays: 90 }, runs: [] });
      fails(await api(app, (await login(app, people.worker.email)).accessToken).get('/privacy/retention'), 403);
      fails(await as('owner').put('/privacy/retention').send({ exitedErasureYears: 0, exportDays: 30, signInLogDays: 90 }), 422);
      fails(await as('owner').put('/privacy/retention').send({ exitedErasureYears: 7, exportDays: 30, signInLogDays: 3 }), 422);
      const set = ok(await as('owner').put('/privacy/retention').send({ exitedErasureYears: 6, exportDays: 30, signInLogDays: 30 }));
      expect(set).toMatchObject({ isDefault: false, policy: { exitedErasureYears: 6, exportDays: 30, signInLogDays: 30 } });
      expect(set.policy.updatedBy).toBeTruthy();
    });

    it('erases long-gone leavers, deletes old exports and logs, and never touches attendance punches', async () => {
      ids.old = await employee('Olga');
      ids.recent = await employee('Rita');
      await pool.query(`update employees set status = 'exited', last_working_day = current_date - interval '7 years', exit_reason = 'Moved abroad' where id = $1`, [ids.old]);
      await pool.query(`update employees set status = 'exited', last_working_day = current_date - interval '2 years' where id = $1`, [ids.recent]);
      expect(ok(await as('owner').get('/privacy/retention')).dueForErasure).toBe(1);
      // An access export from 40 days ago (closed requests are frozen, so the test back-dates it with triggers off).
      const access = ok(await as('owner').post('/privacy/requests').send({ employeeId: ids.recent, kind: 'access', source: 'Portal' }), 201);
      ok(await as('owner').post(`/privacy/requests/${access.id}/export`).send({ note: 'Prepared' }));
      await pool.query(`set session_replication_role = replica; update privacy_requests set completed_at = now() - interval '40 days' where id = '${access.id}'; set session_replication_role = origin;`);
      await pool.query(`insert into scim_events (tenant_id, method, path, status, created_at) values ($1, 'GET', '/Users', 200, now() - interval '31 days')`, [ent.id]);
      const punchesBefore = (await pool.query(`select count(*)::int as n from attendance_events where tenant_id = $1`, [ent.id])).rows[0].n;

      const run = ok(await as('owner').post('/privacy/retention/run'));
      expect(run).toMatchObject({ trigger: 'manual', erased: 1, heldByPayroll: 0, exportsDeleted: 1 });
      expect(run.provisioningCalls).toBeGreaterThanOrEqual(1);
      const olga = (await pool.query(`select first_name, exit_reason, erased_at from employees where id = $1`, [ids.old])).rows[0];
      expect(olga).toMatchObject({ first_name: 'Erased', exit_reason: null });
      expect((await pool.query(`select erased_at from employees where id = $1`, [ids.recent])).rows[0].erased_at).toBeNull();
      // It went through a privacy request like any other, decided by the schedule.
      const req = (await pool.query(`select source, status, decided_by_membership_id, decision_note from privacy_requests where employee_id = $1 and kind = 'erasure'`, [ids.old])).rows[0];
      expect(req).toMatchObject({ source: 'Retention schedule', status: 'completed', decided_by_membership_id: null });
      fails(await as('owner').get(`/privacy/requests/${access.id}/export`), 409, 'export_deleted');
      expect((await pool.query(`select count(*)::int as n from scim_events where tenant_id = $1 and created_at < now() - interval '30 days'`, [ent.id])).rows[0].n).toBe(0);
      expect((await pool.query(`select count(*)::int as n from attendance_events where tenant_id = $1`, [ent.id])).rows[0].n).toBe(punchesBefore);
      // Recorded, and in the audit trail as the system.
      const after = ok(await as('owner').get('/privacy/retention'));
      expect(after.runs[0].result).toMatchObject({ trigger: 'manual', erased: 1 });
      const audit = (await pool.query(`select actor_type from audit_events where tenant_id = $1 and action = 'privacy.erased' and metadata->>'by' = 'retention_schedule'`, [ent.id])).rows;
      expect(audit).toEqual([{ actor_type: 'user' }]);
    });

    it('runs once a day from the HR jobs', async () => {
      const jobs = app.get(HrJobsService);
      const first = await jobs.runTenant(ent.id, today());
      expect(first.retentionApplied).toBe(true);
      const second = await jobs.runTenant(ent.id, today());
      expect(second.retentionApplied).toBe(false);
      const runs = (await pool.query(`select result->>'trigger' as t from retention_runs where tenant_id = $1 order by ran_at`, [ent.id])).rows.map((x) => x.t);
      expect(runs).toEqual(['manual', 'schedule']);
      const sys = (await pool.query(`select actor_type from audit_events where tenant_id = $1 and action = 'privacy.retention_applied' order by id desc limit 1`, [ent.id])).rows[0];
      expect(sys.actor_type).toBe('system');
    });
  });
  describe('attendance days written by several requests at once', () => {
    it('does not deadlock when team views and the HR job recompute the same people together', async () => {
      const t = await createTenant(pool, { plan: 'enterprise' });
      const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
      for (let i = 0; i < 6; i++) {
        ok(await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: `Pat${i}`, lastName: 'Parallel', dateOfJoining: '2024-01-08', onboardingTemplateId: null }), 201);
      }
      const attendance = app.get(AttendanceService);
      const date = new Date().toISOString().slice(0, 10);
      for (let round = 0; round < 3; round++) {
        // Stale days force every caller to rewrite them.
        await pool.query(`update attendance_days set computed_at = now() - interval '1 hour' where tenant_id = $1`, [t.id]);
        const results = await Promise.allSettled([
          attendance.refreshRecent(t.id),
          ...Array.from({ length: 4 }, () => api(app, owner).get(`/attendance/team?date=${date}`)),
          attendance.refreshRecent(t.id),
        ]);
        for (const r of results) {
          expect(r.status, r.status === 'rejected' ? String(r.reason) : '').toBe('fulfilled');
          if (r.status === 'fulfilled' && r.value && typeof r.value === 'object' && 'status' in r.value) expect((r.value as { status: number }).status).toBe(200);
        }
      }
    });
  });
});
