import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  PLATFORM_INTEGRATION_INPUTS,
  PLATFORM_INTEGRATION_SECRETS,
  PLATFORM_INTEGRATIONS,
  type IntegrationTestExtras,
  type PlatformIntegrationKey,
  type PlatformIntegrationView,
  type PlatformServiceStatus,
} from '@crew/contracts';
import { createTransport } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { AnthropicProvider, ProviderError, type AnthropicSettings } from '../../modules/ai/ai-provider';
import { AuditService } from '../audit/audit.service';
import { decryptField, encryptField } from '../auth/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { requestContext } from '../context/request-context';
import { DatabaseService, many, one } from '../database/database.service';
import { Errors } from '../http/errors';
import { pingClamd } from '../storage/malware-scan';

type Values = Record<string, unknown>;
type Secrets = Record<string, string>;

/** One integration's values in effect, secrets in the clear. Never sent to a browser. */
export interface ResolvedIntegration {
  key: PlatformIntegrationKey;
  source: 'console' | 'environment' | 'none';
  enabled: boolean;
  settings: Values;
  secrets: Secrets;
  /** Changes whenever any setting or secret changes, so callers can rebuild clients (SMTP transport, AI client). */
  hash: string;
}

/** Email settings ready for nodemailer: either the environment's SMTP_URL or options saved in the Console. */
export interface EmailRuntime { transport: string | SMTPTransport.Options; from: string; hash: string }

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
}

/** How long a server keeps using what it read before checking the database again (other API servers pick up a change within this). */
const CACHE_MS = 5000;
const PLACEHOLDER_TOKEN = 'ExponentPushToken[crew-connection-check-0000]';

const hashOf = (settings: Values, secrets: Secrets) => createHash('sha256').update(JSON.stringify([sortKeys(settings), sortKeys(secrets)])).digest('hex');
const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const hint = (v: string) => (v.length <= 8 ? '••••' : `••••${v.slice(-4)}`);

/**
 * Installation-wide integrations (Claude AI, SMTP email, Expo push, ClamAV scanning, mobile sign-in addresses),
 * set up by SAMPLEDGE in the Super Admin Console. A value saved in the Console wins; while nothing is saved for an
 * integration, the server's environment variables are used, so an existing install keeps working and a new one can
 * be bootstrapped. Secrets are encrypted with the field encryption key and never returned, only their last
 * characters. Every change and every connection test is in the platform audit trail.
 */
@Injectable()
export class PlatformIntegrationsService {
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
      const row = await this.db.platform((tx) => one<Row>(tx, 'select key, enabled, settings, secrets_enc, config_hash from platform_integrations where key = $1', [key]));
      saved = row ? this.fromRow(row) : null;
      this.cache.set(key, { at: Date.now(), value: saved });
    }
    return saved ?? this.fromEnvironment(key);
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
    if (r.source === 'environment') return { transport: this.config.SMTP_URL!, from: this.config.MAIL_FROM, hash: r.hash };
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

  /** For a workspace's Settings > Integrations: which installation-wide services are on. No settings, no secrets. */
  async workspaceStatus(): Promise<PlatformServiceStatus[]> {
    const on: Record<PlatformIntegrationKey, boolean> = {
      ai: Boolean(await this.ai()),
      email: Boolean(await this.email()),
      push: (await this.push()).enabled,
      scanning: Boolean(await this.scanningUrl()),
      mobile_sso: (await this.mobileSsoRedirects()).length > 0,
    };
    return PLATFORM_INTEGRATIONS.map((d) => ({ key: d.key, name: d.name, description: d.description, on: on[d.key], whenOff: d.whenOff }));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Super Admin Console
  // ---------------------------------------------------------------------------------------------------------------

  async list(): Promise<PlatformIntegrationView[]> {
    const rows = await this.db.platform((tx) =>
      many<Row>(
        tx,
        `select i.key, i.enabled, i.settings, i.secrets_enc, i.secret_hints, i.config_hash, i.last_test_ok, i.last_test_detail, i.last_test_at, i.last_test_hash,
                i.updated_at, a.full_name as updated_by
           from platform_integrations i left join platform_admins a on a.id = i.updated_by_admin_id`,
      ),
    );
    return PLATFORM_INTEGRATIONS.map((d) => {
      const row = rows.find((r) => r.key === d.key);
      const env = this.fromEnvironment(d.key);
      const r = row ? this.fromRow(row) : env;
      const secrets = Object.fromEntries(
        PLATFORM_INTEGRATION_SECRETS[d.key].map((s) => {
          const v = r.secrets[s];
          return [s, { set: Boolean(v), hint: row ? row.secret_hints[s] ?? null : v ? hint(v) : null }];
        }),
      );
      return {
        key: d.key,
        source: r.source,
        enabled: r.enabled,
        settings: r.settings,
        secrets,
        environmentAvailable: env.source === 'environment',
        lastTest: row?.last_test_at ? { ok: row.last_test_ok!, detail: row.last_test_detail ?? '', at: row.last_test_at, current: row.last_test_hash === row.config_hash } : null,
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by ?? null,
      };
    });
  }

  /** Saves an integration's settings in the Console. Secret fields left empty keep the secret in effect; null removes it. */
  async save(key: PlatformIntegrationKey, raw: unknown): Promise<PlatformIntegrationView> {
    const { enabled, settings, secrets } = await this.candidate(key, raw);
    if (enabled) this.requireComplete(key, settings, secrets);
    const admin = requestContext.platformActor();
    const hash = hashOf(settings, secrets);
    const hints = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, hint(v)]));
    await this.db.platform(async (tx) => {
      const before = await one<{ enabled: boolean; settings: Values; config_hash: string }>(tx, 'select enabled, settings, config_hash from platform_integrations where key = $1 for update', [key]);
      await tx.query(
        `insert into platform_integrations (key, enabled, settings, secrets_enc, secret_hints, config_hash, updated_by_admin_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (key) do update set enabled = excluded.enabled, settings = excluded.settings, secrets_enc = excluded.secrets_enc,
                secret_hints = excluded.secret_hints, config_hash = excluded.config_hash, updated_by_admin_id = excluded.updated_by_admin_id, updated_at = now()`,
        [key, enabled, JSON.stringify(settings), Object.keys(secrets).length ? encryptField(JSON.stringify(secrets), this.config.fieldKeys) : '', JSON.stringify(hints), hash, admin.adminId],
      );
      await this.audit.record(tx, {
        tenantId: null, action: 'platform.integration_saved', resourceType: 'platform_integration', resourceId: key,
        changes: { before: before ? { enabled: before.enabled, settings: before.settings } : { source: 'environment' }, after: { enabled, settings }, secretsChanged: !before || before.config_hash !== hash ? Object.keys(secrets) : [] },
      });
    });
    this.cache.delete(key);
    return (await this.list()).find((v) => v.key === key)!;
  }

  /** Forgets the Console setting, so the server's environment variables apply again. */
  async reset(key: PlatformIntegrationKey): Promise<PlatformIntegrationView> {
    await this.db.platform(async (tx) => {
      const r = await tx.query('delete from platform_integrations where key = $1', [key]);
      if (!r.rowCount) throw Errors.notFound('Saved setting');
      await this.audit.record(tx, { tenantId: null, action: 'platform.integration_reset', resourceType: 'platform_integration', resourceId: key });
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
      const r = await tx.query(
        `update platform_integrations set last_test_ok = $2, last_test_detail = $3, last_test_at = now(), last_test_hash = $4 where key = $1 and config_hash = $4`,
        [key, ok, detail, hash],
      );
      await this.audit.record(tx, { tenantId: null, action: 'platform.integration_tested', resourceType: 'platform_integration', resourceId: key, metadata: { ok, detail, savedValues: Boolean(r.rowCount) } });
      return Boolean(r.rowCount);
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
    if (key === 'email' && !settings.username) delete settings.username;
    if (key === 'ai' && !settings.baseUrl) delete settings.baseUrl;
    // A saved secret is only reused for the server it was saved for: pointing the key or password at a different
    // address needs it typed again, so a changed address cannot be used to send the saved secret somewhere else.
    const destination = (v: Values) => (key === 'ai' ? [v.baseUrl ?? ''] : key === 'email' ? [v.host, v.port, v.username ?? ''] : []);
    if (JSON.stringify(destination(settings)) !== JSON.stringify(destination(current.settings))) {
      for (const k of PLATFORM_INTEGRATION_SECRETS[key]) {
        const typed = input[k];
        if (current.secrets[k] && !(typeof typed === 'string' && typed.trim()) && typed !== null) {
          throw Errors.validation([{ path: k, message: `Enter the ${k === 'apiKey' ? 'API key' : 'password'} again: the server address changed, so the saved one is not sent there` }]);
        }
      }
    }
    if (key === 'mobile_sso') settings.redirects = [...new Set(settings.redirects as string[])];
    this.checkProduction(key, settings);
    return { enabled: input.enabled, settings, secrets };
  }

  private requireComplete(key: PlatformIntegrationKey, settings: Values, secrets: Secrets) {
    if (key === 'ai' && !secrets.apiKey) throw Errors.validation([{ path: 'apiKey', message: 'Paste the Claude API key' }]);
    if (key === 'email' && settings.username && !secrets.password) throw Errors.validation([{ path: 'password', message: 'Enter the password or API key for this user name' }]);
  }

  /** Staging and production refuse values that would send secrets or sign-ins over plain connections. */
  private checkProduction(key: PlatformIntegrationKey, settings: Values) {
    if (!this.config.isProductionLike) return;
    if (key === 'ai' && settings.baseUrl && !String(settings.baseUrl).startsWith('https://')) throw Errors.validation([{ path: 'baseUrl', message: 'Use an https:// address' }]);
    if (key === 'email' && settings.security === 'none') throw Errors.validation([{ path: 'security', message: 'Use STARTTLS or TLS: the password and email would otherwise cross the network unencrypted' }]);
    if (key === 'mobile_sso' && (settings.redirects as string[]).some((r) => /^http:/i.test(r))) throw Errors.validation([{ path: 'redirects', message: 'Plain http:// addresses are for local development only' }]);
  }

  private fromRow(row: Pick<Row, 'key' | 'enabled' | 'settings' | 'secrets_enc' | 'config_hash'>): ResolvedIntegration {
    const secrets = row.secrets_enc ? (JSON.parse(decryptField(row.secrets_enc, this.config.fieldKeys)) as Secrets) : {};
    return { key: row.key, source: 'console', enabled: row.enabled, settings: row.settings, secrets, hash: row.config_hash };
  }

  /** The bootstrap fallback: what the server's environment variables say, in the same shape as a Console setting. */
  private fromEnvironment(key: PlatformIntegrationKey): ResolvedIntegration {
    const c = this.config;
    let enabled = false;
    let present = false;
    let settings: Values = {};
    let secrets: Secrets = {};
    switch (key) {
      case 'ai':
        present = c.AI_PROVIDER === 'anthropic' || Boolean(c.ANTHROPIC_API_KEY);
        enabled = c.AI_PROVIDER === 'anthropic' && Boolean(c.ANTHROPIC_API_KEY);
        settings = { model: c.AI_MODEL, effort: c.AI_EFFORT, refusalFallback: c.AI_REFUSAL_FALLBACK === 'true', timeoutSeconds: Math.round(c.AI_TIMEOUT_MS / 1000), ...(c.ANTHROPIC_BASE_URL ? { baseUrl: c.ANTHROPIC_BASE_URL } : {}) };
        secrets = c.ANTHROPIC_API_KEY ? { apiKey: c.ANTHROPIC_API_KEY } : {};
        break;
      case 'email': {
        present = enabled = Boolean(c.SMTP_URL);
        settings = { port: 587, security: 'starttls', from: c.MAIL_FROM };
        if (c.SMTP_URL) {
          const u = new URL(c.SMTP_URL);
          settings = { host: u.hostname, port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587), security: u.protocol === 'smtps:' ? 'tls' : 'none', from: c.MAIL_FROM, ...(u.username ? { username: decodeURIComponent(u.username) } : {}) };
          if (u.password) secrets = { password: decodeURIComponent(u.password) };
        }
        break;
      }
      case 'push':
        present = enabled = c.EXPO_PUSH_ENABLED === 'true';
        secrets = c.EXPO_ACCESS_TOKEN ? { accessToken: c.EXPO_ACCESS_TOKEN } : {};
        present ||= Boolean(c.EXPO_ACCESS_TOKEN);
        break;
      case 'scanning':
        present = enabled = Boolean(c.CLAMAV_URL);
        settings = c.CLAMAV_URL ? { url: c.CLAMAV_URL } : {};
        break;
      case 'mobile_sso': {
        const redirects = c.MOBILE_SSO_REDIRECTS.split(',').map((s) => s.trim()).filter(Boolean);
        present = enabled = redirects.length > 0;
        settings = { redirects };
        break;
      }
    }
    return { key, source: present ? 'environment' : 'none', enabled, settings, secrets, hash: hashOf(settings, secrets) };
  }
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
