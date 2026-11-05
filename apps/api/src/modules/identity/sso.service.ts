import { Inject, Injectable, Logger } from '@nestjs/common';
import { emailDomain, samlSatisfiesMfa, type SsoConnectionInput, ssoSatisfiesMfa, UNLIMITED } from '@crew/contracts';
import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { createHash, X509Certificate } from 'node:crypto';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, randomToken, sha256 } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { AppError, Errors } from '../../platform/http/errors';
import { safeRequest } from '../integrations/safe-http';

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[] }
interface ConnectionRow {
  id: string; tenant_id: string; protocol: 'oidc' | 'saml'; issuer: string; client_id: string | null; client_secret_enc: string | null; domains: string[];
  status: string; enforced: boolean; jit_provisioning: boolean; saml_sso_url: string | null; saml_idp_cert: string | null;
}
interface StateRow {
  tenant_id: string; nonce: string; code_verifier_enc: string | null; purpose: 'login' | 'test'; client: 'web' | 'mobile'; protocol: 'oidc' | 'saml';
  started_by_membership_id: string | null; return_to: string | null; app_challenge: string | null;
}
type Client = 'web' | 'mobile';
/** What a mobile app asks for when it starts single sign-on. */
export interface MobileStart { returnTo: string; appChallenge: string }

const STATE_TTL_MIN = 10;
const HANDOFF_TTL_SEC = 120;
const CACHE_MS = 10 * 60_000;

/** The outcome of a finished sign-in: a session for a member, or a passed test for an owner setting it up. */
export type SsoResult =
  | { kind: 'login'; userId: string; tenantId: string; membershipId: string; mfa: boolean; client: Client }
  | { kind: 'handoff'; redirectTo: string }
  | { kind: 'test'; tenantId: string; email: string };

/** Reads a pasted certificate (PEM, or the bare base64 from metadata) and returns it as PEM with its details. */
export function readCertificate(text: string) {
  const body = text.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw Errors.validation([{ path: 'certificate', message: 'This is not a valid X.509 certificate. Paste the signing certificate from your identity provider.' }]);
  }
  const expiresAt = new Date(cert.validTo);
  if (expiresAt.getTime() < Date.now()) throw Errors.validation([{ path: 'certificate', message: `This certificate expired on ${expiresAt.toISOString().slice(0, 10)}.` }]);
  return { pem, expiresAt, fingerprint: cert.fingerprint256 };
}

/**
 * Single sign-on. Each workspace connects one identity provider (Okta, Microsoft Entra ID, Google Workspace, Auth0,
 * Keycloak, ADFS, ...) with either protocol:
 *   - OpenID Connect (authorization code flow with PKCE, RFC 7636): CREW checks the ID token's signature against
 *     the provider's published keys, its issuer, audience, expiry and nonce, and needs a verified email.
 *   - SAML 2.0 (HTTP-Redirect request, HTTP-POST response): node-saml checks the assertion's XML signature against
 *     the certificate the owner pasted, the issuer, audience, recipient, time limits and InResponseTo.
 * Either way only email addresses at the workspace's domains are accepted. The mobile app signs in through the
 * same flow in the system browser and collects its session with a one-time code bound to its own PKCE challenge.
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

  /** SAML: CREW's entity ID (also where its metadata is published) and the Assertion Consumer Service URL. */
  get samlSp() {
    const entityId = `${this.config.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/auth/sso/saml/metadata`;
    return { entityId, acsUrl: `${this.config.WEB_PUBLIC_URL.replace(/\/$/, '')}/sso/saml`, metadataUrl: entityId };
  }

  /** A node-saml instance for one connection. InResponseTo is checked against the request ID kept in the state row. */
  private saml(c: ConnectionRow, cacheProvider: CacheProvider) {
    const sp = this.samlSp;
    return new SAML({
      entryPoint: c.saml_sso_url ?? undefined,
      issuer: sp.entityId,
      callbackUrl: sp.acsUrl,
      audience: sp.entityId,
      idpCert: c.saml_idp_cert ?? 'missing',
      idpIssuer: c.issuer,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: STATE_TTL_MIN * 60_000,
      cacheProvider,
      acceptedClockSkewMs: 60_000,
      maxAssertionAgeMs: 10 * 60_000,
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
    });
  }

  /** CREW's SAML service provider metadata, to upload to the identity provider. */
  samlMetadata() {
    const noCache: CacheProvider = { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null };
    return this.saml({ saml_sso_url: 'https://example.invalid', saml_idp_cert: 'unused', issuer: 'unused' } as ConnectionRow, noCache).generateServiceProviderMetadata(null, null);
  }

  private get mobileRedirects() {
    return this.config.MOBILE_SSO_REDIRECTS.split(',').map((s) => s.trim()).filter(Boolean);
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
                verified_at as "verifiedAt", verified_email as "verifiedEmail", updated_at as "updatedAt",
                saml_sso_url as "samlSsoUrl", saml_cert_expires_at as "samlCertExpiresAt", saml_cert_fingerprint as "samlCertFingerprint"
           from sso_connections`,
      );
      return { connection: c ?? null, redirectUri: this.redirectUri, saml: this.samlSp };
    });
  }

  async save(input: SsoConnectionInput) {
    const actor = requestContext.tenantActor();
    const saml = input.protocol === 'saml';
    let cert = input.protocol === 'saml' && input.certificate ? readCertificate(input.certificate) : null;
    if (input.protocol === 'saml') {
      // The browser goes there, CREW never calls it; plain http only for local tests.
      if (!this.allowPrivate && !input.ssoUrl.startsWith('https://')) throw Errors.validation([{ path: 'ssoUrl', message: 'Use the https address of your identity provider.' }]);
    } else await this.discover(input.issuer);
    const issuer = input.protocol === 'saml' ? input.idpEntityId : input.issuer;
    const clientId = input.protocol === 'oidc' ? input.clientId : null;
    const clientSecret = input.protocol === 'oidc' ? input.clientSecret : undefined;
    await this.db.tenant(async (tx) => {
      const existing = await one<{
        id: string; protocol: string; issuer: string; client_id: string | null; client_secret_enc: string | null; saml_sso_url: string | null;
        saml_idp_cert: string | null; saml_cert_expires_at: Date | null; saml_cert_fingerprint: string | null;
      }>(tx, 'select id, protocol, issuer, client_id, client_secret_enc, saml_sso_url, saml_idp_cert, saml_cert_expires_at, saml_cert_fingerprint from sso_connections');
      if (saml && !cert) {
        // Other settings changed and the certificate left out: keep the stored one.
        if (existing?.protocol !== 'saml' || !existing.saml_idp_cert || !existing.saml_cert_fingerprint) throw Errors.validation([{ path: 'certificate', message: 'Required' }]);
        cert = { pem: existing.saml_idp_cert, expiresAt: existing.saml_cert_expires_at!, fingerprint: existing.saml_cert_fingerprint };
      }
      if (!saml && !clientSecret && (!existing || !existing.client_secret_enc)) throw Errors.validation([{ path: 'clientSecret', message: 'Required' }]);
      // Domains are claimed across workspaces, so the check needs the platform role.
      const taken = await this.db.platform((ptx) => one<{ domain: string }>(ptx, 'select domain::text from sso_domains where domain = any($1::citext[]) and tenant_id <> $2 limit 1', [input.domains, actor.tenantId]));
      if (taken) throw Errors.conflict('domain_taken', `${taken.domain} is already used for single sign-on by another workspace. Contact support if it is yours.`);
      const secret = clientSecret ? encryptField(clientSecret, this.config.fieldKeys) : null;
      const identityChanged =
        !existing || existing.protocol !== input.protocol || existing.issuer !== issuer || Boolean(clientSecret)
        || (saml ? existing.saml_sso_url !== (input as { ssoUrl: string }).ssoUrl || existing.saml_cert_fingerprint !== cert!.fingerprint : existing.client_id !== clientId);
      const values = [
        input.protocol, issuer, clientId, secret, input.domains, input.jitProvisioning,
        saml ? (input as { ssoUrl: string }).ssoUrl : null, cert?.pem ?? null, cert?.expiresAt ?? null, cert?.fingerprint ?? null,
      ];
      let id: string;
      if (!existing) {
        id = (await one<{ id: string }>(
          tx,
          `insert into sso_connections (tenant_id, protocol, issuer, client_id, client_secret_enc, domains, jit_provisioning, saml_sso_url, saml_idp_cert, saml_cert_expires_at, saml_cert_fingerprint, created_by_membership_id)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [...values, actor.membershipId],
        ))!.id;
      } else {
        id = existing.id;
        // A different provider, client or certificate must pass a new test before anyone can use it. Switching to
        // SAML drops the OpenID Connect secret; switching to OpenID Connect drops the SAML settings.
        await tx.query(
          `update sso_connections set protocol = $1, issuer = $2, client_id = $3,
                  client_secret_enc = case when $1 = 'saml' then null else coalesce($4, client_secret_enc) end,
                  domains = $5, jit_provisioning = $6, saml_sso_url = $7, saml_idp_cert = $8, saml_cert_expires_at = $9, saml_cert_fingerprint = $10, updated_at = now()
             ${identityChanged ? `, status = 'draft', enforced = false, verified_at = null, verified_email = null` : ''}
           where id = $11`,
          [...values, id],
        );
      }
      await tx.query('delete from sso_domains where tenant_id = app_tenant_id()');
      for (const d of input.domains) await tx.query('insert into sso_domains (domain, tenant_id) values ($1, app_tenant_id())', [d]);
      await this.audit.record(tx, {
        action: existing ? 'sso.updated' : 'sso.created', resourceType: 'sso_connection', resourceId: id,
        metadata: {
          protocol: input.protocol, issuer, clientId, domains: input.domains, jitProvisioning: input.jitProvisioning, secretChanged: Boolean(clientSecret),
          certificateFingerprint: cert?.fingerprint ?? null, needsNewTest: identityChanged,
        },
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
  async startByEmail(email: string, client: Client, mobile?: Partial<MobileStart>) {
    if (client === 'mobile') {
      if (!mobile?.returnTo || !mobile.appChallenge) throw Errors.validation([{ path: 'appChallenge', message: 'The app must send returnTo and appChallenge' }]);
      if (!this.mobileRedirects.includes(mobile.returnTo)) throw Errors.badRequest('return_to_not_allowed', 'This app address is not allowed to receive single sign-on.');
    }
    const domain = emailDomain(email);
    const c = await this.db.platform((tx) =>
      one<ConnectionRow>(tx, `select c.* from sso_domains d join sso_connections c on c.tenant_id = d.tenant_id join tenants t on t.id = c.tenant_id where d.domain = $1 and c.status = 'active' and t.status = 'active'`, [domain]),
    );
    if (!c) throw Errors.notFound('Single sign-on for this email domain');
    return this.start(c, 'login', client, null, email, client === 'mobile' ? (mobile as MobileStart) : undefined);
  }

  /** Owners test the connection before switching it on. */
  async startTest() {
    const actor = requestContext.tenantActor();
    const c = await this.db.platform((tx) => one<ConnectionRow>(tx, 'select * from sso_connections where tenant_id = $1', [actor.tenantId]));
    if (!c) throw Errors.notFound('Single sign-on connection');
    return this.start(c, 'test', 'web', actor.membershipId);
  }

  private async start(c: ConnectionRow, purpose: 'login' | 'test', client: Client, membershipId: string | null, loginHint?: string, mobile?: MobileStart) {
    const state = randomToken(32);
    const save = (nonce: string, verifier: string | null) =>
      this.db.platform((tx) =>
        tx.query(
          `insert into sso_login_states (state_hash, tenant_id, nonce, code_verifier_enc, purpose, client, protocol, started_by_membership_id, return_to, app_challenge, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(mins => $11))`,
          [sha256(state), c.tenant_id, nonce, verifier ? encryptField(verifier, this.config.fieldKeys) : null, purpose, client, c.protocol, membershipId, mobile?.returnTo ?? null, mobile?.appChallenge ?? null, STATE_TTL_MIN],
        ),
      );
    if (c.protocol === 'saml') {
      // node-saml makes the AuthnRequest and hands its ID to the cache provider: that ID is kept as the nonce, and
      // the response must answer it (InResponseTo). RelayState carries the state.
      let requestId = '';
      const capture: CacheProvider = {
        saveAsync: async (key, value) => {
          requestId = key;
          return { value, createdAt: Date.now() };
        },
        getAsync: async () => null,
        removeAsync: async () => null,
      };
      const url = new URL(await this.saml(c, capture).getAuthorizeUrlAsync(state, undefined, {}));
      if (!requestId) throw new Error('SAML request ID was not recorded');
      await save(requestId, null);
      return { authorizationUrl: url.toString() };
    }
    const d = await this.discover(c.issuer);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    await save(nonce, verifier);
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: c.client_id!, redirect_uri: this.redirectUri, scope: 'openid email profile',
      state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString();
    return { authorizationUrl: url.toString() };
  }

  /** Uses a sign-in state once. Returns it with its connection, after checking the workspace may still use it. */
  private async consume(state: string, protocol: 'oidc' | 'saml') {
    const st = await this.db.platform((tx) =>
      one<StateRow>(
        tx,
        `update sso_login_states set used_at = now() where state_hash = $1 and used_at is null and expires_at > now()
         returning tenant_id, nonce, code_verifier_enc, purpose, client, protocol, started_by_membership_id, return_to, app_challenge`,
        [sha256(state)],
      ),
    );
    if (!st) throw Errors.unauthorized('This sign-in link has expired or was already used. Start again.');
    const c = await this.db.platform((tx) => one<ConnectionRow>(tx, 'select * from sso_connections where tenant_id = $1', [st.tenant_id]));
    if (!c || (st.purpose === 'login' && c.status !== 'active')) throw Errors.forbidden('Single sign-on is not switched on for this workspace');
    if (c.protocol !== protocol || st.protocol !== protocol) throw new AppError(401, 'sso_failed', 'Single sign-on failed: the workspace changed its single sign-on settings during this sign-in. Start again.', { purpose: st.purpose });
    if (!(await this.db.tenant(loadEntitlements, { tenantId: c.tenant_id })).features.has('sso')) throw Errors.featureNotInPlan('Single sign-on');
    const fail = async (reason: string): Promise<never> => {
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: c.tenant_id, action: 'auth.sso_failed', resourceType: 'sso_connection', resourceId: c.id, metadata: { reason, purpose: st.purpose, protocol } }));
      throw new AppError(401, 'sso_failed', `Single sign-on failed: ${reason}`, { purpose: st.purpose });
    };
    return { st, c, fail };
  }

  /** After either protocol: the domain check, then a passed test, a session, or a hand-off code for the app. */
  private async finish(c: ConnectionRow, st: StateRow, fail: (reason: string) => Promise<never>, email: string, name: string, mfa: boolean): Promise<SsoResult> {
    if (!c.domains.includes(emailDomain(email))) return fail(`${emailDomain(email)} is not one of this workspace's single sign-on domains`);
    if (st.purpose === 'test') {
      await this.db.platform(async (tx) => {
        await tx.query('update sso_connections set verified_at = now(), verified_email = $2, updated_at = now() where id = $1', [c.id, email]);
        await this.audit.record(tx, { tenantId: c.tenant_id, action: 'sso.tested', resourceType: 'sso_connection', resourceId: c.id, metadata: { email, protocol: c.protocol } });
      });
      return { kind: 'test', tenantId: c.tenant_id, email };
    }
    const member = await this.memberFor(c, email, name);
    if (st.client === 'mobile') {
      // The browser never gets the session: it hands the app a one-time code, which only the app holding the
      // verifier behind app_challenge can exchange.
      const code = randomToken(32);
      await this.db.platform((tx) =>
        tx.query(
          `insert into sso_handoffs (code_hash, tenant_id, user_id, membership_id, mfa, app_challenge, expires_at) values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
          [sha256(code), c.tenant_id, member.userId, member.membershipId, mfa, st.app_challenge, HANDOFF_TTL_SEC],
        ),
      );
      const to = new URL(st.return_to!);
      to.searchParams.set('code', code);
      return { kind: 'handoff', redirectTo: to.toString() };
    }
    return { kind: 'login', userId: member.userId, tenantId: c.tenant_id, membershipId: member.membershipId, mfa, client: st.client };
  }

  /** The app exchanges its one-time code, proving it holds the verifier for the challenge it started with. */
  async exchange(code: string, verifier: string) {
    const h = await this.db.platform((tx) =>
      one<{ tenant_id: string; user_id: string; membership_id: string; mfa: boolean; app_challenge: string }>(
        tx,
        `update sso_handoffs set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning tenant_id, user_id, membership_id, mfa, app_challenge`,
        [sha256(code)],
      ),
    );
    if (!h) throw Errors.unauthorized('This sign-in has expired or was already used. Start again in the app.');
    if (createHash('sha256').update(verifier).digest('base64url') !== h.app_challenge) {
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: h.tenant_id, action: 'auth.sso_failed', resourceType: 'membership', resourceId: h.membership_id, metadata: { reason: 'mobile hand-off verifier did not match', protocol: 'handoff' } }));
      throw Errors.unauthorized('Single sign-on failed: this app did not start the sign-in.');
    }
    return { userId: h.user_id, tenantId: h.tenant_id, membershipId: h.membership_id, mfa: h.mfa };
  }

  /** Completes a SAML sign-in from the identity provider's HTTP-POST response. */
  async samlCallback(samlResponse: string, relayState: string): Promise<SsoResult> {
    const { st, c, fail } = await this.consume(relayState, 'saml');
    // Accepts exactly the request this state started: node-saml asks the cache for the response's InResponseTo.
    const expected: CacheProvider = {
      saveAsync: async () => null,
      getAsync: async (key) => (key === st.nonce ? new Date().toISOString() : null),
      removeAsync: async (key) => key,
    };
    let profile: Profile | null;
    try {
      ({ profile } = await this.saml(c, expected).validatePostResponseAsync({ SAMLResponse: samlResponse, RelayState: relayState }));
    } catch (err) {
      return fail(`the SAML response did not verify (${(err as Error).message.slice(0, 200)})`);
    }
    if (!profile) return fail('the identity provider sent a logout response instead of a sign-in');
    const attr = (name: string) => {
      const v = profile![name];
      return Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)];
    };
    const email = [
      profile.email, profile.mail, ...attr('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'), ...attr('urn:oid:0.9.2342.19200300.100.1.3'),
      profile.nameIDFormat?.endsWith('emailAddress') ? profile.nameID : undefined,
    ].find((e): e is string => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim()))?.trim().toLowerCase();
    if (!email) return fail('the identity provider did not send an email address (send it as the NameID or an email attribute)');
    const name = [...attr('http://schemas.microsoft.com/identity/claims/displayname'), ...attr('displayName'), ...attr('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name')][0] ?? email;
    const assertion = JSON.stringify(profile.getAssertion?.() ?? {});
    const contexts = [...assertion.matchAll(/"AuthnContextClassRef":\[\{"_":"([^"]+)"/g)].map((m) => m[1]!);
    const mfa = samlSatisfiesMfa([...contexts, ...attr('http://schemas.microsoft.com/claims/authnmethodsreferences')]);
    return this.finish(c, st, fail, email, name, mfa);
  }

  /** Completes an OpenID Connect sign-in: one use of the state, code exchange, ID token checks, then the member. */
  async callback(code: string, state: string): Promise<SsoResult> {
    const { st, c, fail } = await this.consume(state, 'oidc');
    const d = await this.discover(c.issuer);
    const secret = decryptField(c.client_secret_enc!, this.config.fieldKeys);
    const postCreds = !(d.token_endpoint_auth_methods_supported ?? ['client_secret_basic']).includes('client_secret_basic');
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: decryptField(st.code_verifier_enc!, this.config.fieldKeys),
      ...(postCreds ? { client_id: c.client_id!, client_secret: secret } : {}),
    }).toString();
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (!postCreds) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.client_id!)}:${encodeURIComponent(secret)}`).toString('base64')}`;
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
      ({ payload: claims } = await jwtVerify(tokens.id_token, jwks, { issuer: d.issuer, audience: c.client_id!, algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256', 'ES384'], maxTokenAge: '10m', clockTolerance: 60 }));
    } catch (err) {
      return fail(`the ID token did not verify (${(err as Error).message})`);
    }
    if (claims.nonce !== st.nonce) return fail('the ID token is for a different sign-in (nonce)');
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (!email) return fail('the provider did not send an email address (add the email scope or claim)');
    if (claims.email_verified !== true && claims.email_verified !== 'true') return fail('the provider did not confirm the email address is verified');
    return this.finish(c, st, fail, email, typeof claims.name === 'string' ? claims.name : email, ssoSatisfiesMfa(claims.amr));
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
