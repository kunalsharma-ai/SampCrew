import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // MongoDB tests run on their own (vitest.mongo.config.ts): they need MongoDB, not PostgreSQL.
    exclude: ['test/mongo/**', '**/node_modules/**'],
    environment: 'node',
    setupFiles: ['test/setup-env.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
