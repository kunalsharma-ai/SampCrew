import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * MongoDB tests (the data layer replacing PostgreSQL). They need a MongoDB replica set, not PostgreSQL:
 * TEST_MONGODB_URL, default mongodb://127.0.0.1:27017/crew_test?replicaSet=rs0. See docs/ops/mongodb.md.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/mongo/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['test/mongo/setup-env.ts'],
    globalSetup: ['test/mongo/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
