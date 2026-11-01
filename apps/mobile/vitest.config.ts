import { defineConfig } from 'vitest/config';

// Unit tests cover the app's logic (API client, offline queue), which has no React Native dependencies.
export default defineConfig({ test: { include: ['src/**/*.spec.ts'], environment: 'node' } });
