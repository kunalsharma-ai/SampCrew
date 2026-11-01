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
  FIELD_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'FIELD_ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
});

export type AppConfig = z.infer<typeof schema> & { isProductionLike: boolean; corsOrigins: string[] };

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
  if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_PLATFORM_SECRET) {
    throw new Error('Invalid configuration: JWT_ACCESS_SECRET and JWT_PLATFORM_SECRET must differ');
  }
  cached = {
    ...parsed.data,
    isProductionLike: parsed.data.CREW_ENV === 'production' || parsed.data.CREW_ENV === 'staging',
    corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
  return cached;
}

export function resetConfigForTests() {
  cached = undefined;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
