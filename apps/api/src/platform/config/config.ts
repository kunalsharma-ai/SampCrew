import { z } from 'zod';

/** Treats an empty variable (e.g. `SMTP_URL=` in .env) as unset. */
const optional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const schema = z.object({
  CREW_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_PLATFORM_SECRET: z.string().min(32, 'JWT_PLATFORM_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** SMTP connection URL, e.g. smtp://localhost:1025 for Mailpit. Unset means email is not configured: messages are kept and marked skipped. */
  SMTP_URL: optional(z.string().regex(/^smtps?:\/\//, 'SMTP_URL must start with smtp:// or smtps://')),
  MAIL_FROM: z.string().default('CREW <no-reply@crew.local>'),
  /** Directory for uploaded files when using the local storage driver. */
  STORAGE_DIR: z.string().default('./.data/files'),
  /** Secret for signing short-lived download links. Defaults to a key derived from FIELD_ENCRYPTION_KEY. */
  FILE_URL_SECRET: optional(z.string().min(32)),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  /** Set to true to stop background loops (outbox, email, daily HR jobs), e.g. in tests. */
  CREW_DISABLE_DISPATCHER: z.enum(['true', 'false']).default('false'),
  /**
   * Push notifications to the mobile app through the Expo push service. Off by default: queued pushes are then
   * marked skipped with a reason, so CREW never claims a push was delivered when it was not.
   */
  EXPO_PUSH_ENABLED: z.enum(['true', 'false']).default('false'),
  EXPO_PUSH_URL: z.string().url().default('https://exp.host/--/api/v2/push/send'),
  /** Optional Expo access token, needed when "enhanced push security" is on for the Expo project. */
  EXPO_ACCESS_TOKEN: optional(z.string().min(20)),
  /**
   * AI provider for the copilots. 'none' (the default) means AI is not set up: every AI feature says so and no
   * data leaves CREW. 'anthropic' calls the Claude API with ANTHROPIC_API_KEY.
   */
  AI_PROVIDER: z.enum(['none', 'anthropic']).default('none'),
  ANTHROPIC_API_KEY: optional(z.string().min(10)),
  /** Optional override, e.g. a regional gateway or a local stub in tests. */
  ANTHROPIC_BASE_URL: optional(z.string().url()),
  AI_MODEL: z.string().min(3).max(100).default('claude-opus-5-5'),
  /** How much the model reasons before answering. Short grounded answers do not need much. */
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
  /** Retry a refused request on the provider's fallback model (Claude API only). */
  AI_REFUSAL_FALLBACK: z.enum(['true', 'false']).default('true'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  /**
   * Let webhooks and connectors call private and local network addresses (and plain http). For local development
   * and tests only; refused in staging and production, where those calls could reach internal services.
   */
  INTEGRATIONS_ALLOW_PRIVATE_URLS: z.enum(['true', 'false']).default('false'),
  /** Where the mobile app may ask to be sent back after single sign-on (comma-separated, exact matches). */
  MOBILE_SSO_REDIRECTS: z.string().default('crew://sso'),
  /** Tests only: send Slack messages to this base instead of https://hooks.slack.com (refused in staging and production). */
  SLACK_WEBHOOK_BASE_URL: optional(z.string().url()),
  /** Redis for state shared by API servers (rate-limit counters). Needed when running more than one API replica. */
  REDIS_URL: optional(z.string().regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:\/\/ or rediss:\/\/')),
  /**
   * ClamAV daemon for scanning uploaded files, e.g. tcp://clamav:3310 (infra/deploy/compose.yml, profile "scan").
   * When set, every uploaded document, receipt and CV is scanned before it is stored, and uploads are refused while
   * the scanner is unreachable. When unset, uploads are not scanned (System health in the Console says so).
   */
  CLAMAV_URL: optional(z.string().regex(/^tcp:\/\/[^\s/:]+:\d+$/, 'CLAMAV_URL must look like tcp://host:3310')),
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'FIELD_ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
  /**
   * Earlier field encryption keys, comma-separated, kept only to read values not yet re-encrypted after a rotation
   * (docs/ops/runbook.md, "Secrets"). Empty when no rotation is in progress.
   */
  FIELD_ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .default('')
    .refine((v) => v.split(',').map((k) => k.trim()).filter(Boolean).every((k) => Buffer.from(k, 'base64').length === 32), 'FIELD_ENCRYPTION_KEYS_PREVIOUS must hold 32-byte base64 keys, comma-separated'),
});

export type AppConfig = z.infer<typeof schema> & {
  isProductionLike: boolean;
  corsOrigins: string[];
  /** The field encryption key ring: the current key first, then previous ones (see platform/auth/crypto.ts). */
  fieldKeys: string;
};

let cached: AppConfig | undefined;

/** Loads and validates configuration once. The process refuses to start with missing or weak settings. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  if (parsed.data.AI_PROVIDER === 'anthropic' && !parsed.data.ANTHROPIC_API_KEY) {
    throw new Error('Invalid configuration: AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
  }
  const productionLike = parsed.data.CREW_ENV === 'production' || parsed.data.CREW_ENV === 'staging';
  if (productionLike && (parsed.data.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true' || parsed.data.SLACK_WEBHOOK_BASE_URL)) {
    throw new Error('Invalid configuration: INTEGRATIONS_ALLOW_PRIVATE_URLS and SLACK_WEBHOOK_BASE_URL are for local development and tests only');
  }
  if (productionLike) {
    const problems = productionProblems(parsed.data);
    if (problems.length) throw new Error(`Invalid configuration for ${parsed.data.CREW_ENV}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_PLATFORM_SECRET) {
    throw new Error('Invalid configuration: JWT_ACCESS_SECRET and JWT_PLATFORM_SECRET must differ');
  }
  cached = {
    ...parsed.data,
    isProductionLike: parsed.data.CREW_ENV === 'production' || parsed.data.CREW_ENV === 'staging',
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    fieldKeys: [parsed.data.FIELD_ENCRYPTION_KEY, ...parsed.data.FIELD_ENCRYPTION_KEYS_PREVIOUS.split(',')].map((k) => k.trim()).filter(Boolean).join(','),
  };
  return cached;
}

/** Values copied from the templates that must never reach a real deployment. */
const PLACEHOLDER = /change-?me|example|placeholder|not-secret|local-only|^(.)\1+$/i;

/**
 * Staging and production refuse settings that are fine on a laptop but unsafe on the internet: plain-http addresses
 * (session cookies and tokens would cross the network unencrypted), localhost origins, wildcard CORS, http mobile
 * sign-in return addresses, and secrets still holding a template value.
 */
export function productionProblems(c: z.infer<typeof schema>): string[] {
  const out: string[] = [];
  const https = (name: string, v: string) => {
    let u: URL | undefined;
    try {
      u = new URL(v);
    } catch {
      /* reported below */
    }
    if (!u || u.protocol !== 'https:') out.push(`${name} must be an https:// address (got ${v})`);
  };
  https('WEB_PUBLIC_URL', c.WEB_PUBLIC_URL);
  https('API_PUBLIC_URL', c.API_PUBLIC_URL);
  for (const o of c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (o === '*') out.push('CORS_ORIGINS must list the exact origins, not *');
    else https('CORS_ORIGINS entry', o);
  }
  for (const r of c.MOBILE_SSO_REDIRECTS.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^http:/i.test(r)) out.push(`MOBILE_SSO_REDIRECTS must not contain plain-http addresses (got ${r})`);
  }
  const secrets: Array<[string, string | undefined]> = [
    ['JWT_ACCESS_SECRET', c.JWT_ACCESS_SECRET],
    ['JWT_PLATFORM_SECRET', c.JWT_PLATFORM_SECRET],
    ['FILE_URL_SECRET', c.FILE_URL_SECRET],
  ];
  for (const [name, v] of secrets) if (v && PLACEHOLDER.test(v)) out.push(`${name} still holds a template value; generate one (infra/deploy/gen-secrets.sh)`);
  if (/^0+$|^A+=*$/.test(c.FIELD_ENCRYPTION_KEY)) out.push('FIELD_ENCRYPTION_KEY still holds a template value; generate one (infra/deploy/gen-secrets.sh)');
  try {
    const db = new URL(c.DATABASE_URL);
    if (!db.password || PLACEHOLDER.test(decodeURIComponent(db.password))) out.push('DATABASE_URL needs a real password for the crew_api login');
  } catch {
    out.push('DATABASE_URL is not a valid connection URL');
  }
  if (c.REDIS_URL) {
    try {
      const r = new URL(c.REDIS_URL);
      if (r.password && PLACEHOLDER.test(decodeURIComponent(r.password))) out.push('REDIS_URL still holds a template password');
    } catch {
      out.push('REDIS_URL is not a valid URL');
    }
  }
  return out;
}

export function resetConfigForTests() {
  cached = undefined;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
