import { fetchBrand, type BrandApiKeys } from './company-data';
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  INTERNAL_PLATFORM_INTEGRATIONS,
  PAYMENT_GATEWAYS,
  PLATFORM_INTEGRATION_INPUTS,
  PLATFORM_INTEGRATION_SECRETS,
  PLATFORM_INTEGRATIONS,
  type IntegrationTestExtras,
  type PaymentGateway,
  type PlatformIntegrationKey,
  type PlatformIntegrationView,
  type PlatformServiceStatus,
} from '@crew/contracts';
import { createTransport } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { AnthropicProvider, ProviderError, type AnthropicSettings } from '../../modules/ai/ai-provider';
import { DEFAULT_BASE, GatewayError, probe as probeGateway, type GatewayKeys } from '../../modules/billing/gateways';
import { AuditService } from '../audit/audit.service';
import { decryptField, encryptField } from '../auth/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService } from '../database/mongo.service';
import { Errors } from '../http/errors';
import { pingClamd } from '../storage/malware-scan';
import { probeBackupStorage } from './backup-storage-probe';
import { legacyIntegrations } from './legacy-environment';

type Values = Record<string, unknown>;
type Secrets = Record<string, string>;

/** One integration's values in effect, secrets in the clear. Never sent to a browser. */
export interface ResolvedIntegration {
  key: PlatformIntegrationKey;
  source: 'console' | 'default' | 'none';
  enabled: boolean;
  settings: Values;
  secrets: Secrets;
  /** Changes whenever any setting or secret changes, so callers can rebuild clients (SMTP transport, AI client). */
  hash: string;
}

/** Email settings ready for nodemailer, as saved in the Console. */
export interface EmailRuntime { transport: SMTPTransport.Options; from: string; hash: string }

export interface TestResult { ok: boolean; detail: string; recorded: boolean }

interface Row {
  key: PlatformIntegrationKey;
  enabled: boolean;
  settings: Values;
  secrets_enc: string;
  secret_hints: Record<string, string>;
  config_hash: string;
  last_test_ok: boolean | null;
  last_test_detail: string | null;
  last_test_at: string | null;
  last_test_hash: string | null;
  updated_at: string;
  updated_by: string | null;
  updated_by_admin_id?: string | null;
  updated_by_label?: string | null;
  imported_from?: string[] | null;
}

/** Who saves a setting when no Console admin is signed in (the integrations command, a move from old variables). */
export interface SaveOptions { label?: string }

/** How long a server keeps using what it read before checking the database again (other API servers pick up a change within this). */
const CACHE_MS = 5000;
const PLACEHOLDER_TOKEN = 'ExponentPushToken[crew-connection-check-0000]';

const hashOf = (settings: Values, secrets: Secrets) => createHash('sha256').update(JSON.stringify([sortKeys(settings), sortKeys(secrets)])).digest('hex');
const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const hint = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

/** The mobile app's own return address after single sign-on: accepted until the Console says otherwise. */
const DEFAULT_MOBILE_SSO = ['crew://sso'];

/**
 * Installation-wide integrations (Claude AI, SMTP email, Expo push, ClamAV scanning, mobile sign-in addresses,
 * Razorpay, Stripe, off-site backups), set up by SAMPLEDGE in the Super Admin Console. Every key, password and
 * address lives only in the database (platform_integrations), never in the server's environment or a settings file:
 * whoever runs SampCrew pastes them into the Console, tests them and switches them on, with no restart. Secrets are
 * encrypted with the field encryption key and never returned, only their last characters. Every change and every
 * connection test is in the platform audit trail.
 *
 * Upgrading from a release that read these from environment variables: on start, a variable that is still set for an
 * integration with nothing saved is moved into the database once (audited, and the Console asks for the line to be
 * deleted). After that the variables are never read again.
 */
@Injectable()
export class PlatformIntegrationsService implements OnApplicationBootstrap {
  private readonly log = new Logger('PlatformIntegrations');
  /** The saved Console setting per integration (null: none saved), as read at `at`. */
  private readonly cache = new Map<PlatformIntegrationKey, { at: number; value: ResolvedIntegration | null }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // What the rest of SampCrew uses
  // ---------------------------------------------------------------------------------------------------------------

  async resolve(key: PlatformIntegrationKey): Promise<ResolvedIntegration> {
    const hit = this.cache.get(key);
    let saved = hit && Date.now() - hit.at < CACHE_MS ? hit.value : undefined;
    if (saved === undefined) {
      const row = await this.db.platform((tx) => tx.collection<Row>('platform_integrations').findOne({ key }));
      saved = row ? this.fromRow(row) : null;
      this.cache.set(key, { at: Date.now(), value: saved });
    }
    return saved ?? builtInDefault(key);
  }

  async onApplicationBootstrap() {
    await this.importLegacyEnvironment(process.env);
  }

  /**
   * Moves integration settings an older release read from environment variables into the database, for each
   * integration with nothing saved yet. Safe with several API servers starting at once (the first one wins). Returns
   * the integrations it moved.
   */
  async importLegacyEnvironment(env: NodeJS.ProcessEnv): Promise<PlatformIntegrationKey[]> {
    const found = legacyIntegrations(env, this.config.isProductionLike);
    const moved: PlatformIntegrationKey[] = [];
    for (const problem of found.problems) this.log.error(`${problem} It was not moved into the database; set it up in Console > Integrations and delete the line.`);
    for (const item of found.items) {
      if (await this.db.platform((tx) => tx.collection('platform_integrations').exists({ key: item.key }))) {
        this.log.warn(`${item.variables.join(', ')} ${item.variables.length === 1 ? 'is' : 'are'} ignored: ${item.key} is managed in Console > Integrations. Delete ${item.variables.length === 1 ? 'it' : 'them'} from the server's settings.`);
        continue;
      }
      if (item.sameAsDefault) {
        this.log.warn(`${item.variables.join(', ')} only repeats SampCrew's default and is no longer read; delete it from the server's settings.`);
        continue;
      }
      try {
        const saved = await this.write(item.key, item.enabled, item.settings, item.secrets, { label: 'moved from the server\'s environment variables', importedFrom: item.variables, onlyIfMissing: true });
        if (!saved) continue;
        moved.push(item.key);
        this.log.warn(`Moved ${item.variables.join(', ')} into the database: ${item.key} is managed in Console > Integrations from now on. Delete ${item.variables.length === 1 ? 'that line' : 'those lines'} from the server's settings.`);
      } catch (e) {
        this.log.error(`Could not move ${item.variables.join(', ')} into the database: ${(e as Error).message}`);
      }
    }
    return moved;
  }

  /** The Claude API settings in effect, or null when AI is not set up (or switched off). */
  async ai(): Promise<(AnthropicSettings & { hash: string }) | null> {
    const r = await this.resolve('ai');
    if (!r.enabled || !r.secrets.apiKey) return null;
    return {
      apiKey: r.secrets.apiKey,
      baseUrl: (r.settings.baseUrl as string) || null,
      model: r.settings.model as string,
      effort: r.settings.effort as AnthropicSettings['effort'],
      refusalFallback: r.settings.refusalFallback as boolean,
      timeoutMs: (r.settings.timeoutSeconds as number) * 1000,
      hash: r.hash,
    };
  }

  async email(): Promise<EmailRuntime | null> {
    const r = await this.resolve('email');
    if (!r.enabled) return null;
    return { transport: smtpOptions(r.settings, r.secrets), from: r.settings.from as string, hash: r.hash };
  }

  async push(): Promise<{ enabled: boolean; accessToken: string | null }> {
    const r = await this.resolve('push');
    return { enabled: r.enabled, accessToken: r.secrets.accessToken ?? null };
  }

  /** The ClamAV address uploads are scanned with, or null when scanning is off. */
  async scanningUrl(): Promise<string | null> {
    const r = await this.resolve('scanning');
    return r.enabled && r.settings.url ? (r.settings.url as string) : null;
  }

  async mobileSsoRedirects(): Promise<string[]> {
    const r = await this.resolve('mobile_sso');
    return r.enabled ? ((r.settings.redirects as string[]) ?? []) : [];
  }

  /** A payment gateway's keys when it is switched on and complete, else null. */
  async gateway(provider: PaymentGateway): Promise<GatewayKeys | null> {
    const r = await this.resolve(provider);
    if (!r.enabled) return null;
    const keys = gatewayKeys(provider, r.settings, r.secrets);
    return keys.secret && keys.webhookSecret ? keys : null;
  }

  /** The webhook secret of a gateway, even while it is switched off (a late webhook for a paid order still counts). */
  async gatewayWebhookSecret(provider: PaymentGateway): Promise<string | null> {
    const r = await this.resolve(provider);
    return r.secrets.webhookSecret ?? null;
  }

  /** The company-data (Brandfetch) key when it is switched on, else null. */
  async companyData(): Promise<BrandApiKeys | null> {
    const r = await this.resolve('company_data');
    return r.enabled && r.secrets.apiKey ? { apiKey: r.secrets.apiKey, baseUrl: (r.settings.baseUrl as string) || null } : null;
  }

  /** For a workspace's Settings > Integrations: which installation-wide services are on. No settings, no secrets. */
  async workspaceStatus(): Promise<PlatformServiceStatus[]> {
    const on: Record<Exclude<PlatformIntegrationKey, 'backups' | 'company_data'>, boolean> = {
      ai: Boolean(await this.ai()),
      email: Boolean(await this.email()),
      push: (await this.push()).enabled,
      scanning: Boolean(await this.scanningUrl()),
      mobile_sso: (await this.mobileSsoRedirects()).length > 0,
      razorpay: Boolean(await this.gateway('razorpay')),
      stripe: Boolean(await this.gateway('stripe')),
    };
    return PLATFORM_INTEGRATIONS.filter((d) => !INTERNAL_PLATFORM_INTEGRATIONS.includes(d.key)).map((d) => ({ key: d.key, name: d.name, description: d.description, on: on[d.key as keyof typeof on], whenOff: d.whenOff }));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Super Admin Console
  // ---------------------------------------------------------------------------------------------------------------

  async list(): Promise<PlatformIntegrationView[]> {
    const rows = await this.db.platform(async (tx) => {
      const saved = await tx.collection<Row>('platform_integrations').find({});
      const admins = new Map((await tx.collection('platform_admins').find({ id: { $in: saved.map((x) => x.updated_by_admin_id).filter(Boolean) } }, { projection: { full_name: 1 } })).map((a) => [a.id as string, a.full_name as string]));
      return saved.map((x) => ({ ...x, updated_by: (x.updated_by_admin_id && admins.get(x.updated_by_admin_id as string)) ?? x.updated_by_label ?? null }));
    });
    return PLATFORM_INTEGRATIONS.map((d) => {
      const row = rows.find((r) => r.key === d.key);
      const r = row ? this.fromRow(row) : builtInDefault(d.key);
      const secrets = Object.fromEntries(PLATFORM_INTEGRATION_SECRETS[d.key].map((s) => [s, { set: Boolean(r.secrets[s]), hint: row?.secret_hints[s] ?? null }]));
      return {
        key: d.key,
        ...(d.webhookPath ? { webhookUrl: `${this.config.API_PUBLIC_URL.replace(/\/$/, '')}${d.webhookPath}` } : {}),
        source: r.source,
        enabled: r.enabled,
        settings: r.settings,
        secrets,
        imported: row?.imported_from?.length ? { variables: row.imported_from, at: row.updated_at } : null,
        lastTest: row?.last_test_at ? { ok: row.last_test_ok!, detail: row.last_test_detail ?? '', at: row.last_test_at, current: row.last_test_hash === row.config_hash } : null,
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by ?? null,
      };
    });
  }

  /**
   * Saves an integration's settings (from the Console, or the integrations command with `opts.label`). Secret fields
   * left empty keep the saved secret; null removes it.
   */
  async save(key: PlatformIntegrationKey, raw: unknown, opts: SaveOptions = {}): Promise<PlatformIntegrationView> {
    const { enabled, settings, secrets } = await this.candidate(key, raw);
    if (enabled) {
      this.requireComplete(key, settings, secrets);
      this.requireEnabled(key, secrets);
    }
    await this.write(key, enabled, settings, secrets, { label: opts.label });
    return (await this.list()).find((v) => v.key === key)!;
  }

  /** Writes one integration's row and its audit event. With onlyIfMissing, does nothing (returns false) when a row exists. */
  private async write(key: PlatformIntegrationKey, enabled: boolean, settings: Values, secrets: Secrets, opts: { label?: string; importedFrom?: string[]; onlyIfMissing?: boolean }): Promise<boolean> {
    const actor = requestContext.get()?.actor;
    const adminId = actor?.kind === 'platform_admin' ? actor.adminId : null;
    if (!adminId && !opts.label) throw new Error('A setting saved outside the Console needs a label saying who saved it');
    const hash = hashOf(settings, secrets);
    const hints = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, hint(v)]));
    const written = await this.db.platform(async (tx) => {
      const table = tx.collection<{ enabled: boolean; settings: Values; config_hash: string }>('platform_integrations');
      await table.lock({ key });
      const before = await table.findOne({ key });
      if (before && opts.onlyIfMissing) return false;
      const values = {
        enabled, settings, secrets_enc: Object.keys(secrets).length ? encryptField(JSON.stringify(secrets), this.config.fieldKeys) : '', secret_hints: hints,
        config_hash: hash, updated_by_admin_id: adminId, updated_by_label: adminId ? null : opts.label!, imported_from: opts.importedFrom ?? null,
      };
      await table.upsert({ key }, { key, ...values }, { $set: { ...values, updated_at: new Date() } });
      await this.audit.record(tx, {
        tenantId: null, action: opts.importedFrom ? 'platform.integration_imported' : 'platform.integration_saved', resourceType: 'platform_integration', resourceId: key,
        ...(adminId ? {} : { actorLabel: opts.label }),
        changes: { before: before ? { enabled: before.enabled, settings: before.settings } : null, after: { enabled, settings }, secretsChanged: !before || before.config_hash !== hash ? Object.keys(secrets) : [] },
        ...(opts.importedFrom ? { metadata: { variables: opts.importedFrom } } : {}),
      });
      return true;
    }).catch((e: unknown) => {
      // Another API server starting at the same moment moved the same variables first.
      if (opts.onlyIfMissing && /duplicate|E11000|unique/i.test((e as Error).message)) return false;
      throw e;
    });
    this.cache.delete(key);
    return written;
  }

  /** Removes the saved setting: the integration is off again (the mobile app's sign-in address falls back to crew://sso). */
  async reset(key: PlatformIntegrationKey, opts: SaveOptions = {}): Promise<PlatformIntegrationView> {
    await this.db.platform(async (tx) => {
      if (!(await tx.collection('platform_integrations').deleteOne({ key }))) throw Errors.notFound('Saved setting');
      await this.audit.record(tx, { tenantId: null, action: 'platform.integration_reset', resourceType: 'platform_integration', resourceId: key, ...(opts.label ? { actorLabel: opts.label } : {}) });
    });
    this.cache.delete(key);
    return (await this.list()).find((v) => v.key === key)!;
  }

  /**
   * Tries the values on screen (merged with the secrets already in effect) against the real service, without saving
   * them. When they are exactly the saved values, the result is kept and shown with the integration.
   */
  async test(key: PlatformIntegrationKey, raw: unknown, extras: IntegrationTestExtras): Promise<TestResult> {
    const { settings, secrets } = await this.candidate(key, raw);
    this.requireComplete(key, settings, secrets);
    const started = Date.now();
    let ok = false;
    let detail: string;
    try {
      detail = await this.probe(key, settings, secrets, extras);
      ok = true;
    } catch (e) {
      detail = (e as Error).message.slice(0, 500);
    }
    detail = `${detail} (${Date.now() - started} ms)`;
    const hash = hashOf(settings, secrets);
    const recorded = await this.db.platform(async (tx) => {
      const n = await tx.collection('platform_integrations').updateOne(
        { key, config_hash: hash },
        { $set: { last_test_ok: ok, last_test_detail: detail, last_test_at: new Date(), last_test_hash: hash } },
      );
      await this.audit.record(tx, { tenantId: null, action: 'platform.integration_tested', resourceType: 'platform_integration', resourceId: key, metadata: { ok, detail, savedValues: Boolean(n) } });
      return Boolean(n);
    });
    return { ok, detail, recorded };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async probe(key: PlatformIntegrationKey, settings: Values, secrets: Secrets, extras: IntegrationTestExtras): Promise<string> {
    switch (key) {
      case 'ai': {
        const provider = new AnthropicProvider({
          apiKey: secrets.apiKey!, baseUrl: (settings.baseUrl as string) || null, model: settings.model as string,
          effort: settings.effort as AnthropicSettings['effort'], refusalFallback: false, timeoutMs: Math.min((settings.timeoutSeconds as number) * 1000, 30_000),
        });
        try {
          const r = await provider.complete({ system: 'You are checking that a connection works. Answer with the single word OK.', user: 'Reply with OK.', maxTokens: 16 });
          return `Claude answered using ${r.model}`;
        } catch (e) {
          throw new Error(e instanceof ProviderError ? e.message : `Could not call the Claude API: ${(e as Error).message}`);
        }
      }
      case 'email': {
        const t = createTransport({ ...smtpOptions(settings, secrets), connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
        try {
          await t.verify();
          if (!extras.sendTo) return `Signed in to ${settings.host}:${settings.port}`;
          const info = await t.sendMail({
            from: settings.from as string, to: extras.sendTo, subject: 'SampCrew test email',
            text: 'This is a test email from the SampCrew Super Admin Console. If you can read it, SampCrew can send email with these settings.',
          });
          return `Signed in to ${settings.host}:${settings.port} and sent a test email to ${extras.sendTo}${info.response ? ` (server said: ${String(info.response).slice(0, 120)})` : ''}`;
        } catch (e) {
          throw new Error(`Email server ${settings.host}:${settings.port}: ${(e as Error).message}`);
        } finally {
          t.close();
        }
      }
      case 'push': {
        const to = extras.pushToken ?? PLACEHOLDER_TOKEN;
        let res: Response;
        try {
          res = await fetch(this.config.EXPO_PUSH_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', ...(secrets.accessToken ? { authorization: `Bearer ${secrets.accessToken}` } : {}) },
            body: JSON.stringify([{ to, title: 'SampCrew', body: 'Test notification from the SampCrew Super Admin Console.', data: { test: true } }]),
            signal: AbortSignal.timeout(10_000),
          });
        } catch (e) {
          throw new Error(`Could not reach the Expo push service: ${(e as Error).message}`);
        }
        const body = (await res.json().catch(() => ({}))) as { data?: { status: string; message?: string; details?: { error?: string } }[]; errors?: { code?: string; message?: string }[] };
        if (res.status === 401 || res.status === 403) throw new Error(`Expo refused the access token (${res.status})${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ''}`);
        if (!res.ok) throw new Error(`Expo push service answered ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ''}`);
        const ticket = Array.isArray(body.data) ? body.data[0] : undefined;
        if (!extras.pushToken) return 'The Expo push service accepted SampCrew\'s request. Paste a device\'s push token to send it a real test alert';
        if (ticket?.status === 'ok') return 'Expo accepted the test alert for that device';
        throw new Error(`Expo did not accept the test alert: ${ticket?.details?.error ?? ticket?.message ?? 'no ticket returned'}`);
      }
      case 'scanning': {
        if (await pingClamd(settings.url as string, 5000)) return `The scanner at ${settings.url} answered PING`;
        throw new Error(`The scanner at ${settings.url} did not answer. Check that clamd is running and that this server can reach it`);
      }
      case 'mobile_sso':
        return `${(settings.redirects as string[]).length} app address(es) are valid`;
      case 'razorpay':
      case 'stripe':
        try {
          const detail = await probeGateway(gatewayKeys(key, settings, secrets));
          return secrets.webhookSecret ? detail : `${detail}. Add the webhook secret before switching it on`;
        } catch (e) {
          throw new Error(e instanceof GatewayError ? e.message : `Could not reach ${key === 'razorpay' ? 'Razorpay' : 'Stripe'}: ${(e as Error).message}`);
        }
      case 'backups':
        return probeBackupStorage(settings, secrets);
      case 'company_data': {
        const found = await fetchBrand({ apiKey: secrets.apiKey ?? '', baseUrl: (settings.baseUrl as string) || null }, 'brandfetch.com');
        return `Brandfetch answered: found ${found.name ?? 'brandfetch.com'}`;
      }
    }
  }

  /** Validates the submitted values and merges in the secrets in effect for fields left empty. */
  private async candidate(key: PlatformIntegrationKey, raw: unknown): Promise<{ enabled: boolean; settings: Values; secrets: Secrets }> {
    const parsed = PLATFORM_INTEGRATION_INPUTS[key].safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const input = parsed.data as Values & { enabled: boolean };
    const current = await this.resolve(key);
    const secrets: Secrets = {};
    const settings: Values = {};
    for (const [k, v] of Object.entries(input)) {
      if (k === 'enabled') continue;
      if (PLATFORM_INTEGRATION_SECRETS[key].includes(k)) {
        if (v === null) continue;
        const s = typeof v === 'string' ? v.trim() : '';
        if (s) secrets[k] = s;
        else if (current.secrets[k]) secrets[k] = current.secrets[k]!;
      } else if (v !== undefined) {
        settings[k] = typeof v === 'string' ? v.trim() : v;
      }
    }
    // A secret field left out altogether keeps the one in effect, like an empty one.
    for (const k of PLATFORM_INTEGRATION_SECRETS[key]) if (!(k in input) && current.secrets[k]) secrets[k] = current.secrets[k]!;
    if (key === 'email' && !settings.username) delete settings.username;
    if ((key === 'ai' || key === 'razorpay' || key === 'stripe' || key === 'company_data') && !settings.baseUrl) delete settings.baseUrl;
    if (key === 'stripe' && !settings.publishableKey) delete settings.publishableKey;
    if (key === 'backups') {
      // Only the chosen provider's fields are kept, so switching provider cannot leave another one's key behind.
      const keep: Record<string, string[]> = { s3: ['bucket', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey'], azure: ['account', 'bucket', 'accountKey'], sftp: ['host', 'port', 'user', 'privateKey', 'password'], folder: [] };
      const own = new Set(['provider', 'path', 'keepDays', 'alertWebhook', ...keep[settings.provider as string]!]);
      for (const k of Object.keys(settings)) if (!own.has(k) || settings[k] === '') delete settings[k];
      for (const k of Object.keys(secrets)) if (!own.has(k)) delete secrets[k];
      if (settings.provider === 'sftp') settings.port ??= 22;
    }
    // A saved secret is only reused for the server it was saved for: pointing the key or password at a different
    // address needs it typed again, so a changed address cannot be used to send the saved secret somewhere else.
    const destination = (v: Values) => (key === 'ai' || key === 'stripe' || key === 'company_data' ? [v.baseUrl ?? ''] : key === 'razorpay' ? [v.baseUrl ?? '', v.keyId ?? ''] : key === 'email' ? [v.host, v.port, v.username ?? '']
      : key === 'backups' ? [v.provider, v.endpoint ?? '', v.bucket ?? '', v.accessKeyId ?? '', v.account ?? '', v.host ?? '', v.port ?? '', v.user ?? ''] : []);
    if (JSON.stringify(destination(settings)) !== JSON.stringify(destination(current.settings))) {
      for (const k of PLATFORM_INTEGRATION_SECRETS[key]) {
        const typed = input[k];
        if (current.secrets[k] && !(typeof typed === 'string' && typed.trim()) && typed !== null) {
          // The alert address is a destination of its own, not a credential for the storage; and a secret of another
          // backup provider is dropped (above), not sent anywhere.
          if (k === 'alertWebhook' || (key === 'backups' && !(k in secrets))) continue;
          throw Errors.validation([{ path: k, message: `Enter the ${SECRET_LABEL[k] ?? 'password'} again: the server address changed, so the saved one is not sent there` }]);
        }
      }
    }
    if (key === 'mobile_sso') settings.redirects = [...new Set(settings.redirects as string[])];
    this.checkProduction(key, settings);
    return { enabled: input.enabled, settings, secrets };
  }

  private requireComplete(key: PlatformIntegrationKey, settings: Values, secrets: Secrets) {
    if (key === 'ai' && !secrets.apiKey) throw Errors.validation([{ path: 'apiKey', message: 'Paste the Claude API key' }]);
    if (key === 'company_data' && !secrets.apiKey) throw Errors.validation([{ path: 'apiKey', message: 'Paste the Brandfetch API key' }]);
    if (key === 'email' && settings.username && !secrets.password) throw Errors.validation([{ path: 'password', message: 'Enter the password or API key for this user name' }]);
    if (key === 'razorpay' && !secrets.keySecret) throw Errors.validation([{ path: 'keySecret', message: 'Paste the Razorpay key secret' }]);
    if (key === 'stripe' && !secrets.secretKey) throw Errors.validation([{ path: 'secretKey', message: 'Paste the Stripe secret key' }]);
    if (key === 'stripe' && secrets.secretKey && !/^(sk|rk)_(test|live)_/.test(secrets.secretKey)) throw Errors.validation([{ path: 'secretKey', message: 'Stripe secret keys start with sk_live_, sk_test_, rk_live_ or rk_test_' }]);
    if (key === 'backups') {
      if (settings.provider === 's3' && !secrets.secretAccessKey) throw Errors.validation([{ path: 'secretAccessKey', message: 'Paste the secret access key' }]);
      if (settings.provider === 'azure' && !secrets.accountKey) throw Errors.validation([{ path: 'accountKey', message: 'Paste an access key of the storage account' }]);
      if (settings.provider === 'sftp' && !secrets.privateKey && !secrets.password) throw Errors.validation([{ path: 'privateKey', message: 'Paste a private key (or enter a password)' }]);
      if (secrets.privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secrets.privateKey)) throw Errors.validation([{ path: 'privateKey', message: 'Paste the whole private key, from -----BEGIN to -----END' }]);
      if (secrets.alertWebhook && !/^https?:\/\/\S+$/.test(secrets.alertWebhook)) throw Errors.validation([{ path: 'alertWebhook', message: 'Enter the webhook address, starting with https://' }]);
    }
  }

  /** Switching a gateway on needs the webhook secret too: without it, payments could not be confirmed. */
  private requireEnabled(key: PlatformIntegrationKey, secrets: Secrets) {
    if ((PAYMENT_GATEWAYS as readonly string[]).includes(key) && !secrets.webhookSecret) {
      throw Errors.validation([{ path: 'webhookSecret', message: 'Paste the webhook secret: SampCrew needs it to confirm payments' }]);
    }
  }

  /** Staging and production refuse values that would send secrets or sign-ins over plain connections. */
  private checkProduction(key: PlatformIntegrationKey, settings: Values) {
    if (!this.config.isProductionLike) return;
    if ((key === 'ai' || key === 'razorpay' || key === 'stripe' || key === 'company_data') && settings.baseUrl && !String(settings.baseUrl).startsWith('https://')) throw Errors.validation([{ path: 'baseUrl', message: 'Use an https:// address' }]);
    if (key === 'email' && settings.security === 'none') throw Errors.validation([{ path: 'security', message: 'Use STARTTLS or TLS: the password and email would otherwise cross the network unencrypted' }]);
    if (key === 'mobile_sso' && (settings.redirects as string[]).some((r) => /^http:/i.test(r))) throw Errors.validation([{ path: 'redirects', message: 'Plain http:// addresses are for local development only' }]);
    if (key === 'backups' && settings.endpoint && !String(settings.endpoint).startsWith('https://')) throw Errors.validation([{ path: 'endpoint', message: 'Use an https:// address' }]);
  }

  private fromRow(row: Pick<Row, 'key' | 'enabled' | 'settings' | 'secrets_enc' | 'config_hash'>): ResolvedIntegration {
    const secrets = row.secrets_enc ? (JSON.parse(decryptField(row.secrets_enc, this.config.fieldKeys)) as Secrets) : {};
    return { key: row.key, source: 'console', enabled: row.enabled, settings: row.settings, secrets, hash: row.config_hash };
  }
}

/** What applies while nothing is saved: everything is off, except the mobile app's own sign-in address. */
function builtInDefault(key: PlatformIntegrationKey): ResolvedIntegration {
  const settings: Values = key === 'mobile_sso' ? { redirects: DEFAULT_MOBILE_SSO } : {};
  return { key, source: key === 'mobile_sso' ? 'default' : 'none', enabled: key === 'mobile_sso', settings, secrets: {}, hash: hashOf(settings, {}) };
}

const SECRET_LABEL: Record<string, string> = { apiKey: 'API key', keySecret: 'key secret', secretKey: 'secret key', webhookSecret: 'webhook secret', secretAccessKey: 'secret access key', accountKey: 'account key', privateKey: 'private key' };

function gatewayKeys(provider: PaymentGateway, settings: Values, secrets: Secrets): GatewayKeys {
  return {
    provider,
    keyId: provider === 'razorpay' ? (settings.keyId as string) : undefined,
    secret: (provider === 'razorpay' ? secrets.keySecret : secrets.secretKey) ?? '',
    webhookSecret: secrets.webhookSecret ?? null,
    baseUrl: (settings.baseUrl as string) || DEFAULT_BASE[provider],
  };
}

/** nodemailer options for SMTP settings saved in the Console. */
export function smtpOptions(settings: Values, secrets: Secrets): SMTPTransport.Options {
  const security = settings.security as 'starttls' | 'tls' | 'none';
  return {
    host: settings.host as string,
    port: settings.port as number,
    secure: security === 'tls',
    requireTLS: security === 'starttls',
    ignoreTLS: security === 'none',
    ...(settings.username ? { auth: { user: settings.username as string, pass: secrets.password ?? '' } } : {}),
  };
}
