import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../../src/modules/health/health.controller';
import { loadConfig, resetConfigForTests, type AppConfig } from '../../src/platform/config/config';
import { MongoService } from '../../src/platform/database/mongo.service';
import { mongoService } from './helpers';

describe('Readiness with MongoDB', () => {
  it('is ready when MongoDB answers', async () => {
    const mongo = mongoService();
    try {
      const r = await new HealthController(mongo).ready();
      expect(r.status).toBe('ok');
      expect(r).toHaveProperty('database.latencyMs');
    } finally {
      await mongo.onModuleDestroy();
    }
  });

  it('is not ready when MongoDB cannot be reached', async () => {
    const mongo = new MongoService({ MONGODB_URL: 'mongodb://127.0.0.1:1/crew_test?replicaSet=rs0&serverSelectionTimeoutMS=300', MONGODB_POOL_MAX: 2 } as AppConfig);
    await expect(new HealthController(mongo).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await mongo.onModuleDestroy();
  });

  it('refuses to start without MONGODB_URL, or with a URL that is not MongoDB', () => {
    const env = { JWT_ACCESS_SECRET: 'x'.repeat(32), JWT_PLATFORM_SECRET: 'y'.repeat(32), FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    for (const url of [undefined, 'postgres://crew_api:pw@db:5432/crew']) {
      resetConfigForTests();
      expect(() => loadConfig({ ...env, ...(url ? { MONGODB_URL: url } : {}) } as NodeJS.ProcessEnv)).toThrow(/MONGODB_URL/);
    }
    resetConfigForTests();
  });
});
