import { z } from 'zod';

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
