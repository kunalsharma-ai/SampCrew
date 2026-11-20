import { z } from 'zod';

/** Treats an empty variable (e.g. `REDIS_URL=` in .env) as unset. */
const optional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const schema = z.object({
  CREW_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  /**
   * MongoDB replica set or Atlas cluster, e.g. mongodb://localhost:27017/crew?replicaSet=rs0 (the path names the
   * database). It must support transactions: a replica set or sharded cluster, never a standalone server.
   */
  MONGODB_URL: z.string().regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URL must start with mongodb:// or mongodb+srv://'),
  MONGODB_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Directory for uploaded files when using the local storage driver. */
  STORAGE_DIR: z.string().default('./.data/files'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  /**
   * The Console's public address, for links in Console emails (a Console admin's password reset). When it is not set,
   * the Console host from CREW_CONSOLE_ADDRESS is used over https, else http://localhost:3001.
   */
  CONSOLE_PUBLIC_URL: optional(z.string().url()),
  CREW_CONSOLE_ADDRESS: optional(z.string().max(253)),
  /** Set to true to stop background loops (outbox, email, daily HR jobs), e.g. in tests. */
  CREW_DISABLE_DISPATCHER: z.enum(['true', 'false']).default('false'),
  /** The Expo push service. Only tests point it elsewhere; push itself is set up in Console > Integrations. */
  EXPO_PUSH_URL: z.string().url().default('https://exp.host/--/api/v2/push/send'),
  /**
   * Let webhooks and connectors call private and local network addresses (and plain http). For local development
   * and tests only; refused in staging and production, where those calls could reach internal services.
   */
  INTEGRATIONS_ALLOW_PRIVATE_URLS: z.enum(['true', 'false']).default('false'),
  /** Tests only: send Slack messages to this base instead of https://hooks.slack.com (refused in staging and production). */
  SLACK_WEBHOOK_BASE_URL: optional(z.string().url()),
  /** Redis for state shared by API servers (rate-limit counters). Needed when running more than one API replica. */
  REDIS_URL: optional(z.string().regex(/^rediss?:\/\//, 'REDIS_URL must start with redis:\/\/ or rediss:\/\/')),
  /**
   * Older releases only: the field encryption key ring now lives in the database (field_keys, created on the first
   * start). While the database has none, these are moved into it once, so values already encrypted stay readable;
   * after that they are ignored and the API asks for the lines to be deleted.
   */
  FIELD_ENCRYPTION_KEY: optional(z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'FIELD_ENCRYPTION_KEY must be 32 bytes, base64 encoded')),
  FIELD_ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .default('')
    .refine((v) => v.split(',').map((k) => k.trim()).filter(Boolean).every((k) => Buffer.from(k, 'base64').length === 32), 'FIELD_ENCRYPTION_KEYS_PREVIOUS must hold 32-byte base64 keys, comma-separated'),
});

export type AppConfig = Omit<z.infer<typeof schema>, 'CONSOLE_PUBLIC_URL'> & {
  /** Always filled in (see the schema). */
  CONSOLE_PUBLIC_URL: string;
  /**
   * The sign-in token signing keys. They are not settings: the API creates them once and keeps them in the database
   * (instance-secrets.ts), and fills them in here before it starts serving.
   */
  JWT_ACCESS_SECRET: string;
  JWT_PLATFORM_SECRET: string;
  instanceSecretsLoaded?: boolean;
  isProductionLike: boolean;
  corsOrigins: string[];
  /**
   * The field encryption key ring: the current key first, then previous ones (see platform/auth/crypto.ts). Read from
   * the database (field_keys) by loadInstanceSecrets() before anything is encrypted; empty until then.
   */
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
  const productionLike = parsed.data.CREW_ENV === 'production' || parsed.data.CREW_ENV === 'staging';
  if (productionLike && (parsed.data.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true' || parsed.data.SLACK_WEBHOOK_BASE_URL)) {
    throw new Error('Invalid configuration: INTEGRATIONS_ALLOW_PRIVATE_URLS and SLACK_WEBHOOK_BASE_URL are for local development and tests only');
  }
  if (productionLike) {
    const problems = productionProblems(parsed.data);
    if (problems.length) throw new Error(`Invalid configuration for ${parsed.data.CREW_ENV}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
  cached = {
    ...parsed.data,
    CONSOLE_PUBLIC_URL: (parsed.data.CONSOLE_PUBLIC_URL ?? (parsed.data.CREW_CONSOLE_ADDRESS ? `https://${parsed.data.CREW_CONSOLE_ADDRESS}` : 'http://localhost:3001')).replace(/\/+$/, ''),
    JWT_ACCESS_SECRET: '',
    JWT_PLATFORM_SECRET: '',
    isProductionLike: parsed.data.CREW_ENV === 'production' || parsed.data.CREW_ENV === 'staging',
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    fieldKeys: '',
  };
  return cached;
}

/** Values copied from the templates that must never reach a real deployment. */
const PLACEHOLDER = /change-?me|example|placeholder|not-secret|local-only|^(.)\1+$/i;

/**
 * Staging and production refuse settings that are fine on a laptop but unsafe on the internet: plain-http addresses
 * (session cookies and tokens would cross the network unencrypted), localhost origins, wildcard CORS and secrets still holding a template value.
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
  if (c.FIELD_ENCRYPTION_KEY && /^0+$|^A+=*$/.test(c.FIELD_ENCRYPTION_KEY)) out.push('FIELD_ENCRYPTION_KEY still holds a template value; delete the line (SampCrew creates its key in the database)');
  try {
    // WHATWG URL cannot parse a mongodb:// URL with several hosts, so read the credentials and options by hand.
    const m = /^mongodb(?:\+srv)?:\/\/(?:([^@/]*)@)?[^/?]*(?:\/[^?]*)?(?:\?(.*))?$/.exec(c.MONGODB_URL);
    if (!m) throw new Error('unparsable');
    const password = m[1]?.includes(':') ? decodeURIComponent(m[1].slice(m[1].indexOf(':') + 1)) : '';
    const mechanism = new URLSearchParams(m[2] ?? '').get('authMechanism') ?? '';
    // X.509 and cloud-identity sign-in carry no password; everything else needs a real one.
    if (!/^MONGODB-(X509|AWS|OIDC)$/i.test(mechanism) && (!password || PLACEHOLDER.test(password))) {
      out.push('MONGODB_URL needs a database user with a real password (or authMechanism=MONGODB-X509, MONGODB-AWS or MONGODB-OIDC)');
    }
  } catch {
    out.push('MONGODB_URL is not a valid connection URL');
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
