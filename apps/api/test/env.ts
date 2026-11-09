import { randomBytes } from 'node:crypto';

/**
 * Test configuration. Always targets a dedicated database (never the dev database), even when a developer's
 * shell has .env loaded. Override with TEST_MONGODB_URL (e.g. in CI); the database name must contain "test".
 */
export function applyTestEnv() {
  process.env.CREW_ENV = 'test';
  process.env.MONGODB_URL = process.env.TEST_MONGODB_URL ?? 'mongodb://127.0.0.1:27017/crew_test?replicaSet=rs0';
  process.env.JWT_ACCESS_SECRET ??= randomBytes(32).toString('base64');
  process.env.JWT_PLATFORM_SECRET ??= randomBytes(32).toString('base64');
  // Fixed across test files (each runs in its own worker), so data one file encrypted can be read by another, as in
  // one installation. A test-only value; key-rotation tests add their own keys.
  process.env.FIELD_ENCRYPTION_KEY ??= Buffer.from('crew-test-only-field-key-32bytes').toString('base64');
  process.env.CREW_DISABLE_DISPATCHER = 'true';
  // Integration tests post to receivers on 127.0.0.1; the config refuses this outside development and tests.
  process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = 'true';
  delete process.env.SMTP_URL; // email.spec.ts starts its own SMTP server
  process.env.STORAGE_DIR ??= './.data/test-files';
  process.env.WEB_PUBLIC_URL ??= 'http://localhost:3000';
}
