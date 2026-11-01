import { Inject, Injectable, Logger } from '@nestjs/common';
import { emailDomain, type SsoConnectionInput, ssoSatisfiesMfa, UNLIMITED } from '@crew/contracts';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, randomToken, sha256 } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { safeRequest } from '../integrations/safe-http';

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[] }
interface ConnectionRow { id: string; tenant_id: string; issuer: string; client_id: string; client_secret_enc: string; domains: string[]; status: string; enforced: boolean; jit_provisioning: boolean }

const STATE_TTL_MIN = 10;
const CACHE_MS = 10 * 60_000;

/** The outcome of a finished sign-in: a session for a member, or a passed test for an owner setting it up. */
export type SsoResult =
  | { kind: 'login'; userId: string; tenantId: string; membershipId: string; mfa: boolean; client: 'web' | 'mobile' }
  | { kind: 'test'; tenantId: string; email: string };

/**
 * Single sign-on with OpenID Connect (authorization code flow with PKCE, RFC 7636). Each workspace connects one
 * identity provider (Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, ...) by its issuer URL, client id
 * and client secret. CREW checks the ID token's signature against the provider's published keys, its issuer,
 * audience, expiry and nonce, and accepts only verified email addresses at the workspace's domains.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger('SSO');
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get redirectUri() {
    return `${this.config.WEB_PUBLIC_URL.replace(/\/$/, '')}/sso/callback`;
  }

  private get allowPrivate() {
    return this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true';
  }

  private async getJson<T>(url: string): Promise<T> {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    let r;
    try {
      r = await safeRequest('GET', url, undefined, { accept: 'application/json' }, { allowPrivate: this.allowPrivate, maxBytes: 200_000 });
    } catch (err) {
      throw Errors.badRequest('idp_unreachable', `Could not reach the identity provider: ${(err as Error).message}`);
    }
    if (r.status !== 200) throw Errors.badRequest('idp_error', `The identity provider answered ${r.status} for ${new URL(url).pathname}`);
    let value: T;
    try {
      value = JSON.parse(r.body) as T;
    } catch {
      throw Errors.badRequest('idp_error', 'The identity provider did not return JSON');
    }
    this.cache.set(url, { at: Date.now(), value });
    return value;
  }

  /** Reads the provider's discovery document and checks it describes the issuer that was entered. */
  async discover(issuer: string): Promise<Discovery> {
    const d = await this.getJson<Discovery>(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (!d.issuer || d.issuer !== issuer) {
      throw Errors.badRequest('idp_issuer_mismatch', `The provider says its issuer is "${d.issuer ?? 'missing'}", not "${issuer}". Use exactly the issuer it publishes.`);
    }
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof d[k] !== 'string') throw Errors.badRequest('idp_error', `The provider's discovery document has no ${k}`);
    }
    return d;
  }

  // Settings (owners) ----------------------------------------------------------------------------------------------

  async get() {
    return this.db.tenant(async (tx) => {
      const c = await one(
        tx,
        `select id, protocol, issuer, client_id as "clientId", domains, status, enforced, jit_provisioning as "jitProvisioning",
                verified_at as "verifiedAt", verified_email as "verifiedEmail", updated_at as "updatedAt"
           from sso_connections`,
      );
      return { connection: c ?? null, redirectUri: this.redirectUri };
    });
  }

  async save(input: SsoConnectionInput) {
    const actor = requestContext.tenantActor();
    await this.discover(input.issuer);
    await this.db.tenant(async (tx) => {
      const existing = await one<{ id: string; issuer: string; client_id: string }>(tx, 'select id, issuer, client_id from sso_connections');
      if (!existing && !input.clientSecret) throw Errors.validation([{ path: 'clientSecret', message: 'Required' }]);
      // Domains are claimed across workspaces, so the check needs the platform role.
      const taken = await this.db.platform((ptx) => one<{ domain: string }>(ptx, 'select domain::text from sso_domains where domain = any($1::citext[]) and tenant_id <> $2 limit 1', [input.domains, actor.tenantId]));
      if (taken) throw Errors.conflict('domain_taken', `${taken.domain} is already used for single sign-on by another workspace. Contact support if it is yours.`);
      const secret = input.clientSecret ? encryptField(input.clientSecret, this.config.FIELD_ENCRYPTION_KEY) : null;
      const identityChanged = !existing || existing.issuer !== input.issuer || existing.client_id !== input.clientId || Boolean(input.clientSecret);
      let id: string;
      if (!existing) {
        id = (await one<{ id: string }>(
          tx,
          `insert into sso_connections (tenant_id, issuer, client_id, client_secret_enc, domains, jit_provisioning, created_by_membership_id)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
          [input.issuer, input.clientId, secret, input.domains, input.jitProvisioning, actor.membershipId],
        ))!.id;
      } else {
        id = existing.id;
        // A different provider or client must pass a new test before anyone can use it.
        await tx.query(
          `update sso_connections set issuer = $2, client_id = $3, client_secret_enc = coalesce($4, client_secret_enc), domains = $5, jit_provisioning = $6, updated_at = now()
             ${identityChanged ? `, status = 'draft', enforced = false, verified_at = null, verified_email = null` : ''}
           where id = $1`,
          [id, input.issuer, input.clientId, secret, input.domains, input.jitProvisioning],
        );
      }
      await tx.query('delete from sso_domains where tenant_id = app_tenant_id()');
      for (const d of input.domains) await tx.query('insert into sso_domains (domain, tenant_id) values ($1, app_tenant_id())', [d]);
      await this.audit.record(tx, {
        action: existing ? 'sso.updated' : 'sso.created', resourceType: 'sso_connection', resourceId: id,
        metadata: { issuer: input.issuer, clientId: input.clientId, domains: input.domains, jitProvisioning: input.jitProvisioning, secretChanged: Boolean(input.clientSecret), needsNewTest: identityChanged },
      });
    });
    return this.get();
  }

  async setStatus(status: 'active' | 'disabled', enforced: boolean) {
    const actor = requestContext.tenantActor();
    await this.db.tenant(async (tx) => {
      const c = await one<{ id: string; verified_at: string | null; enforced: boolean }>(tx, 'select id, verified_at, enforced from sso_connections');
      if (!c) throw Errors.notFound('Single sign-on connection');
      if (status === 'active' && !c.verified_at) throw Errors.conflict('sso_not_tested', 'Run a test sign-in that succeeds before switching single sign-on on.');
      if (enforced && status !== 'active') throw Errors.badRequest('sso_enforce_needs_active', 'Single sign-on must be on to require it.');
      await tx.query('update sso_connections set status = $2, enforced = $3, updated_at = now() where id = $1', [c.id, status, enforced]);
      if (enforced && !c.enforced) {
        // Members (other than owners) signed in with a password are signed out, so their next sign-in goes through the provider.
        await this.db.platform((ptx) =>
          ptx.query(
            `update sessions s set revoked_at = now(), revoked_reason = 'sso_enforced'
               where s.tenant_id = $1 and s.revoked_at is null and s.user_id <> $2
                 and not exists (select 1 from memberships m join role_assignments ra on ra.membership_id = m.id join roles r on r.id = ra.role_id
                                  where m.user_id = s.user_id and m.tenant_id = $1 and r.key = 'tenant_owner')`,
            [actor.tenantId, actor.userId],
          ),
        );
      }
      await this.audit.record(tx, { action: 'sso.status_changed', resourceType: 'sso_connection', resourceId: c.id, metadata: { status, enforced } });
    });
    return this.get();
  }

  async remove() {
    await this.db.tenant(async (tx) => {
      const c = await one<{ id: string }>(tx, 'select id from sso_connections');
      if (!c) throw Errors.notFound('Single sign-on connection');
      await tx.query('delete from sso_domains where tenant_id = app_tenant_id()');
      await tx.query(`update sso_connections set status = 'disabled', enforced = false, updated_at = now() where id = $1`, [c.id]);
      await this.audit.record(tx, { action: 'sso.disabled', resourceType: 'sso_connection', resourceId: c.id });
    });
    return { ok: true };
  }

  // Sign-in --------------------------------------------------------------------------------------------------------

  /** Whether password sign-in is closed to this member of this workspace (single sign-on required, not an owner). */
  async passwordBlocked(tx: Tx, tenantId: string, membershipId: string) {
    const r = await one<{ blocked: boolean }>(
      tx,
      `select exists (select 1 from sso_connections c where c.tenant_id = $1 and c.enforced)
              and not exists (select 1 from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = $2 and r.key = 'tenant_owner') as blocked`,
      [tenantId, membershipId],
    );
    return r?.blocked ?? false;
  }

  /** Finds the workspace for an email's domain and returns the provider's sign-in address. */
  async startByEmail(email: string, client: 'web' | 'mobile') {
    const domain = emailDomain(email);
    const c = await this.db.platform((tx) =>
      one<ConnectionRow>(tx, `select c.* from sso_domains d join sso_connections c on c.tenant_id = d.tenant_id join tenants t on t.id = c.tenant_id where d.domain = $1 and c.status = 'active' and t.status = 'active'`, [domain]),
    );
    if (!c) throw Errors.notFound('Single sign-on for this email domain');
    return this.start(c, 'login', client, null, email);
  }

  /** Owners test the connection before switching it on. */
  async startTest() {
    const actor = requestContext.tenantActor();
    const c = await this.db.platform((tx) => one<ConnectionRow>(tx, 'select * from sso_connections where tenant_id = $1', [actor.tenantId]));
    if (!c) throw Errors.notFound('Single sign-on connection');
    return this.start(c, 'test', 'web', actor.membershipId);
  }

  private async start(c: ConnectionRow, purpose: 'login' | 'test', client: 'web' | 'mobile', membershipId: string | null, loginHint?: string) {
    const d = await this.discover(c.issuer);
    const state = randomToken(32);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    await this.db.platform((tx) =>
      tx.query(
        `insert into sso_login_states (state_hash, tenant_id, nonce, code_verifier_enc, purpose, client, started_by_membership_id, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))`,
        [sha256(state), c.tenant_id, nonce, encryptField(verifier, this.config.FIELD_ENCRYPTION_KEY), purpose, client, membershipId, STATE_TTL_MIN],
      ),
    );
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: c.client_id, redirect_uri: this.redirectUri, scope: 'openid email profile',
      state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  /** Completes a sign-in: one use of the state, code exchange, ID token checks, then the member. */
  async callback(code: string, state: string): Promise<SsoResult> {
    const st = await this.db.platform((tx) =>
      one<{ tenant_id: string; nonce: string; code_verifier_enc: string; purpose: 'login' | 'test'; client: 'web' | 'mobile'; started_by_membership_id: string | null }>(
        tx,
        `update sso_login_states set used_at = now() where state_hash = $1 and used_at is null and expires_at > now()
         returning tenant_id, nonce, code_verifier_enc, purpose, client, started_by_membership_id`,
        [sha256(state)],
      ),
    );
    if (!st) throw Errors.unauthorized('This sign-in link has expired or was already used. Start again.');
    const c = await this.db.platform((tx) => one<ConnectionRow>(tx, 'select * from sso_connections where tenant_id = $1', [st.tenant_id]));
    if (!c || (st.purpose === 'login' && c.status !== 'active')) throw Errors.forbidden('Single sign-on is not switched on for this workspace');
    if (!(await this.db.tenant(loadEntitlements, { tenantId: c.tenant_id })).features.has('sso')) throw Errors.featureNotInPlan('Single sign-on');
    const fail = async (reason: string): Promise<never> => {
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: c.tenant_id, action: 'auth.sso_failed', resourceType: 'sso_connection', resourceId: c.id, metadata: { reason, purpose: st.purpose } }));
      throw Errors.unauthorized(`Single sign-on failed: ${reason}`);
    };

    const d = await this.discover(c.issuer);
    const secret = decryptField(c.client_secret_enc, this.config.FIELD_ENCRYPTION_KEY);
    const postCreds = !(d.token_endpoint_auth_methods_supported ?? ['client_secret_basic']).includes('client_secret_basic');
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: decryptField(st.code_verifier_enc, this.config.FIELD_ENCRYPTION_KEY),
      ...(postCreds ? { client_id: c.client_id, client_secret: secret } : {}),
    }).toString();
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (!postCreds) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.client_id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    let tokenRes;
    try {
      tokenRes = await safeRequest('POST', d.token_endpoint, form, headers, { allowPrivate: this.allowPrivate, maxBytes: 100_000 });
    } catch (err) {
      return fail(`the provider could not be reached (${(err as Error).message})`);
    }
    let tokens: { id_token?: string; error?: string; error_description?: string };
    try {
      tokens = JSON.parse(tokenRes.body);
    } catch {
      return fail(`the provider answered ${tokenRes.status} without JSON`);
    }
    if (tokenRes.status !== 200 || !tokens.id_token) return fail(`the provider refused the code (${tokens.error ?? tokenRes.status}${tokens.error_description ? `: ${tokens.error_description.slice(0, 120)}` : ''})`);

    let claims: Record<string, unknown>;
    try {
      const jwks = createLocalJWKSet(await this.getJson<JSONWebKeySet>(d.jwks_uri));
      ({ payload: claims } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: c.client_id, algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'], maxTokenAge: '10m', clockTolerance: 60 }));
    } catch (err) {
      return fail(`the ID token did not verify (${(err as Error).message})`);
    }
    if (claims.nonce !== st.nonce) return fail('the ID token is for a different sign-in (nonce)');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email) return fail('the provider did not send an email address (add the email scope or claim)');
    if (claims.email_verified !== true && claims.email_verified !== 'true') return fail('the provider did not confirm the email address is verified');
    if (!c.domains.includes(emailDomain(email))) return fail(`${emailDomain(email)} is not one of this workspace's single sign-on domains`);

    if (st.purpose === 'test') {
      await this.db.platform(async (tx) => {
        await tx.query('update sso_connections set verified_at = now(), verified_email = $2, updated_at = now() where id = $1', [c.id, email]);
        await this.audit.record(tx, { tenantId: c.tenant_id, action: 'sso.tested', resourceType: 'sso_connection', resourceId: c.id, metadata: { email } });
      });
      return { kind: 'test', tenantId: c.tenant_id, email };
    }
    const member = await this.memberFor(c, email, typeof claims.name === 'string' ? claims.name : email);
    return { kind: 'login', userId: member.userId, tenantId: c.tenant_id, membershipId: member.membershipId, mfa: ssoSatisfiesMfa(claims.amr), client: st.client };
  }

  /** The member signing in. A pending invitation is accepted; with just-in-time provisioning, a new member is created. */
  private async memberFor(c: ConnectionRow, email: string, name: string) {
    return this.db.platform(async (tx) => {
      const m = await one<{ membership_id: string; user_id: string; status: string; user_status: string }>(
        tx,
        `select m.id as membership_id, u.id as user_id, m.status, u.status as user_status from users u join memberships m on m.user_id = u.id and m.tenant_id = $2 where u.email = $1`,
        [email, c.tenant_id],
      );
      if (m) {
        if (m.status === 'suspended' || m.user_status !== 'active') throw Errors.forbidden('Your access to this workspace is suspended. Contact your HR team.');
        if (m.status === 'invited') {
          await tx.query(`update memberships set status = 'active' where id = $1`, [m.membership_id]);
          await tx.query('update invitations set accepted_at = now() where membership_id = $1 and accepted_at is null and revoked_at is null', [m.membership_id]);
          await this.audit.record(tx, { tenantId: c.tenant_id, action: 'invitation.accepted', resourceType: 'membership', resourceId: m.membership_id, metadata: { via: 'sso' } });
        }
        return { userId: m.user_id, membershipId: m.membership_id };
      }
      if (!c.jit_provisioning) throw Errors.forbidden('You are not a member of this workspace yet. Ask your HR team to add you.');
      const seats = (await one<{ n: number }>(tx, `select count(*)::int as n from memberships where tenant_id = $1 and status <> 'suspended'`, [c.tenant_id]))!.n;
      const limit = (await this.db.tenant(loadEntitlements, { tenantId: c.tenant_id })).limits.max_employees;
      if (limit !== undefined && limit !== UNLIMITED && seats >= limit) throw Errors.forbidden('This workspace has no seats left. Ask your HR team to add you.');
      const userId = (await one<{ id: string }>(tx, 'insert into users (email, full_name) values ($1, $2) on conflict (email) do update set email = excluded.email returning id', [email, name.slice(0, 160)]))!.id;
      const entity = await one<{ id: string }>(tx, 'select id from legal_entities where tenant_id = $1 and archived_at is null order by created_at limit 1', [c.tenant_id]);
      const membershipId = (await one<{ id: string }>(
        tx,
        `insert into memberships (tenant_id, user_id, status, legal_entity_id, provisioned_by) values ($1, $2, 'active', $3, 'sso') returning id`,
        [c.tenant_id, userId, entity?.id ?? null],
      ))!.id;
      await tx.query(`insert into role_assignments (tenant_id, membership_id, role_id) select $1, $2, id from roles where tenant_id = $1 and key = 'employee'`, [c.tenant_id, membershipId]);
      await this.audit.record(tx, { tenantId: c.tenant_id, action: 'membership.provisioned', resourceType: 'membership', resourceId: membershipId, changes: { email }, metadata: { via: 'sso_jit' } });
      await this.outbox.publish(tx, c.tenant_id, 'membership.invited', { membershipId, email });
      return { userId, membershipId };
    });
  }
}
