/**
 * Test configuration. Always targets a dedicated database (never the dev database), even when a developer's
 * shell has .env loaded. Override with TEST_MONGODB_URL (e.g. in CI); the database name must contain "test".
 */
export function applyTestEnv() {
  process.env.CREW_ENV = 'test';
  process.env.MONGODB_URL = process.env.TEST_MONGODB_URL ?? 'mongodb://127.0.0.1:27017/crew_test?replicaSet=rs0';
  // No JWT_* secrets: the API creates its signing keys in the database on its first start, as in production.
  delete process.env.JWT_ACCESS_SECRET;
  delete process.env.JWT_PLATFORM_SECRET;
  // No FIELD_ENCRYPTION_KEY either: the first API start creates the key ring in the (freshly dropped) test database,
  // and every later test file reads it from there, as in one installation.
  delete process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEYS_PREVIOUS;
  process.env.CREW_DISABLE_DISPATCHER = 'true';
  // Integration tests post to receivers on 127.0.0.1; the config refuses this outside development and tests.
  process.env.INTEGRATIONS_ALLOW_PRIVATE_URLS = 'true';
  process.env.STORAGE_DIR ??= './.data/test-files';
  process.env.WEB_PUBLIC_URL ??= 'http://localhost:3000';
}
