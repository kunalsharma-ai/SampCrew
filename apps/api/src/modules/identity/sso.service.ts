import { Inject, Injectable, Logger } from '@nestjs/common';
import { emailDomain, samlSatisfiesMfa, type SsoConnectionInput, ssoSatisfiesMfa, UNLIMITED } from '@crew/contracts';
import { type CacheProvider, type Profile, SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { createHash, X509Certificate } from 'node:crypto';
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { AuditService } from '../../platform/audit/audit.service';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';
import { decryptField, encryptField, randomToken, sha256 } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
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
 *   - OpenID Connect (authorization code flow with PKCE, RFC 7636): SampCrew checks the ID token's signature against
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
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  get redirectUri() {
    return `${this.config.WEB_PUBLIC_URL.replace(/\/$/, '')}/sso/callback`;
  }

  /** SAML: SampCrew's entity ID (also where its metadata is published) and the Assertion Consumer Service URL. */
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

  /** SampCrew's SAML service provider metadata, to upload to the identity provider. */
  samlMetadata() {
    const noCache: CacheProvider = { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null };
    return this.saml({ saml_sso_url: 'https://example.invalid', saml_idp_cert: 'unused', issuer: 'unused' } as ConnectionRow, noCache).generateServiceProviderMetadata(null, null);
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
      const row = await tx.collection('sso_connections').findOne({});
      const c = row && {
        id: row.id,
        protocol: row.protocol,
        issuer: row.issuer,
        clientId: row.client_id ?? null,
        domains: row.domains,
        status: row.status,
        enforced: row.enforced,
        jitProvisioning: row.jit_provisioning,
        verifiedAt: row.verified_at ?? null,
        verifiedEmail: row.verified_email ?? null,
        updatedAt: row.updated_at,
        samlSsoUrl: row.saml_sso_url ?? null,
        samlCertExpiresAt: row.saml_cert_expires_at ?? null,
        samlCertFingerprint: row.saml_cert_fingerprint ?? null,
      };
      return { connection: c ?? null, redirectUri: this.redirectUri, saml: this.samlSp };
    });
  }

  async save(input: SsoConnectionInput) {
    const actor = requestContext.tenantActor();
    const saml = input.protocol === 'saml';
    let cert = input.protocol === 'saml' && input.certificate ? readCertificate(input.certificate) : null;
    if (input.protocol === 'saml') {
      // The browser goes there, SampCrew never calls it; plain http only for local tests.
      if (!this.allowPrivate && !input.ssoUrl.startsWith('https://')) throw Errors.validation([{ path: 'ssoUrl', message: 'Use the https address of your identity provider.' }]);
    } else await this.discover(input.issuer);
    const issuer = input.protocol === 'saml' ? input.idpEntityId : input.issuer;
    const clientId = input.protocol === 'oidc' ? input.clientId : null;
    const clientSecret = input.protocol === 'oidc' ? input.clientSecret : undefined;
    await this.db.tenant(async (tx) => {
      const existing = await tx.collection<{
        id: string; protocol: string; issuer: string; client_id: string | null; client_secret_enc: string | null; saml_sso_url: string | null;
        saml_idp_cert: string | null; saml_cert_expires_at: Date | null; saml_cert_fingerprint: string | null;
      }>('sso_connections').findOne({});
      if (saml && !cert) {
        // Other settings changed and the certificate left out: keep the stored one.
        if (existing?.protocol !== 'saml' || !existing.saml_idp_cert || !existing.saml_cert_fingerprint) throw Errors.validation([{ path: 'certificate', message: 'Required' }]);
        cert = { pem: existing.saml_idp_cert, expiresAt: existing.saml_cert_expires_at!, fingerprint: existing.saml_cert_fingerprint };
      }
      if (!saml && !clientSecret && (!existing || !existing.client_secret_enc)) throw Errors.validation([{ path: 'clientSecret', message: 'Required' }]);
      // Domains are claimed across workspaces, so the check needs the platform role.
      const taken = await tx.unscoped('sso_domains').findOne({ domain: { $in: input.domains }, tenant_id: { $ne: actor.tenantId } });
      if (taken) throw Errors.conflict('domain_taken', `${taken.domain} is already used for single sign-on by another workspace. Contact support if it is yours.`);
      const secret = clientSecret ? encryptField(clientSecret, this.config.fieldKeys) : null;
      const identityChanged =
        !existing || existing.protocol !== input.protocol || existing.issuer !== issuer || Boolean(clientSecret)
        || (saml ? existing.saml_sso_url !== (input as { ssoUrl: string }).ssoUrl || existing.saml_cert_fingerprint !== cert!.fingerprint : existing.client_id !== clientId);
      const fields = {
        protocol: input.protocol,
        issuer,
        client_id: clientId,
        domains: input.domains,
        jit_provisioning: input.jitProvisioning,
        saml_sso_url: saml ? (input as { ssoUrl: string }).ssoUrl : null,
        saml_idp_cert: cert?.pem ?? null,
        saml_cert_expires_at: cert?.expiresAt ?? null,
        saml_cert_fingerprint: cert?.fingerprint ?? null,
      };
      let id: string;
      if (!existing) {
        id = (await tx.collection('sso_connections').insert({ ...fields, client_secret_enc: secret, created_by_membership_id: actor.membershipId })).id;
      } else {
        id = existing.id;
        // A different provider, client or certificate must pass a new test before anyone can use it. Switching to
        // SAML drops the OpenID Connect secret; switching to OpenID Connect drops the SAML settings.
        await tx.collection('sso_connections').updateOne(
          { id },
          {
            $set: {
              ...fields,
              client_secret_enc: saml ? null : (secret ?? existing.client_secret_enc),
              ...(identityChanged ? { status: 'draft', enforced: false, verified_at: null, verified_email: null } : {}),
            },
          },
        );
      }
      await tx.collection('sso_domains').delete({});
      await tx.collection('sso_domains').insertMany(input.domains.map((domain) => ({ domain })));
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
      const c = await tx.collection('sso_connections').findOne({});
      if (!c) throw Errors.notFound('Single sign-on connection');
      if (status === 'active' && !c.verified_at) throw Errors.conflict('sso_not_tested', 'Run a test sign-in that succeeds before switching single sign-on on.');
      if (enforced && status !== 'active') throw Errors.badRequest('sso_enforce_needs_active', 'Single sign-on must be on to require it.');
      await tx.collection('sso_connections').updateOne({ id: c.id }, { $set: { status, enforced } });
      if (enforced && !c.enforced) {
        // Members (other than owners) signed in with a password are signed out, so their next sign-in goes through the provider.
        const owner = await tx.collection('roles').findOne({ key: 'tenant_owner' });
        const ownerMemberships = owner ? (await tx.collection('role_assignments').find({ role_id: owner.id })).map((a) => a.membership_id) : [];
        const ownerUsers = (await tx.collection('memberships').find({ id: { $in: ownerMemberships } }, { projection: { user_id: 1 } })).map((m) => m.user_id);
        await tx.unscoped('sessions').update(
          { tenant_id: actor.tenantId, revoked_at: null, user_id: { $nin: [actor.userId, ...ownerUsers] } },
          { $set: { revoked_at: new Date(), revoked_reason: 'sso_enforced' } },
        );
      }
      await this.audit.record(tx, { action: 'sso.status_changed', resourceType: 'sso_connection', resourceId: c.id, metadata: { status, enforced } });
    });
    return this.get();
  }

  async remove() {
    await this.db.tenant(async (tx) => {
      const c = await tx.collection('sso_connections').findOne({});
      if (!c) throw Errors.notFound('Single sign-on connection');
      await tx.collection('sso_domains').delete({});
      await tx.collection('sso_connections').updateOne({ id: c.id }, { $set: { status: 'disabled', enforced: false } });
      await this.audit.record(tx, { action: 'sso.disabled', resourceType: 'sso_connection', resourceId: c.id });
    });
    return { ok: true };
  }

  // Sign-in --------------------------------------------------------------------------------------------------------

  /** Whether password sign-in is closed to this member of this workspace (single sign-on required, not an owner). */
  async passwordBlocked(tx: PlatformTx, tenantId: string, membershipId: string) {
    if (!(await tx.collection('sso_connections').exists({ tenant_id: tenantId, enforced: true }))) return false;
    const owner = await tx.collection('roles').findOne({ tenant_id: tenantId, key: 'tenant_owner' });
    return !(owner && (await tx.collection('role_assignments').exists({ membership_id: membershipId, role_id: owner.id })));
  }

  /** Finds the workspace for an email's domain and returns the provider's sign-in address. */
  async startByEmail(email: string, client: Client, mobile?: Partial<MobileStart>) {
    if (client === 'mobile') {
      if (!mobile?.returnTo || !mobile.appChallenge) throw Errors.validation([{ path: 'appChallenge', message: 'The app must send returnTo and appChallenge' }]);
      if (!(await this.integrations.mobileSsoRedirects()).includes(mobile.returnTo)) throw Errors.badRequest('return_to_not_allowed', 'This app address is not allowed to receive single sign-on.');
    }
    const domain = emailDomain(email);
    const c = await this.db.platform(async (tx) => {
      const d = await tx.collection('sso_domains').findOne({ domain });
      const conn = d && (await tx.collection<ConnectionRow>('sso_connections').findOne({ tenant_id: d.tenant_id, status: 'active' }));
      return conn && (await tx.collection('tenants').exists({ id: conn.tenant_id, status: 'active' })) ? conn : undefined;
    });
    if (!c) throw Errors.notFound('Single sign-on for this email domain');
    return this.start(c, 'login', client, null, email, client === 'mobile' ? (mobile as MobileStart) : undefined);
  }

  /** Owners test the connection before switching it on. */
  async startTest() {
    const actor = requestContext.tenantActor();
    const c = await this.db.platform((tx) => tx.collection<ConnectionRow>('sso_connections').findOne({ tenant_id: actor.tenantId }));
    if (!c) throw Errors.notFound('Single sign-on connection');
    return this.start(c, 'test', 'web', actor.membershipId);
  }

  private async start(c: ConnectionRow, purpose: 'login' | 'test', client: Client, membershipId: string | null, loginHint?: string, mobile?: MobileStart) {
    const state = randomToken(32);
    const save = (nonce: string, verifier: string | null) =>
      this.db.platform((tx) =>
        tx.collection('sso_login_states').insert({
          state_hash: sha256(state),
          tenant_id: c.tenant_id,
          nonce,
          code_verifier_enc: verifier ? encryptField(verifier, this.config.fieldKeys) : null,
          purpose,
          client,
          protocol: c.protocol,
          started_by_membership_id: membershipId,
          return_to: mobile?.returnTo ?? null,
          app_challenge: mobile?.appChallenge ?? null,
          expires_at: new Date(Date.now() + STATE_TTL_MIN * 60_000),
        }),
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
    // One use: two callbacks with the same state write the same document, and only one transaction commits.
    const st = await this.db.platform((tx) =>
      tx.collection<StateRow>('sso_login_states').updateAndGet({ state_hash: sha256(state), used_at: null, expires_at: { $gt: new Date() } }, { $set: { used_at: new Date() } }),
    );
    if (!st) throw Errors.unauthorized('This sign-in link has expired or was already used. Start again.');
    const c = await this.db.platform((tx) => tx.collection<ConnectionRow>('sso_connections').findOne({ tenant_id: st.tenant_id }));
    if (!c || (st.purpose === 'login' && c.status !== 'active')) throw Errors.forbidden('Single sign-on is not switched on for this workspace');
    if (c.protocol !== protocol || st.protocol !== protocol) throw new AppError(401, 'sso_failed', 'Single sign-on failed: the workspace changed its single sign-on settings during this sign-in. Start again.', { purpose: st.purpose });
    if (!(await this.db.tenant((tx) => loadEntitlements(tx), { tenantId: c.tenant_id })).features.has('sso')) throw Errors.featureNotInPlan('Single sign-on');
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
        await tx.collection('sso_connections').updateOne({ id: c.id }, { $set: { verified_at: new Date(), verified_email: email } });
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
        tx.collection('sso_handoffs').insert({
          code_hash: sha256(code),
          tenant_id: c.tenant_id,
          user_id: member.userId,
          membership_id: member.membershipId,
          mfa,
          app_challenge: st.app_challenge,
          expires_at: new Date(Date.now() + HANDOFF_TTL_SEC * 1000),
        }),
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
      tx
        .collection<{ tenant_id: string; user_id: string; membership_id: string; mfa: boolean; app_challenge: string }>('sso_handoffs')
        .updateAndGet({ code_hash: sha256(code), used_at: null, expires_at: { $gt: new Date() } }, { $set: { used_at: new Date() } }),
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
      const u = await tx.collection('users').findOne({ email });
      const ms = u && (await tx.collection('memberships').findOne({ user_id: u.id, tenant_id: c.tenant_id }));
      const m = ms && { membership_id: ms.id as string, user_id: u!.id as string, status: ms.status as string, user_status: u!.status as string };
      if (m) {
        if (m.status === 'suspended' || m.user_status !== 'active') throw Errors.forbidden('Your access to this workspace is suspended. Contact your HR team.');
        if (m.status === 'invited') {
          await tx.collection('memberships').updateOne({ id: m.membership_id }, { $set: { status: 'active' } });
          await tx.collection('invitations').update({ membership_id: m.membership_id, accepted_at: null, revoked_at: null }, { $set: { accepted_at: new Date() } });
          await this.audit.record(tx, { tenantId: c.tenant_id, action: 'invitation.accepted', resourceType: 'membership', resourceId: m.membership_id, metadata: { via: 'sso' } });
        }
        return { userId: m.user_id, membershipId: m.membership_id };
      }
      if (!c.jit_provisioning) throw Errors.forbidden('You are not a member of this workspace yet. Ask your HR team to add you.');
      const seats = await tx.collection('memberships').count({ tenant_id: c.tenant_id, status: { $ne: 'suspended' } });
      const limit = (await this.db.tenant((ttx) => loadEntitlements(ttx), { tenantId: c.tenant_id })).limits.max_employees;
      if (limit !== undefined && limit !== UNLIMITED && seats >= limit) throw Errors.forbidden('This workspace has no seats left. Ask your HR team to add you.');
      const userId = (u ?? (await tx.collection('users').insert({ email, full_name: name.slice(0, 160) }))).id as string;
      const entity = await tx.collection('legal_entities').findOne({ tenant_id: c.tenant_id, archived_at: null }, { sort: { created_at: 1 } });
      const membershipId = (await tx.collection('memberships').insert({ tenant_id: c.tenant_id, user_id: userId, status: 'active', legal_entity_id: entity?.id ?? null, provisioned_by: 'sso' })).id as string;
      const employeeRole = await tx.collection('roles').findOne({ tenant_id: c.tenant_id, key: 'employee' });
      if (employeeRole) await tx.collection('role_assignments').insert({ tenant_id: c.tenant_id, membership_id: membershipId, role_id: employeeRole.id });
      await this.audit.record(tx, { tenantId: c.tenant_id, action: 'membership.provisioned', resourceType: 'membership', resourceId: membershipId, changes: { email }, metadata: { via: 'sso_jit' } });
      await this.outbox.publish(tx, c.tenant_id, 'membership.invited', { membershipId, email });
      return { userId, membershipId };
    });
  }
}
