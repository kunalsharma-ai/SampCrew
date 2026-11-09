import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../../src/modules/health/health.controller';
import type { AppConfig } from '../../src/platform/config/config';
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

  it('is not ready, and refuses work, when MongoDB is not configured', async () => {
    const mongo = new MongoService({ MONGODB_POOL_MAX: 2 } as AppConfig);
    await expect(new HealthController(mongo).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(mongo.tenant(async () => 1, { tenantId: 'x' })).rejects.toThrow(/not configured/);
  });
});
