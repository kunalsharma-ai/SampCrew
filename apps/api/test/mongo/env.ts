/** Always a dedicated test database (its name must contain "test"), even when a developer's .env is loaded. */
export function applyMongoTestEnv() {
  process.env.CREW_ENV = 'test';
  process.env.MONGODB_URL = process.env.TEST_MONGODB_URL ?? 'mongodb://127.0.0.1:27017/crew_test?replicaSet=rs0';
}
